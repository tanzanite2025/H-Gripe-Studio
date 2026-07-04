//! The `videoAssemble` node executor: encodes an ordered frame-image sequence
//! into a video file through the native in-process FFmpeg encoder
//! (`ffmpeg_native::assemble_frames`); builds without the `native-ffmpeg`
//! feature surface an error. This is the runner's video assembly/export card:
//! connect frames (a batch's saved outputs, a directory of rendered stills),
//! pick fps/codec, get an `.mp4` on disk.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(any(feature = "native-ffmpeg", test))]
use serde_json::json;
use serde_json::Value;

#[cfg(feature = "native-ffmpeg")]
use super::graph::studio_output_map;
use super::graph::{
    number_param, optional, resolve_output_dir, studio_value_to_string, StudioGraphNode,
};

/// Collect the ordered frame paths from the `frames` input (a JSON array or a
/// newline-delimited string) or, failing that, the node's `frames` param.
fn collect_frames(node: &StudioGraphNode, inputs: &BTreeMap<String, Value>) -> Vec<String> {
    let value = inputs
        .get("frames")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| node.params.get("frames").cloned().unwrap_or(Value::Null));
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| studio_value_to_string(Some(item)))
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect(),
        other => studio_value_to_string(Some(&other))
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect(),
    }
}

/// The output video path: `output_dir` (param or runtime default) joined with
/// `output_name` (default `assembled-<millis>.mp4`, extension appended when
/// missing).
fn resolve_output_path(node: &StudioGraphNode) -> Result<String, String> {
    let dir = resolve_output_dir(node)?;
    let name = match optional(studio_value_to_string(node.params.get("output_name"))) {
        Some(name) if name.contains('.') => name,
        Some(name) => format!("{name}.mp4"),
        None => {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|err| format!("system clock error: {err}"))?
                .as_millis();
            format!("assembled-{millis}.mp4")
        }
    };
    Ok(Path::new(&dir).join(name).to_string_lossy().to_string())
}

pub(super) fn execute_studio_video_assemble(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let frames = collect_frames(node, inputs);
    if frames.is_empty() {
        return Err(
            "Video Assemble needs at least one frame (connect a frames input or set the frames param)"
                .to_string(),
        );
    }
    for frame in &frames {
        if !Path::new(frame).is_file() {
            return Err(format!("frame image does not exist: {frame}"));
        }
    }

    let fps = number_param(node, "fps", 24.0);
    if !(fps > 0.0) {
        return Err("fps must be positive".to_string());
    }
    let codec = optional(studio_value_to_string(node.params.get("codec")))
        .unwrap_or_else(|| "libx264".to_string());
    let out_path = resolve_output_path(node)?;

    #[cfg(feature = "native-ffmpeg")]
    {
        let stats =
            super::ffmpeg_native::assemble_frames(&frames, Path::new(&out_path), fps, &codec)?;
        Ok(studio_output_map([
            ("video", json!(out_path)),
            ("frame_count", json!(stats.frame_count)),
            ("duration_sec", json!(stats.duration_sec)),
            (
                "assemble_report",
                json!({
                    "width": stats.width,
                    "height": stats.height,
                    "fps": stats.fps,
                    "codec": stats.codec,
                    "frame_count": stats.frame_count,
                    "duration_sec": stats.duration_sec,
                    // Engine telemetry (GPU_DEVICE_STRATEGY_PLAN shared
                    // DeviceReport vocabulary): the vendored libav software
                    // path is the encode baseline; hardware encoders join
                    // behind their own probe/report/fallback.
                    "engine": "ffmpeg",
                    "device": super::device_report::DeviceUsed::FfmpegSw.as_str(),
                    "device_requested": super::device_report::DeviceRequest::Auto.as_str(),
                    "engine_fallback_reason":
                        "hardware encode not enabled (vendored libav software baseline)",
                }),
            ),
        ]))
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        let _ = (codec, out_path);
        Err(
            "Video Assemble requires the `native-ffmpeg` build (vendored libav encoders)"
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "videoAssemble".to_string(),
            params: BTreeMap::new(),
        }
    }

    #[test]
    fn rejects_missing_frames() {
        let err = execute_studio_video_assemble(&node(), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("needs at least one frame"), "{err}");
    }

    #[test]
    fn rejects_nonexistent_frame_before_encoding() {
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "frames".to_string(),
            json!(["Z:/definitely/missing-frame.png"]),
        );
        let err = execute_studio_video_assemble(&node(), &inputs).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn collect_frames_accepts_array_and_multiline_string() {
        let mut inputs = BTreeMap::new();
        inputs.insert("frames".to_string(), json!(["a.png", "  ", "b.png"]));
        assert_eq!(collect_frames(&node(), &inputs), vec!["a.png", "b.png"]);

        inputs.insert("frames".to_string(), json!("a.png\n\n b.png \n"));
        assert_eq!(collect_frames(&node(), &inputs), vec!["a.png", "b.png"]);
    }

    #[test]
    fn collect_frames_falls_back_to_param() {
        let mut n = node();
        n.params.insert("frames".to_string(), json!("x.png\ny.png"));
        assert_eq!(collect_frames(&n, &BTreeMap::new()), vec!["x.png", "y.png"]);
    }

    #[test]
    fn rejects_nonpositive_fps() {
        let dir = std::env::temp_dir();
        let frame = dir.join("hgripe-video-assemble-fps-test.png");
        std::fs::write(&frame, b"not really a png").unwrap();
        let mut n = node();
        n.params.insert("fps".to_string(), json!(0));
        let mut inputs = BTreeMap::new();
        inputs.insert("frames".to_string(), json!([frame.to_string_lossy()]));
        let err = execute_studio_video_assemble(&n, &inputs).unwrap_err();
        assert!(err.contains("fps must be positive"), "{err}");
        let _ = std::fs::remove_file(&frame);
    }

    #[test]
    fn output_name_gets_mp4_extension() {
        let mut n = node();
        n.params.insert("output_dir".to_string(), json!("C:/out"));
        n.params.insert("output_name".to_string(), json!("clip"));
        let path = resolve_output_path(&n).unwrap();
        assert!(path.ends_with("clip.mp4"), "{path}");

        n.params
            .insert("output_name".to_string(), json!("clip.webm"));
        let path = resolve_output_path(&n).unwrap();
        assert!(path.ends_with("clip.webm"), "{path}");
    }
}
