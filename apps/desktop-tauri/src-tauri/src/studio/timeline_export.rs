//! The drawer's timeline export command (UNIFIED_PRODUCTION_DRAWER_PLAN.md
//! step 9): encode an ordered frame sequence produced from the timeline render
//! plan into a video file. The UI builds the render plan (still clips expanded
//! to per-frame image paths at the chosen fps) and this command reuses the
//! `videoAssemble` executor for the actual FFmpeg encode — native in-process
//! FFmpeg on default builds, the PyAV worker otherwise. Video-clip frames
//! arrive as (video path, clip-local time) pairs and are decoded through the
//! media engine's `FrameSource` before the grade/encode passes. Audio clips
//! are mixed down (trim / gain / fades, summed at their timeline offsets) and
//! muxed into the encoded video as an AAC track (`audio_mix`).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use hgripe_grade::GradeSurface;

use super::audio_mix::TimelineAudioSegment;
use super::grade::{apply_grade_doc, grade_space, parse_grade_doc, GradeBackend};
use super::graph::StudioGraphNode;
use super::studio_image;
use super::video_assemble::execute_studio_video_assemble;
use super::working_image::WorkingImage;

/// TS-facing result of a timeline export encode.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TimelineExportResult {
    pub(crate) video_path: String,
    pub(crate) frame_count: u64,
    pub(crate) duration_sec: f64,
    /// Frames graded before the encode (0 when no clip carried a doc).
    pub(crate) graded_frame_count: u64,
    /// Backend that ran the grade kernel (`cpu` / `gpu`), when frames were
    /// graded. Mirrors the preview's backend report (fallback contract).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) grade_backend: Option<&'static str>,
    /// Why the grade fell back to CPU, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) grade_backend_fallback_reason: Option<String>,
    /// Audio clips mixed into the output's AAC track (0 = video only).
    pub(crate) audio_clip_count: u64,
    /// Why the export stayed video-only although audio clips were sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio_skipped_reason: Option<String>,
}

/// Substitute decoded video frames into the frame sequence: each frame with
/// a decode time treats its path as a video source and renders the frame
/// nearest that clip-local time under `frames_dir` via the media engine's
/// `FrameSource` (repeated (path, time) pairs reuse the decoded file);
/// frames without a time pass through as image paths.
pub(super) fn resolve_video_frames(
    frames: Vec<String>,
    frame_times: &[Option<f64>],
    frames_dir: &Path,
) -> Result<Vec<String>, String> {
    if frame_times.len() != frames.len() {
        return Err(format!(
            "frame_times length {} does not match frames length {}",
            frame_times.len(),
            frames.len()
        ));
    }
    if !frame_times.iter().any(Option::is_some) {
        return Ok(frames);
    }
    let mut source = super::video_engine::make_frame_source();
    let mut rendered: HashMap<(String, i64), String> = HashMap::new();
    let mut out = Vec::with_capacity(frames.len());
    for (i, path) in frames.into_iter().enumerate() {
        let Some(time_sec) = frame_times[i] else {
            out.push(path);
            continue;
        };
        if !time_sec.is_finite() || time_sec < 0.0 {
            return Err(format!("invalid frame time {time_sec} at frame {i}"));
        }
        let key = (path.clone(), (time_sec * 1000.0).round() as i64);
        if let Some(existing) = rendered.get(&key) {
            out.push(existing.clone());
            continue;
        }
        std::fs::create_dir_all(frames_dir)
            .map_err(|err| format!("failed to create {}: {err}", frames_dir.display()))?;
        let frame_out = frames_dir.join(format!("vframe_{}.png", rendered.len()));
        let written = source.decode_frame(Path::new(path.trim()), time_sec, &frame_out)?;
        let out_str = written.to_string_lossy().to_string();
        rendered.insert(key, out_str.clone());
        out.push(out_str);
    }
    Ok(out)
}

/// Frames ready for the encoder, plus the grading backend report.
pub(super) struct GradedFrames {
    pub(super) frames: Vec<String>,
    pub(super) graded_frame_count: u64,
    pub(super) backend: Option<GradeBackend>,
}

