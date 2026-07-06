//! Native in-process FFmpeg decoder backend (feature `native-ffmpeg`).
//!
//! A second implementation of the media-engine decoder seam
//! ([`FrameSource`](super::video_engine::FrameSource)) that decodes with the
//! vendored libav* libraries directly — no Python/PyAV, no system ffmpeg. The
//! libraries live under `third_party/ffmpeg` (LGPL *shared*, cut from upstream
//! and locally maintained); they are linked via `rusty_ffmpeg` using the
//! `FFMPEG_*` env in `.cargo/config.toml`.
//!
//! It opens a fresh container per call (`probe` / `decode_frame`) keyed by the
//! `video` path the seam hands in — the media engine already caches decoded
//! frames, so there is no persistent per-file state to hold here. Every failure
//! returns `Err`, which the callers (`video_probe` / `video_scrub`) turn into a
//! fallback to the PyAV one-shot path, so enabling the feature never regresses
//! behaviour: a clip the native decoder chokes on still resolves via PyAV.
//!
//! # Safety
//! The body is FFI against libav. Raw pointers are confined to method scope and
//! freed by [`Decoder`]'s `Drop`; nothing is shared across threads (the seam is
//! `Send`, not `Sync`, and a source is only touched from the decode thread).

use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr;

use rusty_ffmpeg::ffi;

use super::video_engine::{FrameSource, VideoMeta};
use super::working_image::{WorkingImage, WorkingSpace};

/// libav's "no timestamp" sentinel (`AV_NOPTS_VALUE`), defined here so we don't
/// depend on the macro surviving into the generated bindings.
const AV_NOPTS_VALUE: i64 = i64::MIN;

/// Upper bound on frames decoded while walking forward from the seek keyframe to
/// the requested timestamp, so a pathological stream can't spin forever.
const MAX_FRAMES_TO_TARGET: u32 = 600;

/// Decode the first (primary) frame of a still-image container to RGBA. This
/// is the decode half of HEIC/AVIF support (`super::heif_decode`): libav's
/// `mov` demuxer reads HEIF containers and the vendored HEVC / AV1 decoders
/// handle the primary image. `max_pixels == 0` disables the size guard.
pub(crate) fn decode_still_rgba(path: &Path, max_pixels: u64) -> Result<image::RgbaImage, String> {
    let mut decoder = Decoder::open(path)?;
    let meta = decoder.probe()?;
    if max_pixels > 0 && u64::from(meta.width) * u64::from(meta.height) > max_pixels {
        return Err(format!(
            "input image too large to decode safely: {} {}x{} exceeds the {} px budget",
            path.display(),
            meta.width,
            meta.height,
            max_pixels
        ));
    }
    decoder.decode_first_frame_rgba()
}

/// Decode the frame nearest `timestamp_sec` of a video into the canonical
/// [`WorkingImage`] surface — the media/colour bridge (Batch 3): a decoded
/// video frame enters the same working space every still image uses, so the
/// grading kernel and any downstream card consume it without a PNG round-trip.
///
/// Video frames are display-referred 8-bit sRGB (no wide-gamut information to
/// preserve and no ICC to carry), so the surface is tagged [`WorkingSpace::Srgb`]
/// — the sRGB down-convert stays deferred to the model/output egress, exactly
/// like a plain sRGB still (`docs/design/colour-pipeline.md`).
pub(crate) fn decode_frame_working(
    video: &Path,
    timestamp_sec: f64,
) -> Result<WorkingImage, String> {
    let mut decoder = Decoder::open(video)?;
    let rgba = decoder.decode_rgba_at(timestamp_sec)?;
    Ok(WorkingImage::from_rgba8(&rgba, WorkingSpace::Srgb, None))
}

/// `width x height` of a still-image container's primary image, from the
/// header only (no pixel decode).
pub(crate) fn probe_still_dims(path: &Path) -> Result<(u32, u32), String> {
    let decoder = Decoder::open(path)?;
    let meta = decoder.probe()?;
    if meta.width == 0 || meta.height == 0 {
        return Err(format!("no image dimensions in {}", path.display()));
    }
    Ok((meta.width, meta.height))
}

/// Native libav-backed [`FrameSource`]. Zero-sized: all state is per-call.
pub(crate) struct NativeFfmpegFrameSource;

impl NativeFfmpegFrameSource {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl FrameSource for NativeFfmpegFrameSource {
    fn probe(&mut self, video: &Path) -> Result<VideoMeta, String> {
        let decoder = Decoder::open(video)?;
        decoder.probe()
    }

