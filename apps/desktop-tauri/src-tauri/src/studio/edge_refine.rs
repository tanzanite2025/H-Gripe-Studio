//! The `refineMaskEdge` node executor. The default `cpu` engine runs the
//! in-process native-Rust heuristic ([`super::edge_refine_cpu`]); a learned
//! matting engine — or a source the fast path cannot decode — is served by
//! the Python bridge (`crate::psd::refine_mask_edge`). Both paths clean up a
//! cut-out subject's matte and expose the refined image, the refined mask,
//! and an edge report as flat output ports with identical shape.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::edge_refine_cpu::{self, CpuEdgeRefineParams};
use super::graph::{
    bool_param, number_param, optional, resolve_output_dir, studio_output_map,
    studio_value_to_string, StudioGraphNode,
};
use crate::psd::{refine_mask_edge, RefineEdgeResult};

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

    // The default `cpu` engine runs in-process; a learned matting engine — or
    // a source the fast path cannot decode — falls through to Python.
    let engine_is_cpu = engine
        .as_deref()
        .map(|e| e.trim().eq_ignore_ascii_case("cpu"))
        .unwrap_or(true);
    if engine_is_cpu {
        let cpu_params = CpuEdgeRefineParams {
            image_path: image.clone(),
            mask_path: mask.clone(),
            background_path: background.clone(),
            trimap_path: trimap.clone(),
            preset: preset.clone(),
            erode_px,
            dilate_px,
            feather_px,
            guided_radius,
            edge_decontaminate,
            background_blend_strength,
            output_dir: output_dir.clone(),
            output_name: output_name.clone(),
            device_requested: device.clone().unwrap_or_else(|| "auto".to_string()),
        };
        if let Some(result) = edge_refine_cpu::try_refine(&cpu_params)? {
            return to_output_map(result);
        }
    }

    let result = refine_mask_edge(
        None,
        image,
        mask,
        background,
        optional(studio_value_to_string(inputs.get("placeholder_mask"))),
        trimap,
        preset,
        Some(erode_px),
        Some(dilate_px),
        Some(feather_px),
        Some(guided_radius),
        Some(edge_decontaminate),
        Some(background_blend_strength),
        Some(output_dir),
        output_name,
        engine,
        device,
    )?;

    to_output_map(result)
}

/// Encode a [`RefineEdgeResult`] into the node's flat output ports. Shared by
/// the in-process and Python paths so both emit an identical output shape.
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
        // No connected `image` input: must fail fast before shelling out to the
        // python bridge, with a clear message.
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
    fn param_defaults_match_python_bridge() {
        // The defaults wired here must mirror edge_refine_cli.py's argparse
        // defaults so an unconfigured node behaves identically to the CLI.
        let n = node();
        assert_eq!(number_param(&n, "erode_px", 1.0), 1.0);
        assert_eq!(number_param(&n, "dilate_px", 0.0), 0.0);
        assert_eq!(number_param(&n, "feather_px", 4.0), 4.0);
        assert_eq!(number_param(&n, "guided_radius", 8.0), 8.0);
        assert!(bool_param(&n, "edge_decontaminate", true));
        assert_eq!(number_param(&n, "background_blend_strength", 0.4), 0.4);
    }
}
