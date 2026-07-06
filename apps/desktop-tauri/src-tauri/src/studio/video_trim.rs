//! The `videoTrim` node executor: cuts a `[start_sec, end_sec)` range out of a
//! video file through the native in-process FFmpeg encoder
//! (`ffmpeg_native::trim_video`); builds without the `native-ffmpeg` feature
//! surface an error. The cut decodes-and-re-encodes, so it is frame-accurate
//! rather than snapping to keyframes; audio is not carried over (the media
//! engine is video-only).

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

/// The source video path: the `video` input when connected, else the param.
fn resolve_video(node: &StudioGraphNode, inputs: &BTreeMap<String, Value>) -> Option<String> {
    let wired = inputs
        .get("video")
        .filter(|value| !value.is_null())
        .map(|value| studio_value_to_string(Some(value)));
    optional(wired.unwrap_or_default())
        .or_else(|| optional(studio_value_to_string(node.params.get("video"))))
}

/// The output video path: `output_dir` (param or runtime default) joined with
/// `output_name` (default `trimmed-<millis>.mp4`, extension appended when
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
            format!("trimmed-{millis}.mp4")
        }
    };
    Ok(Path::new(&dir).join(name).to_string_lossy().to_string())
}

pub(super) fn execute_studio_video_trim(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let video = resolve_video(node, inputs).ok_or_else(|| {
        "Video Trim needs a video (connect a video input or set the video param)".to_string()
    })?;
    if !Path::new(&video).is_file() {
        return Err(format!("video file does not exist: {video}"));
    }

    let start_sec = number_param(node, "start_sec", 0.0);
    if start_sec < 0.0 {
        return Err("start_sec must be >= 0".to_string());
    }
    // end_sec <= 0 means "to the end of the clip" (the param defaults to 0).
    let end_raw = number_param(node, "end_sec", 0.0);
    let end_sec = if end_raw > 0.0 { Some(end_raw) } else { None };
    if let Some(end) = end_sec {
        if end <= start_sec {
            return Err("end_sec must be greater than start_sec".to_string());
        }
    }
    let codec = optional(studio_value_to_string(node.params.get("codec")))
        .unwrap_or_else(|| "libx264".to_string());
    let device = optional(studio_value_to_string(node.params.get("device")))
        .unwrap_or_else(|| "auto".to_string());
    let out_path = resolve_output_path(node)?;

    #[cfg(feature = "native-ffmpeg")]
    {
        // Engine telemetry (GPU_DEVICE_STRATEGY_PLAN shared DeviceReport
        // vocabulary): the shared opt-in hardware selection/fallback — only
        // an explicit `device: gpu` request tries a hardware H.264 encoder,
        // with the fallback reason kept visible on the report.
        let (stats, device_used, requested, fallback_reason) =
            super::video_engine::encode_with_device(&device, &codec, |codec| {
                super::ffmpeg_native::trim_video(
                    Path::new(&video),
                    Path::new(&out_path),
                    start_sec,
                    end_sec,
                    codec,
                )
            })?;
        Ok(studio_output_map([
            ("video", json!(out_path)),
            ("frame_count", json!(stats.frame_count)),
            ("duration_sec", json!(stats.duration_sec)),
            (
                "trim_report",
                json!({
                    "width": stats.width,
                    "height": stats.height,
                    "fps": stats.fps,
                    "codec": stats.codec,
                    "frame_count": stats.frame_count,
                    "duration_sec": stats.duration_sec,
                    "start_sec": stats.start_sec,
                    "end_sec": stats.end_sec,
                    "engine": "ffmpeg",
                    "device": device_used.as_str(),
                    "device_requested": requested.as_str(),
                    "engine_fallback_reason": fallback_reason,
                }),
            ),
        ]))
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        let _ = (codec, device, out_path);
        Err("Video Trim requires the `native-ffmpeg` build (vendored libav encoders)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "videoTrim".to_string(),
            params: BTreeMap::new(),
        }
    }

    fn temp_video(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, b"not really a video").unwrap();
        path
    }

    #[test]
    fn rejects_missing_video() {
        let err = execute_studio_video_trim(&node(), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("needs a video"), "{err}");
    }

    #[test]
    fn rejects_nonexistent_video_before_trimming() {
        let mut inputs = BTreeMap::new();
        inputs.insert("video".to_string(), json!("Z:/definitely/missing.mp4"));
        let err = execute_studio_video_trim(&node(), &inputs).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn wired_video_input_overrides_param() {
        let mut n = node();
        n.params.insert("video".to_string(), json!("param.mp4"));
        let mut inputs = BTreeMap::new();
        inputs.insert("video".to_string(), json!("wired.mp4"));
        assert_eq!(resolve_video(&n, &inputs).as_deref(), Some("wired.mp4"));
        assert_eq!(
            resolve_video(&n, &BTreeMap::new()).as_deref(),
            Some("param.mp4")
        );
    }

    #[test]
    fn rejects_negative_start() {
        let video = temp_video("hgripe-video-trim-start-test.mp4");
        let mut n = node();
        n.params.insert("start_sec".to_string(), json!(-1));
        let mut inputs = BTreeMap::new();
        inputs.insert("video".to_string(), json!(video.to_string_lossy()));
        let err = execute_studio_video_trim(&n, &inputs).unwrap_err();
        assert!(err.contains("start_sec must be >= 0"), "{err}");
        let _ = std::fs::remove_file(&video);
    }

    #[test]
    fn rejects_end_not_after_start() {
        let video = temp_video("hgripe-video-trim-end-test.mp4");
        let mut n = node();
        n.params.insert("start_sec".to_string(), json!(5));
        n.params.insert("end_sec".to_string(), json!(5));
        let mut inputs = BTreeMap::new();
        inputs.insert("video".to_string(), json!(video.to_string_lossy()));
        let err = execute_studio_video_trim(&n, &inputs).unwrap_err();
        assert!(err.contains("end_sec must be greater"), "{err}");
        let _ = std::fs::remove_file(&video);
    }

    #[test]
    fn output_name_gets_mp4_extension() {
        let mut n = node();
        n.params.insert("output_dir".to_string(), json!("C:/out"));
        n.params.insert("output_name".to_string(), json!("cut"));
        let path = resolve_output_path(&n).unwrap();
        assert!(path.ends_with("cut.mp4"), "{path}");

        n.params
            .insert("output_name".to_string(), json!("cut.webm"));
        let path = resolve_output_path(&n).unwrap();
        assert!(path.ends_with("cut.webm"), "{path}");
    }
}