    fn decode_frame(
        &mut self,
        video: &Path,
        timestamp_sec: f64,
        poster_out: &Path,
    ) -> Result<PathBuf, String> {
        let mut decoder = Decoder::open(video)?;
        decoder.decode_to_png(timestamp_sec, poster_out)
    }
}

/// Hardware video encoders compiled into the vendored libav, by encoder name
/// (probe only — nothing selects them yet; GPU_DEVICE_STRATEGY_PLAN step 12
/// adds hardware FFmpeg strictly behind an explicit probe/report/fallback).
/// `avcodec_find_encoder_by_name` only reports what was compiled in; whether
/// the driver/device actually accepts a session is still a per-run question,
/// so per-run DeviceReports remain the source of truth.
pub(crate) fn hardware_encoders() -> Vec<String> {
    const CANDIDATES: [&str; 8] = [
        "h264_nvenc",
        "hevc_nvenc",
        "h264_qsv",
        "hevc_qsv",
        "h264_amf",
        "hevc_amf",
        "h264_mf",
        "hevc_mf",
    ];
    CANDIDATES
        .iter()
        .filter(|name| {
            let c = CString::new(**name).expect("static encoder name");
            unsafe { !ffi::avcodec_find_encoder_by_name(c.as_ptr()).is_null() }
        })
        .map(|name| name.to_string())
        .collect()
}

/// Hardware video decoders compiled into the vendored libav, by decoder name
/// (GPU_DEVICE_STRATEGY_PLAN step 12: hardware FFmpeg strictly behind an
/// explicit probe/report/fallback, per operation — an explicit `device: gpu`
/// trim tries the decoder matching the input codec; playback scrubbing stays
/// on the software baseline). `avcodec_find_decoder_by_name` only reports
/// what was compiled in; whether the driver/device actually accepts a
/// session is still a per-run question.
pub(crate) fn hardware_decoders() -> Vec<String> {
    const CANDIDATES: [&str; 6] = [
        "h264_cuvid",
        "hevc_cuvid",
        "av1_cuvid",
        "h264_qsv",
        "hevc_qsv",
        "av1_qsv",
    ];
    CANDIDATES
        .iter()
        .filter(|name| {
            let c = CString::new(**name).expect("static decoder name");
            unsafe { !ffi::avcodec_find_decoder_by_name(c.as_ptr()).is_null() }
        })
        .map(|name| name.to_string())
        .collect()
}

/// The first hardware H.264 encoder compiled into the vendored libav, if any
/// (the encoder an explicit `device: gpu` encode request tries before falling
/// back to the software baseline).
pub(crate) fn hardware_h264_encoder() -> Option<String> {
    hardware_encoders()
        .into_iter()
        .find(|name| name.starts_with("h264_"))
}

/// Encode/trim result mirrored onto the `videoAssemble` / `videoTrim` node
/// reports (the same shape the PyAV worker's payloads carried).
#[derive(Debug, Clone)]
pub(crate) struct VideoEncodeStats {
    pub(crate) frame_count: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fps: Option<f64>,
    pub(crate) duration_sec: Option<f64>,
    pub(crate) codec: String,
    pub(crate) start_sec: Option<f64>,
    pub(crate) end_sec: Option<f64>,
}

/// Encode an ordered image sequence into a video at `out` (the native
/// `videoAssemble` path). The first frame fixes the (even) output size;
/// later frames are resized to it, mirroring the PyAV worker's `assemble`.
pub(crate) fn assemble_frames(
    frames: &[String],
    out: &Path,
    fps: f64,
    codec: &str,
) -> Result<VideoEncodeStats, String> {
    if frames.is_empty() {
        return Err("no frames to assemble".to_string());
    }
    let mut encoder: Option<Encoder> = None;
    let (mut width, mut height) = (0u32, 0u32);
    let mut count: u64 = 0;
    for path in frames {
        let image = image::open(path)
            .map_err(|err| format!("failed to read frame {path}: {err}"))?
            .to_rgba8();
        if encoder.is_none() {
            width = (image.width() - image.width() % 2).max(2);
            height = (image.height() - image.height() % 2).max(2);
            encoder = Some(Encoder::open(out, width, height, fps, codec)?);
        }
        let image = if (image.width(), image.height()) != (width, height) {
            image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle)
        } else {
            image
        };
        encoder
            .as_mut()
            .expect("encoder initialised with the first frame")
            .write_rgba(&image)?;
        count += 1;
    }
    encoder.expect("at least one frame was encoded").finish()?;
    Ok(VideoEncodeStats {
        frame_count: count,
        width,
        height,
        fps: Some(fps),
        duration_sec: if fps > 0.0 {
            Some(count as f64 / fps)
        } else {
            None
        },
        codec: codec.to_string(),
        start_sec: None,
        end_sec: None,
    })
}

/// The input video's codec name (e.g. `h264`), for picking a matching
/// hardware decoder before a decode-and-re-encode run.
pub(crate) fn probe_input_codec(video: &Path) -> Result<String, String> {
    let decoder = Decoder::open(video)?;
    let meta = decoder.probe()?;
    meta.codec
        .ok_or_else(|| "input video codec could not be identified".to_string())
}

