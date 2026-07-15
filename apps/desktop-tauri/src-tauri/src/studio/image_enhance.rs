//! The `imageEnhance` node executor. The always-available `cpu` engine and the
//! optional native-ORT `realesrgan` engine share one in-process decode/output
//! path and expose the enhanced image, applied scale factor, and report as flat
//! output ports.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::graph::{
    bool_param, number_param, optional, resolve_output_dir, studio_output_map,
    studio_value_to_string, StudioGraphNode,
};
use super::image_enhance_cpu::{self, EnhanceParams};
use crate::psd::EnhanceImageResult;

pub(super) fn execute_studio_image_enhance(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let image = studio_value_to_string(inputs.get("image"));
    if image.trim().is_empty() {
        return Err("Image Enhance needs a connected image input".to_string());
    }

    // Optional connected placeholder bounds ({x, y, width, height}) used to
    // auto-derive the target size; forwarded to the CLI as a JSON string.
    let target_bounds = match inputs.get("target_bounds") {
        Some(value) if !value.is_null() => Some(
            serde_json::to_string(value)
                .map_err(|err| format!("failed to encode target_bounds input: {err}"))?,
        ),
        _ => None,
    };

    let output_dir = resolve_output_dir(node)?;
    let mode = optional(studio_value_to_string(node.params.get("mode")));
    let target_width = number_param(node, "target_width", 0.0) as i64;
    let target_height = number_param(node, "target_height", 0.0) as i64;
    let target_dpi = number_param(node, "target_dpi", 300.0) as i64;
    let max_pixels = number_param(node, "max_pixels", 48_000_000.0) as i64;
    let scale = number_param(node, "scale", 2.0);
    let denoise_strength = number_param(node, "denoise_strength", 0.3);
    let texture_strength = number_param(node, "texture_strength", 0.25);
    let preserve_text_logo = bool_param(node, "preserve_text_logo", true);
    let engine = optional(studio_value_to_string(node.params.get("engine")));
    // `device` selects the compute device for the learned upscaler (default
    // `auto`); ignored by the CPU resize path.
    let device = optional(studio_value_to_string(node.params.get("device")));
    // The supported model is FP32. Legacy `fp16` requests stay readable and
    // report their downgrade; the built-in CPU resize path ignores precision.
    let precision = optional(studio_value_to_string(node.params.get("precision")));
    let output_name = optional(studio_value_to_string(node.params.get("output_name")));

    let params = EnhanceParams {
        image_path: image.clone(),
        output_dir,
        output_name,
        mode,
        target_bounds,
        target_width,
        target_height,
        target_dpi,
        max_pixels,
        scale,
        denoise_strength,
        texture_strength,
        preserve_text_logo,
        engine_requested: engine.unwrap_or_else(|| "cpu".to_string()),
        device_requested: device.unwrap_or_else(|| "auto".to_string()),
        precision_requested: precision.unwrap_or_else(|| "auto".to_string()),
    };
    let result = image_enhance_cpu::try_enhance(&params)?.ok_or_else(|| {
        format!("Image Enhance could not process {image}: unsupported source for the native path")
    })?;
    to_output_map(result)
}

/// Encode an [`EnhanceImageResult`] into the node's flat output ports.
fn to_output_map(result: EnhanceImageResult) -> Result<BTreeMap<String, Value>, String> {
    let report = serde_json::to_value(&result.enhance_report)
        .map_err(|err| format!("failed to encode EnhanceReport: {err}"))?;

    Ok(studio_output_map([
        ("enhanced_image", json!(result.enhanced_image)),
        ("scale_factor", json!(result.scale_factor)),
        ("enhance_report", report),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "imageEnhance".to_string(),
            params: BTreeMap::new(),
        }
    }

    #[test]
    fn rejects_missing_image_input() {
        // No connected `image` input: must fail fast with a clear message.
        let err = execute_studio_image_enhance(&node(), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn blank_image_input_is_rejected() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("   "));
        let err = execute_studio_image_enhance(&node(), &inputs).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn graph_executor_keeps_outputs_when_a_removed_engine_is_loaded() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hgripe_graph_enhance_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.png");
        RgbaImage::from_pixel(8, 8, Rgba([20, 40, 80, 255]))
            .save(&source)
            .unwrap();

        let mut node = node();
        node.params.insert("engine".to_string(), json!("supir"));
        node.params
            .insert("output_dir".to_string(), json!(dir.to_string_lossy()));
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(source.to_string_lossy()));
        let outputs = execute_studio_image_enhance(&node, &inputs).unwrap();
        let report = outputs["enhance_report"].as_object().unwrap();
        assert_eq!(report["engine"], "cpu");
        assert_eq!(report["engine_requested"], "supir");
        assert!(report["engine_fallback_reason"]
            .as_str()
            .unwrap()
            .contains("removed with the Python/Torch runtime"));
        assert!(std::path::Path::new(outputs["enhanced_image"].as_str().unwrap()).is_file());
        let _ = std::fs::remove_dir_all(dir);
    }
}