/// Substitute graded frames into a frame sequence: each frame with a grade
/// doc is graded once per unique `(path, doc)` pair on the full-precision
/// working surface (the node run path's contract, not the preview proxy) and
/// written under `graded_dir`; repeated frames of the same clip reuse the
/// rendered file. Frames without a doc pass through untouched.
pub(super) fn resolve_graded_frames(
    frames: Vec<String>,
    grade_docs: &[Option<String>],
    graded_dir: &Path,
) -> Result<GradedFrames, String> {
    let mut rendered: HashMap<(String, String), String> = HashMap::new();
    let mut out = Vec::with_capacity(frames.len());
    let mut graded_frame_count = 0u64;
    let mut backend: Option<GradeBackend> = None;
    for (i, path) in frames.into_iter().enumerate() {
        let doc_str = grade_docs.get(i).and_then(|d| d.as_deref()).unwrap_or("");
        if doc_str.trim().is_empty() {
            out.push(path);
            continue;
        }
        let doc = parse_grade_doc(Some(&Value::String(doc_str.to_string())))?;
        if doc.layers.iter().all(|l| l.ops.is_empty()) {
            out.push(path);
            continue;
        }
        let key = (path.clone(), doc_str.to_string());
        if let Some(existing) = rendered.get(&key) {
            graded_frame_count += 1;
            out.push(existing.clone());
            continue;
        }
        let loaded = studio_image::load_working(
            Path::new(path.trim()),
            studio_image::DEFAULT_MAX_DECODE_PIXELS,
        )?;
        let image = loaded.image;
        let mut surface = GradeSurface::from_rgba16(
            image.width,
            image.height,
            &image.pixels,
            grade_space(image.space),
        );
        backend = Some(apply_grade_doc(&doc, &mut surface));
        graded_frame_count += 1;
        let graded = WorkingImage {
            width: image.width,
            height: image.height,
            pixels: surface.to_rgba16(),
            space: image.space,
            icc: image.icc.clone(),
        };
        std::fs::create_dir_all(graded_dir)
            .map_err(|err| format!("failed to create {}: {err}", graded_dir.display()))?;
        let out_path = graded_dir.join(format!("graded_{}.png", rendered.len()));
        studio_image::write_working_output(&out_path, &graded)?;
        let out_str = out_path.to_string_lossy().to_string();
        rendered.insert(key, out_str.clone());
        out.push(out_str);
    }
    Ok(GradedFrames {
        frames: out,
        graded_frame_count,
        backend,
    })
}