/// Cut `[start_sec, end_sec)` out of `video` into `out` (the native
/// `videoTrim` path). Decode-and-re-encode so the cut is frame-accurate
/// rather than snapping to keyframes; audio is not carried over, mirroring
/// the PyAV worker's `trim`. `decoder_name` selects a specific (hardware)
/// decoder for the input; `None` uses the stream's default software decoder.
pub(crate) fn trim_video(
    video: &Path,
    out: &Path,
    start_sec: f64,
    end_sec: Option<f64>,
    codec: &str,
    decoder_name: Option<&str>,
) -> Result<VideoEncodeStats, String> {
    let mut decoder = Decoder::open_with(video, decoder_name)?;
    let meta = decoder.probe()?;
    let fps = meta.fps.filter(|f| *f > 0.0).unwrap_or(30.0);
    let width = (meta.width - meta.width % 2).max(2);
    let height = (meta.height - meta.height % 2).max(2);
    let mut encoder = Encoder::open(out, width, height, fps, codec)?;

    let mut count: u64 = 0;
    let mut first_ts: Option<f64> = None;
    let mut last_ts: Option<f64> = None;
    decoder.for_each_frame_from(start_sec, |ts, frame| {
        if ts + 1e-9 < start_sec {
            return Ok(true); // still walking up from the seek keyframe
        }
        if let Some(end) = end_sec {
            if ts >= end {
                return Ok(false);
            }
        }
        let frame = if (frame.width(), frame.height()) != (width, height) {
            image::imageops::resize(&frame, width, height, image::imageops::FilterType::Triangle)
        } else {
            frame
        };
        encoder.write_rgba(&frame)?;
        count += 1;
        first_ts.get_or_insert(ts);
        last_ts = Some(ts);
        Ok(true)
    })?;
    if count == 0 {
        return Err(format!(
            "no frames in the requested range ({start_sec}s..{})",
            end_sec.map_or_else(|| "end".to_string(), |end| format!("{end}s"))
        ));
    }
    encoder.finish()?;
    Ok(VideoEncodeStats {
        frame_count: count,
        width,
        height,
        fps: Some(fps),
        duration_sec: Some(count as f64 / fps),
        codec: codec.to_string(),
        start_sec: first_ts,
        end_sec: last_ts,
    })
}

/// An open input container + its selected video decode context. Owns the raw
/// libav pointers and frees them on drop.
struct Decoder {
    fmt: *mut ffi::AVFormatContext,
    codec_ctx: *mut ffi::AVCodecContext,
    stream_index: i32,
    time_base: ffi::AVRational,
    avg_frame_rate: ffi::AVRational,
}

impl Decoder {
    fn open(video: &Path) -> Result<Self, String> {
        Self::open_with(video, None)
    }

    /// Open with a specific decoder by name (e.g. a hardware decoder such as
    /// `h264_cuvid`) instead of the stream's default software decoder. The
    /// named decoder must match the stream's codec.
    fn open_with(video: &Path, decoder_name: Option<&str>) -> Result<Self, String> {
        let path = CString::new(video.to_string_lossy().as_bytes())
            .map_err(|_| "video path contains a NUL byte".to_string())?;
        unsafe {
            let mut fmt: *mut ffi::AVFormatContext = ptr::null_mut();
            let ret =
                ffi::avformat_open_input(&mut fmt, path.as_ptr(), ptr::null_mut(), ptr::null_mut());
            if ret < 0 {
                return Err(format!("avformat_open_input failed ({ret})"));
            }
            if ffi::avformat_find_stream_info(fmt, ptr::null_mut()) < 0 {
                ffi::avformat_close_input(&mut fmt);
                return Err("avformat_find_stream_info failed".to_string());
            }

            let mut decoder: *const ffi::AVCodec = ptr::null();
            let stream_index =
                ffi::av_find_best_stream(fmt, ffi::AVMEDIA_TYPE_VIDEO, -1, -1, &mut decoder, 0);
            if stream_index < 0 || decoder.is_null() {
                ffi::avformat_close_input(&mut fmt);
                return Err("no decodable video stream found".to_string());
            }

            let stream = *(*fmt).streams.add(stream_index as usize);
            let codecpar = (*stream).codecpar;
            if let Some(name) = decoder_name {
                let c = CString::new(name)
                    .map_err(|_| "decoder name contains a NUL byte".to_string())?;
                let named = ffi::avcodec_find_decoder_by_name(c.as_ptr());
                if named.is_null() {
                    ffi::avformat_close_input(&mut fmt);
                    return Err(format!("decoder '{name}' is not compiled in"));
                }
                if (*named).id != (*codecpar).codec_id {
                    ffi::avformat_close_input(&mut fmt);
                    return Err(format!("decoder '{name}' does not match the input codec"));
                }
                decoder = named;
            }
            let codec_ctx = ffi::avcodec_alloc_context3(decoder);
            if codec_ctx.is_null() {
                ffi::avformat_close_input(&mut fmt);
                return Err("avcodec_alloc_context3 failed".to_string());
            }
            let mut this = Decoder {
                fmt,
                codec_ctx,
                stream_index,
                time_base: (*stream).time_base,
                avg_frame_rate: (*stream).avg_frame_rate,
            };
            if ffi::avcodec_parameters_to_context(codec_ctx, codecpar) < 0 {
                return Err("avcodec_parameters_to_context failed".to_string());
            }
            if ffi::avcodec_open2(codec_ctx, decoder, ptr::null_mut()) < 0 {
                return Err("avcodec_open2 failed".to_string());
            }
            // Take ownership out of the temporary so its Drop doesn't run early.
            this.fmt = fmt;
            Ok(this)
        }
    }

