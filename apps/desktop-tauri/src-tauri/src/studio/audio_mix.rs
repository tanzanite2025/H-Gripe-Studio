//! Timeline audio mixdown + mux (UNIFIED_PRODUCTION_DRAWER_PLAN.md follow-up):
//! decode every audio clip's source to a canonical PCM surface (48 kHz stereo
//! interleaved f32), apply the clip's non-destructive edit (source trim, gain,
//! linear fades — the same model `audioEdit.ts` documents), sum the clips at
//! their timeline offsets, and mux the mix as an AAC track into the exported
//! video. The DSP half is pure and unit-tested; the decode/mux half is FFI
//! against the vendored libav (feature `native-ffmpeg`), mirroring
//! `ffmpeg_native.rs`'s ownership rules: raw pointers confined to scope, freed
//! on drop/exit paths, nothing shared across threads.

use serde::Deserialize;

/// Canonical mix surface: 48 kHz stereo interleaved f32.
pub(crate) const MIX_SAMPLE_RATE: u32 = 48_000;
pub(crate) const MIX_CHANNELS: usize = 2;

/// One audio clip of the render plan, as the TS export dialog sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineAudioSegment {
    /// Absolute media path of the clip's source file.
    pub(crate) path: String,
    /// Timeline start, seconds.
    pub(crate) start_sec: f64,
    /// Played length, seconds (the clip's trimmed span).
    pub(crate) duration_sec: f64,
    /// Source in-point, seconds into the media file.
    pub(crate) trim_start_sec: f64,
    /// Clip gain, decibels.
    pub(crate) gain_db: f64,
    /// Linear fade-in length, seconds.
    pub(crate) fade_in_sec: f64,
    /// Linear fade-out length, seconds.
    pub(crate) fade_out_sec: f64,
}

/// Fade envelope (0..1, before gain) at `t_sec` into the played span —
/// the Rust twin of `audioEdit.ts`'s `envelopeAt`.
fn envelope_at(seg: &TimelineAudioSegment, t_sec: f64) -> f64 {
    if t_sec < 0.0 || t_sec > seg.duration_sec {
        return 0.0;
    }
    let mut level = 1.0f64;
    if seg.fade_in_sec > 0.0 {
        level = level.min(t_sec / seg.fade_in_sec);
    }
    if seg.fade_out_sec > 0.0 {
        level = level.min((seg.duration_sec - t_sec) / seg.fade_out_sec);
    }
    level.clamp(0.0, 1.0)
}

/// Sum one decoded clip (`src`, interleaved stereo at [`MIX_SAMPLE_RATE`])
/// into the mix at its timeline offset, applying trim / gain / fades.
pub(crate) fn mix_segment_into(out: &mut [f32], src: &[f32], seg: &TimelineAudioSegment) {
    let rate = MIX_SAMPLE_RATE as f64;
    let gain = 10f64.powf(seg.gain_db / 20.0);
    let out_offset_frames = (seg.start_sec.max(0.0) * rate).round() as usize;
    let src_offset_frames = (seg.trim_start_sec.max(0.0) * rate).round() as usize;
    let want_frames = (seg.duration_sec.max(0.0) * rate).round() as usize;
    let out_frames = out.len() / MIX_CHANNELS;
    let src_frames = src.len() / MIX_CHANNELS;
    for i in 0..want_frames {
        let out_frame = out_offset_frames + i;
        let src_frame = src_offset_frames + i;
        if out_frame >= out_frames || src_frame >= src_frames {
            break;
        }
        let env = envelope_at(seg, i as f64 / rate) * gain;
        for ch in 0..MIX_CHANNELS {
            out[out_frame * MIX_CHANNELS + ch] +=
                (f64::from(src[src_frame * MIX_CHANNELS + ch]) * env) as f32;
        }
    }
}

