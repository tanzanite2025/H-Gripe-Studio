//! `smartLayerSplit` graph node: the layered-image-asset protocol stub
//! (docs/plans/active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md).
//!
//! Wraps a flat image into a `LayeredImageAsset` JSON value — a locked
//! original layer plus low-confidence background/subject candidates whose
//! masks are the source image itself (placeholders). Pure in-process protocol
//! bridging: a real segmentation engine replaces this arm without changing
//! the node's ports. Keep the JSON shape in lock-step with the TS mirror in
//! `studio-ui/src/production/layeredImage.ts`.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::graph::{studio_output_map, studio_value_to_string, StudioGraphNode};

/// Engine tag written by the protocol stub (keep in sync with layeredImage.ts).
const LAYER_SPLIT_STUB_ENGINE: &str = "layer-split-stub/0.1";

const ORIGINAL_LAYER_ID: &str = "layer_original";
const BACKGROUND_LAYER_ID: &str = "layer_background";
const SUBJECT_LAYER_ID: &str = "layer_subject";

fn stub_candidate(id: &str, name: &str, kind: &str, image: &Value) -> Value {
    json!({
        "id": id,
        "name": name,
        "kind": kind,
        "bbox": [0, 0, 0, 0],
        "mask": image,
        "rgba": image,
        "confidence": 0.25,
        "source": "algorithm",
        "visible": true,
        "notes": ["placeholder mask (protocol stub)"],
    })
}

fn stub_layered_image_asset(image_path: &str, node_id: &str) -> Value {
    let image = json!({ "path": image_path });
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let review = |layer_id: &str| {
        json!({
            "layer_id": layer_id,
            "severity": "warning",
            "message": "placeholder mask — review before production use",
        })
    };
    json!({
        "id": format!("layered-{node_id}"),
        "source_asset_id": image_path,
        "source_node_id": node_id,
        "canvas": { "width": 0, "height": 0, "color_space": "unknown" },
        "base_image": image,
        "preview_composite": image,
        "layers": [
            json!({
                "id": ORIGINAL_LAYER_ID,
                "name": "original image",
                "kind": "unknown",
                "bbox": [0, 0, 0, 0],
                "mask": image,
                "rgba": image,
                "confidence": 1.0,
                "source": "algorithm",
                "visible": true,
                "locked": true,
                "notes": ["locked original (protocol stub)"],
            }),
            stub_candidate(BACKGROUND_LAYER_ID, "background candidate", "background", &image),
            stub_candidate(SUBJECT_LAYER_ID, "subject candidate", "subject", &image),
        ],
        "split_report": {
            "engine_version": LAYER_SPLIT_STUB_ENGINE,
            "created_at": created_at,
            "warnings": ["stub split: placeholder masks, no real segmentation"],
            "suggested_review": [review(BACKGROUND_LAYER_ID), review(SUBJECT_LAYER_ID)],
        },
    })
}

pub(crate) fn execute_studio_smart_layer_split(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let image_path = inputs
        .get("image")
        .map(|value| studio_value_to_string(Some(value)))
        .unwrap_or_default();
    if image_path.trim().is_empty() {
        return Err("Smart Layer Split needs a connected image input".to_string());
    }
    let asset = stub_layered_image_asset(&image_path, &node.id);
    let selected_kind = {
        let raw = studio_value_to_string(node.params.get("selected_kind"));
        if raw.is_empty() {
            "subject".to_string()
        } else {
            raw
        }
    };
    let layers = asset["layers"].as_array().cloned().unwrap_or_default();
    let selected = layers
        .iter()
        .find(|layer| {
            if selected_kind == "original" {
                layer["id"] == ORIGINAL_LAYER_ID
            } else {
                layer["kind"] == selected_kind.as_str()
            }
        })
        .and_then(|layer| layer["rgba"]["path"].as_str().map(str::to_string))
        .unwrap_or_else(|| image_path.clone());
    let masks: Vec<Value> = layers
        .iter()
        .map(|layer| json!({ "layer_id": layer["id"], "mask": layer["mask"]["path"] }))
        .collect();
    let split_report = asset["split_report"].clone();
    Ok(studio_output_map([
        ("layered_asset", asset),
        ("composite_preview", json!(image_path)),
        ("selected_layer", json!(selected)),
        ("masks", json!(masks)),
        ("split_report", split_report),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(params: &[(&str, Value)]) -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "smartLayerSplit".to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    #[test]
    fn requires_a_connected_image() {
        let err = execute_studio_smart_layer_split(&node(&[]), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("connected image"), "{err}");
    }

    #[test]
    fn emits_the_stub_asset_and_flat_ports() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("/a/b.png"));
        let out = execute_studio_smart_layer_split(&node(&[]), &inputs).unwrap();
        let asset = &out["layered_asset"];
        assert_eq!(asset["id"], "layered-n1");
        assert_eq!(asset["base_image"]["path"], "/a/b.png");
        let layers = asset["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0]["locked"], true);
        assert_eq!(layers[1]["kind"], "background");
        assert_eq!(layers[2]["kind"], "subject");
        assert_eq!(out["composite_preview"], "/a/b.png");
        // Default selection is the subject candidate (stub rgba = source image).
        assert_eq!(out["selected_layer"], "/a/b.png");
        assert_eq!(out["masks"].as_array().unwrap().len(), 3);
        assert_eq!(
            out["split_report"]["engine_version"],
            LAYER_SPLIT_STUB_ENGINE
        );
    }

    #[test]
    fn selected_kind_original_picks_the_locked_layer() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("/a/b.png"));
        let out = execute_studio_smart_layer_split(
            &node(&[("selected_kind", json!("original"))]),
            &inputs,
        )
        .unwrap();
        assert_eq!(out["selected_layer"], "/a/b.png");
    }
}