    fn probe(&self) -> Result<VideoMeta, String> {
        unsafe {
            let width = (*self.codec_ctx).width.max(0) as u32;
            let height = (*self.codec_ctx).height.max(0) as u32;

            let raw_duration = (*self.fmt).duration;
            let duration_sec = if raw_duration != AV_NOPTS_VALUE && raw_duration > 0 {
                Some(raw_duration as f64 / ffi::AV_TIME_BASE as f64)
            } else {
                None
            };

            let fps = {
                let r = self.avg_frame_rate;
                if r.num > 0 && r.den > 0 {
                    Some(r.num as f64 / r.den as f64)
                } else {
                    None
                }
            };

            let codec = {
                let name = ffi::avcodec_get_name((*self.codec_ctx).codec_id);
                if name.is_null() {
                    None
                } else {
                    Some(CStr::from_ptr(name).to_string_lossy().into_owned())
                }
            };

            Ok(VideoMeta {
                width,
                height,
                duration_sec,
                fps,
                codec,
            })
        }
    }

    /// Decode the container's first frame and return it as RGBA (the
    /// still-image path: no seek, no timestamp walk).
    fn decode_first_frame_rgba(&mut self) -> Result<image::RgbaImage, String> {
        unsafe {
            let packet = ffi::av_packet_alloc();
            let frame = ffi::av_frame_alloc();
            if packet.is_null() || frame.is_null() {
                if !packet.is_null() {
                    let mut p = packet;
                    ffi::av_packet_free(&mut p);
                }
                if !frame.is_null() {
                    let mut f = frame;
                    ffi::av_frame_free(&mut f);
                }
                return Err("failed to allocate libav packet/frame".to_string());
            }

            let mut got = false;
            while ffi::av_read_frame(self.fmt, packet) >= 0 {
                if (*packet).stream_index == self.stream_index
                    && ffi::avcodec_send_packet(self.codec_ctx, packet) >= 0
                    && ffi::avcodec_receive_frame(self.codec_ctx, frame) >= 0
                {
                    got = true;
                }
                ffi::av_packet_unref(packet);
                if got {
                    break;
                }
            }
            if !got {
                // Flush: some codecs only emit after EOF.
                ffi::avcodec_send_packet(self.codec_ctx, ptr::null());
                got = ffi::avcodec_receive_frame(self.codec_ctx, frame) >= 0;
            }

            let result = if got {
                self.frame_to_rgba(frame)
            } else {
                Err("no image frame decoded".to_string())
            };

            let mut p = packet;
            ffi::av_packet_free(&mut p);
            let mut f = frame;
            ffi::av_frame_free(&mut f);
            result
        }
    }

    fn decode_to_png(&mut self, timestamp_sec: f64, poster_out: &Path) -> Result<PathBuf, String> {
        let image = self.decode_rgba_at(timestamp_sec)?;
        image
            .save(poster_out)
            .map_err(|err| format!("failed to write poster {}: {err}", poster_out.display()))?;
        Ok(poster_out.to_path_buf())
    }

    /// Seek to the keyframe at or before `timestamp_sec`, decode forward to the
    /// frame at or past it, and return it as an RGBA surface. Shared by the
    /// PNG poster path ([`decode_to_png`](Self::decode_to_png)) and the
    /// [`WorkingImage`] media/colour bridge ([`decode_frame_working`]).
    fn decode_rgba_at(&mut self, timestamp_sec: f64) -> Result<image::RgbaImage, String> {
        unsafe {
            // Target timestamp in the stream's time base: ts / (num/den).
            let q = self.time_base;
            let target_ts = if q.num > 0 && q.den > 0 {
                (timestamp_sec * q.den as f64 / q.num as f64).round() as i64
            } else {
                0
            };

            if timestamp_sec > 0.0 {
                // Seek to the keyframe at or before the target, then decode
                // forward. Best-effort: a seek failure just decodes from where
                // we are.
                let _ = ffi::av_seek_frame(
                    self.fmt,
                    self.stream_index,
                    target_ts,
                    ffi::AVSEEK_FLAG_BACKWARD as i32,
                );
                ffi::avcodec_flush_buffers(self.codec_ctx);
            }

            let packet = ffi::av_packet_alloc();
            let frame = ffi::av_frame_alloc();
            if packet.is_null() || frame.is_null() {
                if !packet.is_null() {
                    let mut p = packet;
                    ffi::av_packet_free(&mut p);
                }
                if !frame.is_null() {
                    let mut f = frame;
                    ffi::av_frame_free(&mut f);
                }
                return Err("failed to allocate libav packet/frame".to_string());
            }

            let mut got = false;
            let mut walked: u32 = 0;
            while ffi::av_read_frame(self.fmt, packet) >= 0 {
                if (*packet).stream_index == self.stream_index
                    && ffi::avcodec_send_packet(self.codec_ctx, packet) >= 0
                {
                    loop {
                        let r = ffi::avcodec_receive_frame(self.codec_ctx, frame);
                        if r < 0 {
                            break; // EAGAIN (need more packets) or EOF
                        }
                        let pts = {
                            let best = (*frame).best_effort_timestamp;
                            if best != AV_NOPTS_VALUE {
                                best
                            } else {
                                (*frame).pts
                            }
                        };
                        walked += 1;
                        if pts >= target_ts || walked >= MAX_FRAMES_TO_TARGET {
                            got = true;
                            break;
                        }
                    }
                }
                ffi::av_packet_unref(packet);
                if got {
                    break;
                }
            }

            // Flush the decoder if EOF arrived before we produced a frame.
            if !got {
                ffi::avcodec_send_packet(self.codec_ctx, ptr::null());
                if ffi::avcodec_receive_frame(self.codec_ctx, frame) >= 0 {
                    got = true;
                }
            }

            let result = if got {
                self.frame_to_rgba(frame)
            } else {
                Err("no frame decoded at the requested timestamp".to_string())
            };

            let mut p = packet;
            ffi::av_packet_free(&mut p);
            let mut f = frame;
            ffi::av_frame_free(&mut f);
            result
        }
    }

