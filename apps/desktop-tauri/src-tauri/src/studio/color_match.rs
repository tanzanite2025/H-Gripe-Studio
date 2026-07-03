//! The `matchLightColor` node executor. The `cpu` engine runs the in-process
//! native-Rust heuristic ([`super::color_match_cpu`]) — the only supported
//! backend. It nudges a connected subject image toward a PSD background and
//! exposes the matched image, the match report, and a prompt suffix as flat
//! output ports.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::color_match_cpu::{self, CpuColorMatchParams};
use super::graph::{
    bool_param, number_param, optional, resolve_output_dir, studio_output_map,
    studio_value_to_string, StudioGraphNode,
};
use crate::psd::ColorMatchResult;

pub(super) fn execute_studio_match_light_color(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let image = studio_value_to_string(inputs.get("image"));
    if image.trim().is_empty() {
        return Err("Light & Color Match needs a connected image input".to_string());
    }

    // The upstream `visual_context` arrives as a JSON object; forward it as a
    // serialized string for the prompt suffix (None when nothing is wired).
    let context = match inputs.get("visual_context") {
        Some(value) if !value.is_null() => Some(
            serde_json::to_string(value)
                .map_err(|err| format!("failed to encode visual_context: {err}"))?,
        ),
        _ => None,
    };

    let output_dir = resolve_output_dir(node)?;
    let background = optional(studio_value_to_string(inputs.get("background")));
    let mask = optional(studio_value_to_string(inputs.get("mask")));
    let mode = optional(studio_value_to_string(node.params.get("mode")));
    let strength = number_param(node, "strength", 0.6);
    let shadow_strength = number_param(node, "shadow_strength", 0.0);
    let highlight_strength = number_param(node, "highlight_strength", 0.0);
    let protect_saturation = bool_param(node, "protect_saturation", false);
    let protect_brand_color = bool_param(node, "protect_brand_color", true);
    // `engine` must be the native `cpu` heuristic (the default).
    let engine = optional(studio_value_to_string(node.params.get("engine")));
    // `device` selects the ONNX execution provider for the learned matcher
    // (default `auto`); ignored by the CPU heuristic.
    let device = optional(studio_value_to_string(node.params.get("device")));
    let output_name = optional(studio_value_to_string(node.params.get("output_name")));

    let engine_is_cpu = engine
        .as_deref()
        .map(|e| e.trim().eq_ignore_ascii_case("cpu"))
        .unwrap_or(true);
    if !engine_is_cpu {
        return Err(format!(
            "Light & Color Match engine `{}` is no longer available; only the native `cpu` engine is supported",
            engine.as_deref().unwrap_or_default().trim()
        ));
    }

    let cpu_params = CpuColorMatchParams {
        image_path: image.clone(),
        background_path: background,
        mask_path: mask,
        context,
        mode,
        strength,
        shadow_strength,
        highlight_strength,
        protect_saturation,
        protect_brand_color,
        output_dir,
        output_name,
        device_requested: device.unwrap_or_else(|| "auto".to_string()),
    };
    let result = color_match_cpu::try_match(&cpu_params)?.ok_or_else(|| {
        format!(
            "Light & Color Match could not decode {image}: unsupported source for the native path"
        )
    })?;
    to_output_map(result)
}

/// Encode a [`ColorMatchResult`] into the node's flat output ports.
fn to_output_map(result: ColorMatchResult) -> Result<BTreeMap<String, Value>, String> {
    let report = serde_json::to_value(&result.match_report)
        .map_err(|err| format!("failed to encode MatchReport: {err}"))?;

    Ok(studio_output_map([
        ("matched_image", json!(result.matched_image)),
        ("match_report", report),
        ("prompt_suffix", json!(result.prompt_suffix)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "matchLightColor".to_string(),
            params: BTreeMap::new(),
        }
    }

    #[test]
    fn rejects_missing_image_input() {
        // No connected `image` input: must fail fast with a clear message.
        let err = execute_studio_match_light_color(&node(), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("connected image"), "{err}");
    }

    #[test]
    fn blank_image_input_is_rejected() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("   "));
        let err = execute_studio_match_light_color(&node(), &inputs).unwrap_err();
        assert!(err.contains("connected image"), "{err}");
    }

    #[test]
    fn number_and_bool_params_fall_back_to_defaults() {
        // The documented node defaults; keep them stable across releases.
        let node = node();
        assert_eq!(number_param(&node, "strength", 0.6), 0.6);
        assert!(!bool_param(&node, "protect_saturation", false));
        assert!(bool_param(&node, "protect_brand_color", true));
    }
}
