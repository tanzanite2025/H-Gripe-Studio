//! The drawer's timeline export command (UNIFIED_PRODUCTION_DRAWER_PLAN.md
//! step 9): encode an ordered frame sequence produced from the timeline render
//! plan into a video file. The UI builds the render plan (still clips expanded
//! to per-frame image paths at the chosen fps) and this command reuses the
//! `videoAssemble` executor for the actual FFmpeg encode — native in-process
//! FFmpeg on default builds, the PyAV worker otherwise. Video-clip segments and
//! the audio mixdown/mux extend this seam later.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use hgripe_grade::GradeSurface;

use super::grade::{apply_grade_doc, grade_space, parse_grade_doc};
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
}

/// Frames ready for the encoder, plus the grading backend report.
pub(super) struct GradedFrames {
    pub(super) frames: Vec<String>,
    pub(super) graded_frame_count: u64,
    pub(super) backend: Option<&'static str>,
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
    let mut backend: Option<&'static str> = None;
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

/// Encode `frames` (one image path per output frame, in order) at `fps` into a
/// video under the project output dir. When `grade_docs` is given (aligned
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
) -> Result<TimelineExportResult, String> {
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
    Ok(TimelineExportResult {
        video_path,
        frame_count: outputs
            .get("frame_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duration_sec: outputs
            .get("duration_sec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        graded_frame_count,
        grade_backend: backend,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_frames() {
        let err = timeline_export(vec![], 24.0, None, None, None).unwrap_err();
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
        )
        .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
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
        assert!(matches!(result.backend, Some("cpu") | Some("gpu")));
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
}