    /// Convert a decoded frame to an RGBA surface via swscale.
    unsafe fn frame_to_rgba(&self, frame: *mut ffi::AVFrame) -> Result<image::RgbaImage, String> {
        let width = (*frame).width;
        let height = (*frame).height;
        if width <= 0 || height <= 0 {
            return Err("decoded frame has non-positive dimensions".to_string());
        }

        let sws = ffi::sws_getContext(
            width,
            height,
            (*frame).format,
            width,
            height,
            ffi::AV_PIX_FMT_RGBA,
            ffi::SWS_BILINEAR as i32,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if sws.is_null() {
            return Err("sws_getContext failed".to_string());
        }

        let stride = width * 4;
        let mut buffer = vec![0u8; (stride * height) as usize];
        let dst_data: [*mut u8; 4] = [
            buffer.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        ];
        let dst_stride: [i32; 4] = [stride, 0, 0, 0];

        let scaled = ffi::sws_scale(
            sws,
            (*frame).data.as_ptr() as *const *const u8,
            (*frame).linesize.as_ptr(),
            0,
            height,
            dst_data.as_ptr(),
            dst_stride.as_ptr(),
        );
        ffi::sws_freeContext(sws);
        if scaled <= 0 {
            return Err("sws_scale produced no output".to_string());
        }

        image::RgbaImage::from_raw(width as u32, height as u32, buffer)
            .ok_or_else(|| "RGBA buffer did not match frame dimensions".to_string())
    }

    /// Seek to the keyframe at or before `start_sec`, then decode forward,
    /// handing every frame (as RGBA + timestamp seconds) to `f`. `f` returns
    /// `Ok(true)` to keep going, `Ok(false)` to stop.
    fn for_each_frame_from(
        &mut self,
        start_sec: f64,
        mut f: impl FnMut(f64, image::RgbaImage) -> Result<bool, String>,
    ) -> Result<(), String> {
        unsafe {
            let q = self.time_base;
            let ts_to_sec = |ts: i64| -> f64 {
                if q.den > 0 {
                    ts as f64 * q.num as f64 / q.den as f64
                } else {
                    0.0
                }
            };
            if start_sec > 0.0 && q.num > 0 && q.den > 0 {
                let target_ts = (start_sec * q.den as f64 / q.num as f64).round() as i64;
                let _ = ffi::av_seek_frame(
                    self.fmt,
                    self.stream_index,
                    target_ts,
                    ffi::AVSEEK_FLAG_BACKWARD as i32,
                );
                ffi::avcodec_flush_buffers(self.codec_ctx);
            }

            let packet = ffi::av_packet_alloc();
            let frame = ffi::av_frame_alloc();
            if packet.is_null() || frame.is_null() {
                if !packet.is_null() {
                    let mut p = packet;
                    ffi::av_packet_free(&mut p);
                }
                if !frame.is_null() {
                    let mut fr = frame;
                    ffi::av_frame_free(&mut fr);
                }
                return Err("failed to allocate libav packet/frame".to_string());
            }

            let mut result: Result<(), String> = Ok(());
            let mut stop = false;
            'read: while ffi::av_read_frame(self.fmt, packet) >= 0 {
                if (*packet).stream_index == self.stream_index
                    && ffi::avcodec_send_packet(self.codec_ctx, packet) >= 0
                {
                    while ffi::avcodec_receive_frame(self.codec_ctx, frame) >= 0 {
                        let pts = {
                            let best = (*frame).best_effort_timestamp;
                            if best != AV_NOPTS_VALUE {
                                best
                            } else {
                                (*frame).pts
                            }
                        };
                        let ts = if pts != AV_NOPTS_VALUE {
                            ts_to_sec(pts)
                        } else {
                            0.0
                        };
                        match self.frame_to_rgba(frame).and_then(|img| f(ts, img)) {
                            Ok(true) => {}
                            Ok(false) => {
                                stop = true;
                                ffi::av_packet_unref(packet);
                                break 'read;
                            }
                            Err(err) => {
                                result = Err(err);
                                ffi::av_packet_unref(packet);
                                break 'read;
                            }
                        }
                    }
                }
                ffi::av_packet_unref(packet);
            }

            // Drain the decoder unless the caller stopped or errored out.
            if result.is_ok() && !stop {
                ffi::avcodec_send_packet(self.codec_ctx, ptr::null());
                while ffi::avcodec_receive_frame(self.codec_ctx, frame) >= 0 {
                    let pts = {
                        let best = (*frame).best_effort_timestamp;
                        if best != AV_NOPTS_VALUE {
                            best
                        } else {
                            (*frame).pts
                        }
                    };
                    let ts = if pts != AV_NOPTS_VALUE {
                        ts_to_sec(pts)
                    } else {
                        0.0
                    };
                    match self.frame_to_rgba(frame).and_then(|img| f(ts, img)) {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(err) => {
                            result = Err(err);
                            break;
                        }
                    }
                }
            }

            let mut p = packet;
            ffi::av_packet_free(&mut p);
            let mut fr = frame;
            ffi::av_frame_free(&mut fr);
            result
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.codec_ctx.is_null() {
                ffi::avcodec_free_context(&mut self.codec_ctx);
            }
            if !self.fmt.is_null() {
                ffi::avformat_close_input(&mut self.fmt);
            }
        }
    }
}