/// Encode `frames` (one media path per output frame, in order) at `fps` into
/// a video under the project output dir. When `frame_times` is given (aligned
/// with `frames`), frames with a time are video-clip frames decoded from
/// their source at that clip-local time. When `grade_docs` is given (aligned
/// with `frames`), each clip's stored grade document is applied to its frames
/// before the encode — the export carries the same grades the program monitor
/// and grade preview show. Backed by the same encoder as the `videoAssemble`
/// node executor.
#[tauri::command]
pub(crate) fn timeline_export(
    frames: Vec<String>,
    fps: f64,
    codec: Option<String>,
    output_name: Option<String>,
    grade_docs: Option<Vec<Option<String>>>,
    frame_times: Option<Vec<Option<f64>>>,
    audio: Option<Vec<TimelineAudioSegment>>,
) -> Result<TimelineExportResult, String> {
    let frames = match frame_times {
        Some(times) if times.iter().any(Option::is_some) => {
            let frames_dir = crate::runtime_paths()?.output_dir.join(format!(
                "timeline_frames_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));
            resolve_video_frames(frames, &times, &frames_dir)?
        }
        _ => frames,
    };
    let graded = match grade_docs {
        Some(docs) if docs.iter().any(|d| d.is_some()) => {
            let graded_dir = crate::runtime_paths()?.output_dir.join(format!(
                "timeline_graded_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));
            resolve_graded_frames(frames, &docs, &graded_dir)?
        }
        _ => GradedFrames {
            frames,
            graded_frame_count: 0,
            backend: None,
        },
    };
    let GradedFrames {
        frames,
        graded_frame_count,
        backend,
    } = graded;
    let mut params: BTreeMap<String, Value> = BTreeMap::new();
    params.insert("fps".to_string(), json!(fps));
    if let Some(codec) = codec {
        params.insert("codec".to_string(), json!(codec));
    }
    if let Some(name) = output_name {
        params.insert("output_name".to_string(), json!(name));
    }
    let node = StudioGraphNode {
        id: "timeline-export".to_string(),
        kind: "videoAssemble".to_string(),
        params,
    };
    let mut inputs: BTreeMap<String, Value> = BTreeMap::new();
    inputs.insert("frames".to_string(), json!(frames));

    let outputs = execute_studio_video_assemble(&node, &inputs)?;
    let video_path = outputs
        .get("video")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let duration_sec = outputs
        .get("duration_sec")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut audio_clip_count = 0u64;
    let mut audio_skipped_reason: Option<String> = None;
    if let Some(segments) = audio.filter(|s| !s.is_empty()) {
        match mux_timeline_audio(&video_path, &segments, duration_sec) {
            Ok(count) => audio_clip_count = count,
            // The video is already on disk; a bad audio source degrades the
            // export to video-only instead of discarding the encode.
            Err(reason) => audio_skipped_reason = Some(reason),
        }
    }

    Ok(TimelineExportResult {
        video_path,
        frame_count: outputs
            .get("frame_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duration_sec,
        graded_frame_count,
        grade_backend: backend.as_ref().map(|b| b.name),
        grade_backend_fallback_reason: backend.and_then(|b| b.fallback_reason),
        audio_clip_count,
        audio_skipped_reason,
    })
}

/// Decode every audio segment's source, mix the timeline (trim / gain /
/// fades at each clip's offset, trimmed to the video's length), and mux the
/// mix as an AAC track into `video_path` in place. Returns the clip count.
#[cfg(feature = "native-ffmpeg")]
fn mux_timeline_audio(
    video_path: &str,
    segments: &[TimelineAudioSegment],
    duration_sec: f64,
) -> Result<u64, String> {
    use super::audio_mix::{decode_audio_pcm, mix_timeline_audio, mux_video_with_audio};

    let mut decoded: HashMap<&str, Vec<f32>> = HashMap::new();
    for seg in segments {
        if !decoded.contains_key(seg.path.as_str()) {
            let pcm = decode_audio_pcm(Path::new(&seg.path))?;
            decoded.insert(seg.path.as_str(), pcm);
        }
    }
    let pairs: Vec<(TimelineAudioSegment, Vec<f32>)> = segments
        .iter()
        .map(|seg| (seg.clone(), decoded[seg.path.as_str()].clone()))
        .collect();
    let mix = mix_timeline_audio(&pairs, duration_sec);
    if mix.is_empty() {
        return Err("audio mix is empty (zero-length export)".to_string());
    }

    let video = Path::new(video_path);
    let muxed = video.with_extension("mux.mp4");
    mux_video_with_audio(video, &mix, &muxed)?;
    std::fs::remove_file(video).map_err(|err| format!("failed to replace {video_path}: {err}"))?;
    std::fs::rename(&muxed, video)
        .map_err(|err| format!("failed to move the muxed file into place: {err}"))?;
    Ok(segments.len() as u64)
}

#[cfg(not(feature = "native-ffmpeg"))]
fn mux_timeline_audio(
    _video_path: &str,
    _segments: &[TimelineAudioSegment],
    _duration_sec: f64,
) -> Result<u64, String> {
    Err("audio mixdown requires the `native-ffmpeg` build (vendored libav)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_frames() {
        let err = timeline_export(vec![], 24.0, None, None, None, None, None).unwrap_err();
        assert!(err.contains("needs at least one frame"), "{err}");
    }

    #[test]
    fn rejects_missing_frame_files() {
        let err = timeline_export(
            vec!["Z:/definitely/missing-frame.png".to_string()],
            24.0,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn resolve_video_frames_validates_alignment_and_passes_stills_through() {
        let frames = vec!["a.png".to_string(), "b.png".to_string()];
        let dir = std::env::temp_dir().join("hgripe_export_vframes");

        let err = resolve_video_frames(frames.clone(), &[None], &dir).unwrap_err();
        assert!(err.contains("does not match"), "{err}");

        // No decode times: the sequence passes through untouched.
        let out = resolve_video_frames(frames.clone(), &[None, None], &dir).unwrap();
        assert_eq!(out, frames);

        let err = resolve_video_frames(frames, &[None, Some(-1.0)], &dir).unwrap_err();
        assert!(err.contains("invalid frame time"), "{err}");
    }

    #[cfg(feature = "native-ffmpeg")]
    #[test]
    fn resolve_video_frames_decodes_and_reuses_repeated_times() {
        // Encode a tiny video, then decode frames from it: repeated
        // (path, time) pairs must share one decoded file.
        let dir = std::env::temp_dir().join(format!("hgripe_export_vdec_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut stills = Vec::new();
        for i in 0..6u8 {
            let p = dir.join(format!("src_{i}.png"));
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                16,
                16,
                image::Rgba([i * 40, 0, 0, 255]),
            ))
            .save(&p)
            .unwrap();
            stills.push(p.to_string_lossy().to_string());
        }
        let clip = dir.join("clip.mp4");
        super::super::ffmpeg_native::assemble_frames(&stills, &clip, 6.0, "libx264")
            .expect("encode the source video");
        let clip_str = clip.to_string_lossy().to_string();

        let frames_dir = dir.join("vframes");
        let out = resolve_video_frames(
            vec![
                clip_str.clone(),
                clip_str.clone(),
                clip_str,
                "still.png".to_string(),
            ],
            &[Some(0.0), Some(0.0), Some(0.5), None],
            &frames_dir,
        )
        .expect("decode video frames");
        assert_eq!(out[0], out[1], "repeated (path, time) reuses the file");
        assert_ne!(out[0], out[2]);
        assert!(Path::new(&out[0]).exists());
        assert!(Path::new(&out[2]).exists());
        assert_eq!(out[3], "still.png", "still frames pass through");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grades_frames_once_per_clip_and_passes_ungraded_through() {
        let dir = std::env::temp_dir().join(format!("hgripe_export_grade_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("still.png");
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            4,
            4,
            image::Rgba([100, 100, 100, 255]),
        ))
        .save(&src)
        .unwrap();
        let src_str = src.to_string_lossy().to_string();

        let doc = r#"{"layers":[{"blend":"normal","opacity":1.0,"visible":true,"mask":null,"qualifier":null,"ops":[{"type":"exposure","ev":1.0}]}]}"#.to_string();
        let graded_dir = dir.join("graded");
        let result = resolve_graded_frames(
            vec![src_str.clone(), src_str.clone(), src_str.clone()],
            &[Some(doc.clone()), Some(doc), None],
            &graded_dir,
        )
        .expect("grading succeeds");
        let out = result.frames;

        // Repeated (path, doc) frames reuse one rendered file; the ungraded
        // frame passes through unchanged. Both graded frames are counted and
        // the backend that ran the kernel is reported.
        assert_eq!(out[0], out[1]);
        assert_ne!(out[0], src_str);
        assert_eq!(out[2], src_str);
        assert_eq!(result.graded_frame_count, 2);
        let backend = result
            .backend
            .as_ref()
            .expect("graded frames report a backend");
        assert!(matches!(backend.name, "cpu" | "gpu"));
        assert!(
            backend.name == "gpu" || backend.fallback_reason.is_some(),
            "a CPU fallback must carry its reason"
        );
        let graded = image::open(&out[0]).unwrap().to_rgba8();
        assert!(graded.get_pixel(0, 0).0[0] > 100, "exposure brightens");

        // Identity / empty docs never render a graded copy or report a backend.
        let result = resolve_graded_frames(
            vec![src_str.clone(), src_str.clone()],
            &[Some(String::new()), Some(r#"{"layers":[]}"#.to_string())],
            &graded_dir,
        )
        .expect("identity docs pass through");
        assert_eq!(result.frames, vec![src_str.clone(), src_str]);
        assert_eq!(result.graded_frame_count, 0);
        assert!(result.backend.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn base64_decode(s: &str) -> Vec<u8> {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0u32;
        for &b in s.as_bytes() {
            if b == b'=' {
                break;
            }
            let v = TABLE.iter().position(|&t| t == b).expect("base64 byte") as u32;
            buf = (buf << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn export_grade_matches_preview_within_tolerance() {
        // Pipeline-level preview/export alignment (WGPU migration Phase 5):
        // the viewport preview grades the display-space sRGB proxy while the
        // export grades the full-precision working surface, so the two paths
        // may differ only by quantization — never by a divergent kernel or
        // color pipeline.
        let dir = std::env::temp_dir().join(format!("hgripe_export_parity_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("still.png");
        let mut img = image::RgbaImage::new(8, 8);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgba([(x * 32) as u8, (y * 32) as u8, 128, 255]);
        }
        image::DynamicImage::ImageRgba8(img).save(&src).unwrap();
        let src_str = src.to_string_lossy().to_string();

        let doc_str = r#"{"layers":[{"blend":"normal","opacity":1.0,"visible":true,"mask":null,"qualifier":null,"ops":[{"type":"exposure","ev":0.5},{"type":"saturation","amount":0.3},{"type":"contrast","amount":1.2,"pivot":0.5}]}]}"#;

        // Export path: grade the working surface and write the frame file.
        let result = resolve_graded_frames(
            vec![src_str.clone()],
            &[Some(doc_str.to_string())],
            &dir.join("graded"),
        )
        .expect("export grading succeeds");
        let exported = image::open(&result.frames[0]).unwrap().to_rgba8();

        // Preview path: grade the cached sRGB proxy like the viewport does.
        let doc = parse_grade_doc(Some(&Value::String(doc_str.to_string()))).unwrap();
        let proxy = super::super::grade::load_image_srgb_proxy(&src, 64).unwrap();
        let preview =
            super::super::grade::grade_srgb_proxy(&proxy, &doc, std::time::Instant::now())
                .expect("preview grading succeeds");
        let png = base64_decode(
            preview
                .data_url
                .strip_prefix("data:image/png;base64,")
                .expect("png data url"),
        );
        let previewed = image::load_from_memory(&png).unwrap().to_rgba8();

        assert_eq!(exported.dimensions(), previewed.dimensions());
        let max_diff = exported
            .pixels()
            .zip(previewed.pixels())
            .flat_map(|(a, b)| a.0.iter().zip(b.0.iter()))
            .map(|(&a, &b)| (i16::from(a) - i16::from(b)).unsigned_abs())
            .max()
            .unwrap();
        assert!(
            max_diff <= 2,
            "export and preview grades diverge by {max_diff}/255"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
