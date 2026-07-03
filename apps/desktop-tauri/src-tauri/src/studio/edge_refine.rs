//! The `refineMaskEdge` node executor. The `cpu` engine runs the in-process
//! native-Rust heuristic ([`super::edge_refine_cpu`]) — the only supported
//! backend. It cleans up a cut-out subject's matte and exposes the refined
//! image, the refined mask, and an edge report as flat output ports.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::edge_refine_cpu::{self, CpuEdgeRefineParams};
use super::graph::{
    bool_param, number_param, optional, resolve_output_dir, studio_output_map,
    studio_value_to_string, StudioGraphNode,
};
use crate::psd::RefineEdgeResult;

pub(super) fn execute_studio_refine_mask_edge(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let image = studio_value_to_string(inputs.get("image"));
    if image.trim().is_empty() {
        return Err("Mask Edge Refine needs a connected image input".to_string());
    }

    let output_dir = resolve_output_dir(node)?;
    let mask = optional(studio_value_to_string(inputs.get("mask")));
    let background = optional(studio_value_to_string(inputs.get("background")));
    let trimap = optional(studio_value_to_string(inputs.get("trimap")));
    let preset = optional(studio_value_to_string(node.params.get("preset")));
    let erode_px = number_param(node, "erode_px", 1.0) as i64;
    let dilate_px = number_param(node, "dilate_px", 0.0) as i64;
    let feather_px = number_param(node, "feather_px", 4.0);
    let guided_radius = number_param(node, "guided_radius", 8.0) as i64;
    let edge_decontaminate = bool_param(node, "edge_decontaminate", true);
    let background_blend_strength = number_param(node, "background_blend_strength", 0.4);
    let output_name = optional(studio_value_to_string(node.params.get("output_name")));
    let engine = optional(studio_value_to_string(node.params.get("engine")));
    // `device` selects the ONNX execution provider for the learned matter
    // (default `auto`); ignored by the CPU heuristic.
    let device = optional(studio_value_to_string(node.params.get("device")));

    let engine_is_cpu = engine
        .as_deref()
        .map(|e| e.trim().eq_ignore_ascii_case("cpu"))
        .unwrap_or(true);
    if !engine_is_cpu {
        return Err(format!(
            "Mask Edge Refine engine `{}` is no longer available; only the native `cpu` engine is supported",
            engine.as_deref().unwrap_or_default().trim()
        ));
    }

    let cpu_params = CpuEdgeRefineParams {
        image_path: image.clone(),
        mask_path: mask,
        background_path: background,
        trimap_path: trimap,
        preset,
        erode_px,
        dilate_px,
        feather_px,
        guided_radius,
        edge_decontaminate,
        background_blend_strength,
        output_dir,
        output_name,
        device_requested: device.unwrap_or_else(|| "auto".to_string()),
    };
    let result = edge_refine_cpu::try_refine(&cpu_params)?.ok_or_else(|| {
        format!("Mask Edge Refine could not decode {image}: unsupported source for the native path")
    })?;
    to_output_map(result)
}

/// Encode a [`RefineEdgeResult`] into the node's flat output ports.
fn to_output_map(result: RefineEdgeResult) -> Result<BTreeMap<String, Value>, String> {
    let report = serde_json::to_value(&result.edge_report)
        .map_err(|err| format!("failed to encode EdgeReport: {err}"))?;

    Ok(studio_output_map([
        ("refined_image", json!(result.refined_image)),
        ("refined_mask", json!(result.refined_mask)),
        ("edge_report", report),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "refineMaskEdge".to_string(),
            params: BTreeMap::new(),
        }
    }

    #[test]
    fn rejects_missing_image_input() {
        // No connected `image` input: must fail fast with a clear message.
        let err = execute_studio_refine_mask_edge(&node(), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn blank_image_input_is_rejected() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("   "));
        let err = execute_studio_refine_mask_edge(&node(), &inputs).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn param_defaults_are_stable() {
        // The defaults wired here are the documented node defaults; keep them
        // stable so an unconfigured node behaves consistently across releases.
        let n = node();
        assert_eq!(number_param(&n, "erode_px", 1.0), 1.0);
        assert_eq!(number_param(&n, "dilate_px", 0.0), 0.0);
        assert_eq!(number_param(&n, "feather_px", 4.0), 4.0);
        assert_eq!(number_param(&n, "guided_radius", 8.0), 8.0);
        assert!(bool_param(&n, "edge_decontaminate", true));
        assert_eq!(number_param(&n, "background_blend_strength", 0.4), 0.4);
    }
}