/// An open output container + H.264 encode context. Frames go in as RGBA
/// (swscaled to yuv420p), packets come out interleaved into the container.
/// Owns the raw libav pointers and frees them on drop; `finish` must be
/// called to flush the encoder and write the trailer.
struct Encoder {
    fmt: *mut ffi::AVFormatContext,
    codec_ctx: *mut ffi::AVCodecContext,
    stream: *mut ffi::AVStream,
    frame: *mut ffi::AVFrame,
    packet: *mut ffi::AVPacket,
    sws: *mut ffi::SwsContext,
    width: u32,
    height: u32,
    next_pts: i64,
    io_open: bool,
}

impl Encoder {
    fn open(out: &Path, width: u32, height: u32, fps: f64, codec: &str) -> Result<Self, String> {
        let h264_names = ["h264", "libx264", "libopenh264", "openh264"];
        let hw_h264_names = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];
        let is_hw = hw_h264_names.iter().any(|n| codec.eq_ignore_ascii_case(n));
        if !is_hw && !h264_names.iter().any(|n| codec.eq_ignore_ascii_case(n)) {
            return Err(format!(
                "unsupported codec '{codec}': the native encoder ships H.264 only"
            ));
        }
        let codec_name = CString::new(codec.to_ascii_lowercase())
            .map_err(|_| "codec name contains a NUL byte".to_string())?;
        let path = CString::new(out.to_string_lossy().as_bytes())
            .map_err(|_| "output path contains a NUL byte".to_string())?;
        unsafe {
            let mut fmt: *mut ffi::AVFormatContext = ptr::null_mut();
            if ffi::avformat_alloc_output_context2(
                &mut fmt,
                ptr::null_mut(),
                ptr::null(),
                path.as_ptr(),
            ) < 0
                || fmt.is_null()
            {
                return Err("avformat_alloc_output_context2 failed".to_string());
            }
            let mut this = Encoder {
                fmt,
                codec_ctx: ptr::null_mut(),
                stream: ptr::null_mut(),
                frame: ptr::null_mut(),
                packet: ptr::null_mut(),
                sws: ptr::null_mut(),
                width,
                height,
                next_pts: 0,
                io_open: false,
            };

            let mut encoder = ffi::avcodec_find_encoder_by_name(codec_name.as_ptr());
            if encoder.is_null() {
                // A hardware encoder must be exactly what was asked for — the
                // caller owns the software fallback (and its visible reason).
                if is_hw {
                    return Err(format!(
                        "hardware encoder '{codec}' is not compiled into the vendored libav"
                    ));
                }
                encoder = ffi::avcodec_find_encoder(ffi::AV_CODEC_ID_H264);
            }
            if encoder.is_null() {
                return Err("no H.264 encoder available in the vendored libav".to_string());
            }

            let codec_ctx = ffi::avcodec_alloc_context3(encoder);
            if codec_ctx.is_null() {
                return Err("avcodec_alloc_context3 (encoder) failed".to_string());
            }
            this.codec_ctx = codec_ctx;

            let fps_q = ffi::av_d2q(fps.max(1.0), 1_000_000);
            (*codec_ctx).width = width as i32;
            (*codec_ctx).height = height as i32;
            (*codec_ctx).pix_fmt = ffi::AV_PIX_FMT_YUV420P;
            (*codec_ctx).time_base = ffi::AVRational {
                num: fps_q.den,
                den: fps_q.num,
            };
            (*codec_ctx).framerate = fps_q;
            (*codec_ctx).gop_size = 12;
            if !(*fmt).oformat.is_null()
                && ((*(*fmt).oformat).flags as u32) & ffi::AVFMT_GLOBALHEADER != 0
            {
                (*codec_ctx).flags |= ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            }

            if ffi::avcodec_open2(codec_ctx, encoder, ptr::null_mut()) < 0 {
                return Err("avcodec_open2 (encoder) failed".to_string());
            }

            let stream = ffi::avformat_new_stream(fmt, ptr::null());
            if stream.is_null() {
                return Err("avformat_new_stream failed".to_string());
            }
            this.stream = stream;
            (*stream).time_base = (*codec_ctx).time_base;
            if ffi::avcodec_parameters_from_context((*stream).codecpar, codec_ctx) < 0 {
                return Err("avcodec_parameters_from_context failed".to_string());
            }

            if ((*(*fmt).oformat).flags as u32) & ffi::AVFMT_NOFILE == 0 {
                if ffi::avio_open(&mut (*fmt).pb, path.as_ptr(), ffi::AVIO_FLAG_WRITE as i32) < 0 {
                    return Err(format!("failed to open output file {}", out.display()));
                }
                this.io_open = true;
            }
            if ffi::avformat_write_header(fmt, ptr::null_mut()) < 0 {
                return Err("avformat_write_header failed".to_string());
            }

            this.frame = ffi::av_frame_alloc();
            this.packet = ffi::av_packet_alloc();
            if this.frame.is_null() || this.packet.is_null() {
                return Err("failed to allocate libav packet/frame".to_string());
            }
            (*this.frame).format = ffi::AV_PIX_FMT_YUV420P;
            (*this.frame).width = width as i32;
            (*this.frame).height = height as i32;
            if ffi::av_frame_get_buffer(this.frame, 0) < 0 {
                return Err("av_frame_get_buffer failed".to_string());
            }

            this.sws = ffi::sws_getContext(
                width as i32,
                height as i32,
                ffi::AV_PIX_FMT_RGBA,
                width as i32,
                height as i32,
                ffi::AV_PIX_FMT_YUV420P,
                ffi::SWS_BILINEAR as i32,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            if this.sws.is_null() {
                return Err("sws_getContext (encode) failed".to_string());
            }

            Ok(this)
        }
    }

