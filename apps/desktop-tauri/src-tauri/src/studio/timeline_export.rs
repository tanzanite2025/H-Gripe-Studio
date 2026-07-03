//! The drawer's timeline export command (UNIFIED_PRODUCTION_DRAWER_PLAN.md
//! step 9): encode an ordered frame sequence produced from the timeline render
//! plan into a video file. The UI builds the render plan (still clips expanded
//! to per-frame image paths at the chosen fps) and this command reuses the
//! `videoAssemble` executor for the actual FFmpeg encode — native in-process
//! FFmpeg on default builds, the PyAV worker otherwise. Video-clip segments and
//! the audio mixdown/mux extend this seam later.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use super::graph::StudioGraphNode;
use super::video_assemble::execute_studio_video_assemble;

/// TS-facing result of a timeline export encode.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TimelineExportResult {
    pub(crate) video_path: String,
    pub(crate) frame_count: u64,
    pub(crate) duration_sec: f64,
}

/// Encode `frames` (one image path per output frame, in order) at `fps` into a
/// video under the project output dir. Backed by the same encoder as the
/// `videoAssemble` node executor.
#[tauri::command]
pub(crate) fn timeline_export(
    frames: Vec<String>,
    fps: f64,
    codec: Option<String>,
    output_name: Option<String>,
) -> Result<TimelineExportResult, String> {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_frames() {
        let err = timeline_export(vec![], 24.0, None, None).unwrap_err();
        assert!(err.contains("needs at least one frame"), "{err}");
    }

    #[test]
    fn rejects_missing_frame_files() {
        let err = timeline_export(
            vec!["Z:/definitely/missing-frame.png".to_string()],
            24.0,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }
}