/// Allocate the mix surface for `total_sec` and sum every (segment, pcm) pair
/// into it, then hard-clip to [-1, 1] (summing clips can exceed full scale).
pub(crate) fn mix_timeline_audio(
    segments: &[(TimelineAudioSegment, Vec<f32>)],
    total_sec: f64,
) -> Vec<f32> {
    let frames = (total_sec.max(0.0) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
    let mut out = vec![0f32; frames * MIX_CHANNELS];
    for (seg, pcm) in segments {
        mix_segment_into(&mut out, pcm, seg);
    }
    for s in &mut out {
        *s = s.clamp(-1.0, 1.0);
    }
    out
}

/// Reduce interleaved stereo PCM (the canonical mix surface) to `bucket_count`
/// per-bucket peak amplitudes in `0..=1` — the audio edit modal's sample
/// waveform. Each bucket is the max `|sample|` over its frame span, across
/// both channels.
pub(crate) fn waveform_peaks_from_interleaved_stereo_pcm(
    pcm: &[f32],
    bucket_count: usize,
) -> Vec<f32> {
    let frames = pcm.len() / MIX_CHANNELS;
    if frames == 0 || bucket_count == 0 {
        return Vec::new();
    }
    let mut peaks = vec![0f32; bucket_count];
    for frame in 0..frames {
        let bucket = (frame * bucket_count / frames).min(bucket_count - 1);
        for ch in 0..MIX_CHANNELS {
            let amplitude = pcm[frame * MIX_CHANNELS + ch].abs().min(1.0);
            if amplitude > peaks[bucket] {
                peaks[bucket] = amplitude;
            }
        }
    }
    peaks
}

#[cfg(feature = "native-ffmpeg")]
pub(crate) use ffi_impl::{decode_audio_pcm, mux_video_with_audio};

#[cfg(feature = "native-ffmpeg")]
mod ffi_impl {
    use std::ffi::CString;
    use std::path::Path;
    use std::ptr;

    use rusty_ffmpeg::ffi;

    use super::{MIX_CHANNELS, MIX_SAMPLE_RATE};

    /// libav's "no timestamp" sentinel (`AV_NOPTS_VALUE`).
    const AV_NOPTS_VALUE: i64 = i64::MIN;

    /// Decode a media file's best audio stream to the canonical mix surface
    /// (48 kHz stereo interleaved f32) via swresample.
    pub(crate) fn decode_audio_pcm(path: &Path) -> Result<Vec<f32>, String> {
        let c_path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "audio path contains a NUL byte".to_string())?;
        unsafe {
            let mut fmt: *mut ffi::AVFormatContext = ptr::null_mut();
            if ffi::avformat_open_input(&mut fmt, c_path.as_ptr(), ptr::null_mut(), ptr::null_mut())
                < 0
            {
                return Err(format!("failed to open {}", path.display()));
            }
            // Everything below funnels through `done` so fmt/codec/swr/frame/
            // packet are freed on every path.
            let result = decode_opened(fmt, path);
            let mut fmt = fmt;
            ffi::avformat_close_input(&mut fmt);
            result
        }
    }

    unsafe fn decode_opened(
        fmt: *mut ffi::AVFormatContext,
        path: &Path,
    ) -> Result<Vec<f32>, String> {
        if ffi::avformat_find_stream_info(fmt, ptr::null_mut()) < 0 {
            return Err("avformat_find_stream_info failed".to_string());
        }
        let mut decoder: *const ffi::AVCodec = ptr::null();
        let stream_index =
            ffi::av_find_best_stream(fmt, ffi::AVMEDIA_TYPE_AUDIO, -1, -1, &mut decoder, 0);
        if stream_index < 0 || decoder.is_null() {
            return Err(format!("no decodable audio stream in {}", path.display()));
        }
        let stream = *(*fmt).streams.add(stream_index as usize);
        let codec_ctx = ffi::avcodec_alloc_context3(decoder);
        if codec_ctx.is_null() {
            return Err("avcodec_alloc_context3 (audio) failed".to_string());
        }
        let result = decode_stream(fmt, codec_ctx, stream, stream_index);
        let mut ctx = codec_ctx;
        ffi::avcodec_free_context(&mut ctx);
        result
    }

    unsafe fn decode_stream(
        fmt: *mut ffi::AVFormatContext,
        codec_ctx: *mut ffi::AVCodecContext,
        stream: *mut ffi::AVStream,
        stream_index: i32,
    ) -> Result<Vec<f32>, String> {
        if ffi::avcodec_parameters_to_context(codec_ctx, (*stream).codecpar) < 0 {
            return Err("avcodec_parameters_to_context (audio) failed".to_string());
        }
        if ffi::avcodec_open2(codec_ctx, (*codec_ctx).codec, ptr::null_mut()) < 0 {
            return Err("avcodec_open2 (audio) failed".to_string());
        }

        let mut out_layout: ffi::AVChannelLayout = std::mem::zeroed();
        ffi::av_channel_layout_default(&mut out_layout, MIX_CHANNELS as i32);
        let mut swr: *mut ffi::SwrContext = ptr::null_mut();
        if ffi::swr_alloc_set_opts2(
            &mut swr,
            &out_layout,
            ffi::AV_SAMPLE_FMT_FLT,
            MIX_SAMPLE_RATE as i32,
            &(*codec_ctx).ch_layout,
            (*codec_ctx).sample_fmt,
            (*codec_ctx).sample_rate,
            0,
            ptr::null_mut(),
        ) < 0
            || swr.is_null()
            || ffi::swr_init(swr) < 0
        {
            if !swr.is_null() {
                ffi::swr_free(&mut swr);
            }
            return Err("swr_init (audio resample) failed".to_string());
        }

        let packet = ffi::av_packet_alloc();
        let frame = ffi::av_frame_alloc();
        let mut pcm: Vec<f32> = Vec::new();
        let mut err: Option<String> = None;
        if packet.is_null() || frame.is_null() {
            err = Some("failed to allocate libav packet/frame".to_string());
        } else {
            let mut convert = |frame: *const ffi::AVFrame| -> Result<(), String> {
                let in_samples = if frame.is_null() {
                    0
                } else {
                    (*frame).nb_samples
                };
                let out_cap = ffi::swr_get_out_samples(swr, in_samples).max(0) as usize + 64;
                let mut buf = vec![0f32; out_cap * MIX_CHANNELS];
                let mut out_ptr = buf.as_mut_ptr().cast::<u8>();
                let got = ffi::swr_convert(
                    swr,
                    &mut out_ptr,
                    out_cap as i32,
                    if frame.is_null() {
                        ptr::null_mut()
                    } else {
                        (*frame).extended_data as *mut *const u8
                    },
                    in_samples,
                );
                if got < 0 {
                    return Err("swr_convert failed".to_string());
                }
                pcm.extend_from_slice(&buf[..got as usize * MIX_CHANNELS]);
                Ok(())
            };

            'read: while ffi::av_read_frame(fmt, packet) >= 0 {
                if (*packet).stream_index == stream_index
                    && ffi::avcodec_send_packet(codec_ctx, packet) >= 0
                {
                    while ffi::avcodec_receive_frame(codec_ctx, frame) >= 0 {
                        if let Err(e) = convert(frame) {
                            err = Some(e);
                            ffi::av_packet_unref(packet);
                            break 'read;
                        }
                    }
                }
                ffi::av_packet_unref(packet);
            }
            if err.is_none() {
                // Drain the decoder, then the resampler.
                ffi::avcodec_send_packet(codec_ctx, ptr::null());
                while ffi::avcodec_receive_frame(codec_ctx, frame) >= 0 {
                    if let Err(e) = convert(frame) {
                        err = Some(e);
                        break;
                    }
                }
                if err.is_none() {
                    if let Err(e) = convert(ptr::null()) {
                        err = Some(e);
                    }
                }
            }
        }

        if !packet.is_null() {
            let mut p = packet;
            ffi::av_packet_free(&mut p);
        }
        if !frame.is_null() {
            let mut f = frame;
            ffi::av_frame_free(&mut f);
        }
        let mut swr = swr;
        ffi::swr_free(&mut swr);
        match err {
            Some(e) => Err(e),
            None if pcm.is_empty() => Err("audio stream decoded no samples".to_string()),
            None => Ok(pcm),
        }
    }

    /// Mux `pcm` (the timeline mix, interleaved stereo at
    /// [`MIX_SAMPLE_RATE`]) as an AAC track alongside `video_in`'s video
    /// stream (stream-copied, no re-encode) into `out`.
    pub(crate) fn mux_video_with_audio(
        video_in: &Path,
        pcm: &[f32],
        out: &Path,
    ) -> Result<(), String> {
        let muxer = Muxer::open(video_in, out)?;
        muxer.run(pcm)
    }

    /// Open input (video to copy) + output (video copy + AAC) containers.
    /// Owns every raw pointer; freed in `Drop`.
    struct Muxer {
        in_fmt: *mut ffi::AVFormatContext,
        out_fmt: *mut ffi::AVFormatContext,
        aac_ctx: *mut ffi::AVCodecContext,
        in_video_index: i32,
        out_video_index: i32,
        out_audio_index: i32,
        io_open: bool,
    }

    impl Muxer {
        fn open(video_in: &Path, out: &Path) -> Result<Self, String> {
            let in_path = CString::new(video_in.to_string_lossy().as_bytes())
                .map_err(|_| "video path contains a NUL byte".to_string())?;
            let out_path = CString::new(out.to_string_lossy().as_bytes())
                .map_err(|_| "output path contains a NUL byte".to_string())?;
            unsafe {
                let mut this = Muxer {
                    in_fmt: ptr::null_mut(),
                    out_fmt: ptr::null_mut(),
                    aac_ctx: ptr::null_mut(),
                    in_video_index: -1,
                    out_video_index: -1,
                    out_audio_index: -1,
                    io_open: false,
                };
                if ffi::avformat_open_input(
                    &mut this.in_fmt,
                    in_path.as_ptr(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                ) < 0
                {
                    return Err(format!("failed to reopen {}", video_in.display()));
                }
                if ffi::avformat_find_stream_info(this.in_fmt, ptr::null_mut()) < 0 {
                    return Err("avformat_find_stream_info (mux) failed".to_string());
                }
                this.in_video_index = ffi::av_find_best_stream(
                    this.in_fmt,
                    ffi::AVMEDIA_TYPE_VIDEO,
                    -1,
                    -1,
                    ptr::null_mut(),
                    0,
                );
                if this.in_video_index < 0 {
                    return Err("no video stream to mux".to_string());
                }

                if ffi::avformat_alloc_output_context2(
                    &mut this.out_fmt,
                    ptr::null_mut(),
                    ptr::null(),
                    out_path.as_ptr(),
                ) < 0
                    || this.out_fmt.is_null()
                {
                    return Err("avformat_alloc_output_context2 (mux) failed".to_string());
                }

                // Video: stream copy.
                let in_stream = *(*this.in_fmt).streams.add(this.in_video_index as usize);
                let v_stream = ffi::avformat_new_stream(this.out_fmt, ptr::null());
                if v_stream.is_null() {
                    return Err("avformat_new_stream (video copy) failed".to_string());
                }
                if ffi::avcodec_parameters_copy((*v_stream).codecpar, (*in_stream).codecpar) < 0 {
                    return Err("avcodec_parameters_copy failed".to_string());
                }
                (*(*v_stream).codecpar).codec_tag = 0;
                this.out_video_index = (*v_stream).index;

                // Audio: AAC encode of the mix.
                let encoder = ffi::avcodec_find_encoder(ffi::AV_CODEC_ID_AAC);
                if encoder.is_null() {
                    return Err("no AAC encoder available in the vendored libav".to_string());
                }
                let aac_ctx = ffi::avcodec_alloc_context3(encoder);
                if aac_ctx.is_null() {
                    return Err("avcodec_alloc_context3 (aac) failed".to_string());
                }
                this.aac_ctx = aac_ctx;
                (*aac_ctx).sample_fmt = ffi::AV_SAMPLE_FMT_FLTP;
                (*aac_ctx).sample_rate = MIX_SAMPLE_RATE as i32;
                ffi::av_channel_layout_default(&mut (*aac_ctx).ch_layout, MIX_CHANNELS as i32);
                (*aac_ctx).time_base = ffi::AVRational {
                    num: 1,
                    den: MIX_SAMPLE_RATE as i32,
                };
                (*aac_ctx).bit_rate = 192_000;
                if !(*this.out_fmt).oformat.is_null()
                    && ((*(*this.out_fmt).oformat).flags as u32) & ffi::AVFMT_GLOBALHEADER != 0
                {
                    (*aac_ctx).flags |= ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
                }
                if ffi::avcodec_open2(aac_ctx, encoder, ptr::null_mut()) < 0 {
                    return Err("avcodec_open2 (aac) failed".to_string());
                }
                let a_stream = ffi::avformat_new_stream(this.out_fmt, ptr::null());
                if a_stream.is_null() {
                    return Err("avformat_new_stream (aac) failed".to_string());
                }
                (*a_stream).time_base = (*aac_ctx).time_base;
                if ffi::avcodec_parameters_from_context((*a_stream).codecpar, aac_ctx) < 0 {
                    return Err("avcodec_parameters_from_context (aac) failed".to_string());
                }
                this.out_audio_index = (*a_stream).index;

                if ((*(*this.out_fmt).oformat).flags as u32) & ffi::AVFMT_NOFILE == 0 {
                    if ffi::avio_open(
                        &mut (*this.out_fmt).pb,
                        out_path.as_ptr(),
                        ffi::AVIO_FLAG_WRITE as i32,
                    ) < 0
                    {
                        return Err(format!("failed to open output file {}", out.display()));
                    }
                    this.io_open = true;
                }
                if ffi::avformat_write_header(this.out_fmt, ptr::null_mut()) < 0 {
                    return Err("avformat_write_header (mux) failed".to_string());
                }
                Ok(this)
            }
        }

        /// Copy the video packets and interleave AAC frames encoded from
        /// `pcm`, keeping the two streams roughly in step so the muxer's
        /// interleave buffer stays bounded.
        fn run(mut self, pcm: &[f32]) -> Result<(), String> {
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
                let result = self.run_inner(pcm, packet, frame);
                let mut p = packet;
                ffi::av_packet_free(&mut p);
                let mut f = frame;
                ffi::av_frame_free(&mut f);
                result
            }
        }

        unsafe fn run_inner(
            &mut self,
            pcm: &[f32],
            packet: *mut ffi::AVPacket,
            frame: *mut ffi::AVFrame,
        ) -> Result<(), String> {
            let frame_size = {
                let fs = (*self.aac_ctx).frame_size;
                if fs > 0 {
                    fs as usize
                } else {
                    1024
                }
            };
            (*frame).format = ffi::AV_SAMPLE_FMT_FLTP;
            (*frame).nb_samples = frame_size as i32;
            ffi::av_channel_layout_default(&mut (*frame).ch_layout, MIX_CHANNELS as i32);
            if ffi::av_frame_get_buffer(frame, 0) < 0 {
                return Err("av_frame_get_buffer (aac) failed".to_string());
            }

            let in_stream = *(*self.in_fmt).streams.add(self.in_video_index as usize);
            let in_tb = (*in_stream).time_base;
            let out_v_stream = *(*self.out_fmt).streams.add(self.out_video_index as usize);
            let mut audio_pos = 0usize; // frames consumed
            let mut next_pts = 0i64;

            // Copy video packets, feeding audio up to each packet's time.
            while ffi::av_read_frame(self.in_fmt, packet) >= 0 {
                if (*packet).stream_index != self.in_video_index {
                    ffi::av_packet_unref(packet);
                    continue;
                }
                let pkt_sec = {
                    let ts = if (*packet).dts != AV_NOPTS_VALUE {
                        (*packet).dts
                    } else {
                        (*packet).pts
                    };
                    if ts != AV_NOPTS_VALUE && in_tb.den > 0 {
                        ts as f64 * f64::from(in_tb.num) / f64::from(in_tb.den)
                    } else {
                        0.0
                    }
                };
                self.write_audio_until(
                    pcm,
                    frame,
                    packet,
                    frame_size,
                    pkt_sec,
                    &mut audio_pos,
                    &mut next_pts,
                )?;
                ffi::av_packet_rescale_ts(packet, in_tb, (*out_v_stream).time_base);
                (*packet).stream_index = self.out_video_index;
                let ret = ffi::av_interleaved_write_frame(self.out_fmt, packet);
                ffi::av_packet_unref(packet);
                if ret < 0 {
                    return Err(format!(
                        "av_interleaved_write_frame (video copy) failed ({ret})"
                    ));
                }
            }
            // Remaining audio, then flush the encoder.
            self.write_audio_until(
                pcm,
                frame,
                packet,
                frame_size,
                f64::INFINITY,
                &mut audio_pos,
                &mut next_pts,
            )?;
            self.send_audio(ptr::null_mut(), packet)?;
            if ffi::av_write_trailer(self.out_fmt) < 0 {
                return Err("av_write_trailer (mux) failed".to_string());
            }
            Ok(())
        }

        /// Encode-and-write AAC frames from `pcm` until the mix cursor
        /// reaches `until_sec` (or the mix runs out).
        #[allow(clippy::too_many_arguments)]
        unsafe fn write_audio_until(
            &mut self,
            pcm: &[f32],
            frame: *mut ffi::AVFrame,
            packet: *mut ffi::AVPacket,
            frame_size: usize,
            until_sec: f64,
            audio_pos: &mut usize,
            next_pts: &mut i64,
        ) -> Result<(), String> {
            let total_frames = pcm.len() / MIX_CHANNELS;
            while *audio_pos < total_frames
                && (*audio_pos as f64) / f64::from(MIX_SAMPLE_RATE) < until_sec
            {
                let take = frame_size.min(total_frames - *audio_pos);
                if ffi::av_frame_make_writable(frame) < 0 {
                    return Err("av_frame_make_writable (aac) failed".to_string());
                }
                (*frame).nb_samples = take as i32;
                for ch in 0..MIX_CHANNELS {
                    let dst = (*frame).extended_data.add(ch).read().cast::<f32>();
                    for i in 0..take {
                        *dst.add(i) = pcm[(*audio_pos + i) * MIX_CHANNELS + ch];
                    }
                }
                (*frame).pts = *next_pts;
                *next_pts += take as i64;
                *audio_pos += take;
                self.send_audio(frame, packet)?;
            }
            Ok(())
        }

        /// Send an audio frame (or null to flush) and drain ready packets.
        unsafe fn send_audio(
            &mut self,
            frame: *mut ffi::AVFrame,
            packet: *mut ffi::AVPacket,
        ) -> Result<(), String> {
            if ffi::avcodec_send_frame(self.aac_ctx, frame) < 0 {
                return Err("avcodec_send_frame (aac) failed".to_string());
            }
            let out_a_stream = *(*self.out_fmt).streams.add(self.out_audio_index as usize);
            while ffi::avcodec_receive_packet(self.aac_ctx, packet) >= 0 {
                ffi::av_packet_rescale_ts(
                    packet,
                    (*self.aac_ctx).time_base,
                    (*out_a_stream).time_base,
                );
                (*packet).stream_index = self.out_audio_index;
                let ret = ffi::av_interleaved_write_frame(self.out_fmt, packet);
                ffi::av_packet_unref(packet);
                if ret < 0 {
                    return Err(format!("av_interleaved_write_frame (aac) failed ({ret})"));
                }
            }
            Ok(())
        }
    }

    impl Drop for Muxer {
        fn drop(&mut self) {
            unsafe {
                if !self.aac_ctx.is_null() {
                    ffi::avcodec_free_context(&mut self.aac_ctx);
                }
                if !self.out_fmt.is_null() {
                    if self.io_open {
                        ffi::avio_closep(&mut (*self.out_fmt).pb);
                    }
                    ffi::avformat_free_context(self.out_fmt);
                    self.out_fmt = ptr::null_mut();
                }
                if !self.in_fmt.is_null() {
                    ffi::avformat_close_input(&mut self.in_fmt);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(overrides: impl FnOnce(&mut TimelineAudioSegment)) -> TimelineAudioSegment {
        let mut s = TimelineAudioSegment {
            path: String::new(),
            start_sec: 0.0,
            duration_sec: 1.0,
            trim_start_sec: 0.0,
            gain_db: 0.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
        };
        overrides(&mut s);
        s
    }

    #[test]
    fn places_a_clip_at_its_timeline_offset_with_source_trim() {
        // Source: 2 s where the first second is 0.0 and the second is 0.5.
        let rate = MIX_SAMPLE_RATE as usize;
        let mut src = vec![0f32; 2 * rate * MIX_CHANNELS];
        for f in rate..2 * rate {
            for ch in 0..MIX_CHANNELS {
                src[f * MIX_CHANNELS + ch] = 0.5;
            }
        }
        // Play the loud second at timeline 1.0 s by trimming the quiet one off.
        let s = seg(|s| {
            s.start_sec = 1.0;
            s.trim_start_sec = 1.0;
        });
        let mix = mix_timeline_audio(&[(s, src)], 3.0);
        let sample = |sec: f64| mix[(sec * MIX_SAMPLE_RATE as f64) as usize * MIX_CHANNELS];
        assert_eq!(sample(0.5), 0.0, "before the clip: silence");
        assert_eq!(sample(1.5), 0.5, "clip plays its trimmed source");
        assert_eq!(sample(2.5), 0.0, "after the clip: silence");
        assert_eq!(mix.len(), 3 * rate * MIX_CHANNELS);
    }

    #[test]
    fn applies_gain_and_linear_fades() {
        let rate = MIX_SAMPLE_RATE as usize;
        let src = vec![0.5f32; rate * MIX_CHANNELS]; // 1 s constant 0.5
        let s = seg(|s| {
            s.gain_db = 6.0;
            s.fade_in_sec = 0.5;
            s.fade_out_sec = 0.5;
        });
        let mix = mix_timeline_audio(&[(s, src)], 1.0);
        let gain = 10f64.powf(6.0 / 20.0) as f32;
        let at = |sec: f64| mix[(sec * MIX_SAMPLE_RATE as f64) as usize * MIX_CHANNELS];
        assert!(at(0.0).abs() < 1e-3, "fade-in starts at 0");
        let mid = at(0.5);
        assert!(
            (mid - 0.5 * gain).abs() < 0.01,
            "peak carries the gain: {mid}"
        );
        assert!(at(0.999) < 0.02, "fade-out ends near 0");
    }

    #[test]
    fn waveform_peaks_report_the_loudest_sample_per_bucket() {
        // 4 frames of stereo: quiet, loud-left, loud-right, quiet.
        let pcm = [0.1f32, 0.1, 0.9, 0.2, 0.2, -0.7, 0.1, 0.1];
        let peaks = waveform_peaks_from_interleaved_stereo_pcm(&pcm, 2);
        assert_eq!(peaks, vec![0.9, 0.7]);
    }

    #[test]
    fn waveform_peaks_clamp_to_full_scale_and_handle_empty_input() {
        let pcm = [1.5f32, -2.0];
        assert_eq!(waveform_peaks_from_interleaved_stereo_pcm(&pcm, 1), vec![1.0]);
        assert!(waveform_peaks_from_interleaved_stereo_pcm(&[], 4).is_empty());
        assert!(waveform_peaks_from_interleaved_stereo_pcm(&pcm, 0).is_empty());
    }

    #[test]
    fn sums_overlapping_clips_and_clips_to_full_scale() {
        let rate = MIX_SAMPLE_RATE as usize;
        let src = vec![0.8f32; rate * MIX_CHANNELS];
        let a = seg(|_| {});
        let b = seg(|_| {});
        let mix = mix_timeline_audio(&[(a, src.clone()), (b, src)], 1.0);
        assert!(mix.iter().all(|s| *s <= 1.0), "0.8 + 0.8 hard-clips at 1.0");
        assert_eq!(mix[0], 1.0);
    }
}