    fn write_rgba(&mut self, image: &image::RgbaImage) -> Result<(), String> {
        if (image.width(), image.height()) != (self.width, self.height) {
            return Err("frame size does not match the encoder".to_string());
        }
        unsafe {
            if ffi::av_frame_make_writable(self.frame) < 0 {
                return Err("av_frame_make_writable failed".to_string());
            }
            let src_data: [*const u8; 4] = [
                image.as_raw().as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
            ];
            let src_stride: [i32; 4] = [(self.width * 4) as i32, 0, 0, 0];
            let scaled = ffi::sws_scale(
                self.sws,
                src_data.as_ptr(),
                src_stride.as_ptr(),
                0,
                self.height as i32,
                (*self.frame).data.as_ptr(),
                (*self.frame).linesize.as_ptr(),
            );
            if scaled <= 0 {
                return Err("sws_scale (encode) produced no output".to_string());
            }
            (*self.frame).pts = self.next_pts;
            self.next_pts += 1;
            self.send(self.frame)
        }
    }

    /// Send a frame (or null to flush) and drain any ready packets.
    unsafe fn send(&mut self, frame: *mut ffi::AVFrame) -> Result<(), String> {
        if ffi::avcodec_send_frame(self.codec_ctx, frame) < 0 {
            return Err("avcodec_send_frame failed".to_string());
        }
        while ffi::avcodec_receive_packet(self.codec_ctx, self.packet) >= 0 {
            ffi::av_packet_rescale_ts(
                self.packet,
                (*self.codec_ctx).time_base,
                (*self.stream).time_base,
            );
            (*self.packet).stream_index = (*self.stream).index;
            let ret = ffi::av_interleaved_write_frame(self.fmt, self.packet);
            ffi::av_packet_unref(self.packet);
            if ret < 0 {
                return Err(format!("av_interleaved_write_frame failed ({ret})"));
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        unsafe {
            self.send(ptr::null_mut())?;
            if ffi::av_write_trailer(self.fmt) < 0 {
                return Err("av_write_trailer failed".to_string());
            }
        }
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            if !self.sws.is_null() {
                ffi::sws_freeContext(self.sws);
            }
            if !self.packet.is_null() {
                ffi::av_packet_free(&mut self.packet);
            }
            if !self.frame.is_null() {
                ffi::av_frame_free(&mut self.frame);
            }
            if !self.codec_ctx.is_null() {
                ffi::avcodec_free_context(&mut self.codec_ctx);
            }
            if !self.fmt.is_null() {
                if self.io_open {
                    ffi::avio_closep(&mut (*self.fmt).pb);
                }
                ffi::avformat_free_context(self.fmt);
                self.fmt = ptr::null_mut();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the full link + runtime-DLL-load chain: constructing the
    /// source and probing a missing file must return `Err` (from
    /// `avformat_open_input`) rather than panic or fail to link. This is the
    /// smoke test that the vendored libraries load on CI.
    #[test]
    fn probe_missing_file_errors_cleanly() {
        let mut source = NativeFfmpegFrameSource::new();
        let result = source.probe(Path::new("definitely_not_a_real_clip_zzx.mp4"));
        assert!(result.is_err());
    }

    #[test]
    fn decode_missing_file_errors_cleanly() {
        let mut source = NativeFfmpegFrameSource::new();
        let out = std::env::temp_dir().join("hgripe_native_ffmpeg_probe_test.png");
        let result =
            source.decode_frame(Path::new("definitely_not_a_real_clip_zzx.mp4"), 0.0, &out);
        assert!(result.is_err());
    }

    #[test]
    fn assemble_rejects_unknown_codec() {
        let dir = std::env::temp_dir();
        let frame = dir.join("hgripe_native_ffmpeg_codec_test_frame.png");
        image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]))
            .save(&frame)
            .unwrap();
        let out = dir.join("hgripe_native_ffmpeg_codec_test.mp4");
        let err =
            assemble_frames(&[frame.to_string_lossy().to_string()], &out, 24.0, "vp9").unwrap_err();
        assert!(err.contains("unsupported codec"), "{err}");
        let _ = std::fs::remove_file(&frame);
    }

    /// Round trip through the native encoder + decoder: assemble a few solid
    /// frames into an mp4, then trim it and re-probe both outputs. Exercises
    /// the whole encode chain (H.264 open, swscale RGBA->yuv420p, mux, trailer)
    /// against the vendored libav on CI.
    #[test]
    fn assemble_then_trim_round_trips() {
        let dir = std::env::temp_dir();
        let mut frames = Vec::new();
        for i in 0..12u8 {
            let path = dir.join(format!("hgripe_native_enc_frame_{i}.png"));
            let img = image::RgbaImage::from_pixel(64, 48, image::Rgba([i * 20, 60, 200, 255]));
            img.save(&path).unwrap();
            frames.push(path.to_string_lossy().to_string());
        }
        let clip = dir.join("hgripe_native_enc_test.mp4");
        let stats = assemble_frames(&frames, &clip, 6.0, "libx264").unwrap();
        assert_eq!(stats.frame_count, 12);
        assert_eq!((stats.width, stats.height), (64, 48));

        let mut source = NativeFfmpegFrameSource::new();
        let meta = source.probe(&clip).unwrap();
        assert_eq!((meta.width, meta.height), (64, 48));

        let cut = dir.join("hgripe_native_trim_test.mp4");
        let trimmed = trim_video(&clip, &cut, 0.5, Some(1.5), "h264").unwrap();
        assert!(
            trimmed.frame_count >= 5 && trimmed.frame_count <= 7,
            "{trimmed:?}"
        );
        assert!(source.probe(&cut).is_ok());

        for frame in &frames {
            let _ = std::fs::remove_file(frame);
        }
        let _ = std::fs::remove_file(&clip);
        let _ = std::fs::remove_file(&cut);
    }

    /// The media/colour bridge: a decoded video frame lands in the canonical
    /// `WorkingImage` surface, sized to the clip and tagged `Srgb` (video is
    /// display-referred 8-bit, no wide-gamut/ICC), and its sRGB egress matches
    /// the PNG poster path byte-for-byte — same pixels, no round-trip drift.
    #[test]
    fn decode_frame_working_matches_poster_and_is_srgb() {
        let dir = std::env::temp_dir();
        let mut frames = Vec::new();
        for i in 0..8u8 {
            let path = dir.join(format!("hgripe_native_working_frame_{i}.png"));
            image::RgbaImage::from_pixel(48, 32, image::Rgba([20 + i * 10, 90, 180, 255]))
                .save(&path)
                .unwrap();
            frames.push(path.to_string_lossy().to_string());
        }
        let clip = dir.join("hgripe_native_working_test.mp4");
        assemble_frames(&frames, &clip, 6.0, "libx264").unwrap();

        let working = decode_frame_working(&clip, 0.3).unwrap();
        assert_eq!((working.width, working.height), (48, 32));
        assert_eq!(working.space, WorkingSpace::Srgb);
        assert!(working.icc.is_none());
        assert_eq!(working.pixels.len(), 48 * 32 * 4);

        // The sRGB egress of the WorkingImage is byte-identical to decoding the
        // same frame straight to a poster PNG — the bridge adds no drift.
        let mut source = NativeFfmpegFrameSource::new();
        let poster = dir.join("hgripe_native_working_poster.png");
        let written = source.decode_frame(&clip, 0.3, &poster).unwrap();
        let poster_rgba = image::open(&written).unwrap().to_rgba8();
        assert_eq!(working.to_srgb_rgba8(), poster_rgba);

        for frame in &frames {
            let _ = std::fs::remove_file(frame);
        }
        let _ = std::fs::remove_file(&clip);
        let _ = std::fs::remove_file(&poster);
    }
}
