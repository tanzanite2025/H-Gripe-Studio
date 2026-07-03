//! The `psdExport` node executor: bridges a graph node to the desktop PSD
//! composition pipeline (`crate::psd::compose_psd`), turning connected image /
//! template inputs into a composed `.psd` plus preview/metadata outputs.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::graph::{
    resolve_output_dir, studio_output_map, studio_value_to_string, StudioGraphNode,
};
use crate::psd::compose_psd;

/// Flatten a `LayeredImageAsset` JSON value into the first-version export
/// manifest (basic layer names, bbox and alpha refs) recorded in the exported
/// `_metadata.json`. Keep the shape in lock-step with `layeredAssetManifest`
/// in `studio-ui/src/production/layeredImage.ts`.
fn layered_asset_manifest(asset: &Value) -> Value {
    let layers: Vec<Value> = asset["layers"]
        .as_array()
        .map(|layers| {
            layers
                .iter()
                .map(|layer| {
                    json!({
                        "id": layer["id"],
                        "name": layer["name"],
                        "kind": layer["kind"],
                        "bbox": layer["bbox"],
                        "alpha": layer["mask"]["path"],
                        "locked": layer["locked"].as_bool().unwrap_or(false),
                        "confidence": layer["confidence"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "asset_id": asset["id"],
        "source_asset_id": asset["source_asset_id"],
        "engine_version": asset["split_report"]["engine_version"],
        "canvas": asset["canvas"],
        "composite_preview": asset["preview_composite"]["path"],
        "layers": layers,
    })
}

pub(super) fn execute_studio_psd_export(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    // A connected layered asset stands in for the flat image via its composite
    // preview, and its layer manifest is recorded in the exported metadata.
    let layered_asset = inputs.get("layered_asset").filter(|v| !v.is_null());
    let mut image = studio_value_to_string(inputs.get("image"));
    if image.is_empty() {
        if let Some(asset) = layered_asset {
            image = asset["preview_composite"]["path"]
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
    }
    if image.is_empty() {
        return Err("PSD Export needs a connected image or layered asset input".to_string());
    }
    let template = studio_value_to_string(inputs.get("template"));
    if template.is_empty() {
        return Err("PSD Export needs a connected PSD template input".to_string());
    }

    let output_dir = resolve_output_dir(node)?;
    let filename = {
        let configured = studio_value_to_string(node.params.get("filename"));
        if configured.trim().is_empty() {
            "final".to_string()
        } else {
            configured
        }
    };
    let placeholder_name = studio_value_to_string(node.params.get("placeholder"));
    let placeholder = if placeholder_name.trim().is_empty() {
        None
    } else {
        Some(json!({ "name": placeholder_name }).to_string())
    };

    // Optional explicit matte (e.g. Mask Edge Refine's `refined_mask`) applied
    // as the image's alpha before compositing.
    let mask = Some(
        studio_value_to_string(inputs.get("mask"))
            .trim()
            .to_string(),
    )
    .filter(|value| !value.is_empty());

    // Optional upstream production metadata (any JSON object) merged into the
    // exported `_metadata.json`.
    let metadata_input = inputs.get("metadata").filter(|v| !v.is_null());
    let metadata = if let Some(asset) = layered_asset {
        let mut map = match metadata_input {
            Some(Value::Object(map)) => map.clone(),
            Some(value) => {
                let mut map = Map::new();
                map.insert("metadata".to_string(), value.clone());
                map
            }
            None => Map::new(),
        };
        map.insert("layered_asset".to_string(), layered_asset_manifest(asset));
        Some(
            serde_json::to_string(&Value::Object(map))
                .map_err(|err| format!("failed to encode metadata input: {err}"))?,
        )
    } else {
        metadata_input
            .map(|value| {
                serde_json::to_string(value)
                    .map_err(|err| format!("failed to encode metadata input: {err}"))
            })
            .transpose()?
    };

    let result = compose_psd(
        None,
        template,
        image,
        mask,
        output_dir,
        Some(filename),
        placeholder,
        Some(
            studio_value_to_string(node.params.get("fit_mode"))
                .trim()
                .to_string(),
        )
        .filter(|value| !value.is_empty()),
        None,
        Some(
            studio_value_to_string(node.params.get("smart_object_mode"))
                .trim()
                .to_string(),
        )
        .filter(|value| !value.is_empty()),
        None,
        metadata,
        None,
    )?;

    if result.status != "succeeded" {
        return Err(format!("PSD export failed: {}", result.status));
    }

    let result_json = serde_json::to_value(&result)
        .map_err(|err| format!("failed to encode ComposePsdResult: {err}"))?;
    Ok(studio_output_map([
        ("psdPath", json!(result.psd_path)),
        ("previewPath", json!(result.preview_path)),
        ("metadataPath", json!(result.metadata_path)),
        ("placeholderKind", json!(result.placeholder_kind)),
        ("smartObjectMode", json!(result.smart_object_mode)),
        ("result", result_json),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_flattens_layer_names_bbox_and_alpha() {
        let asset = json!({
            "id": "layered-n1",
            "source_asset_id": "/a/b.png",
            "canvas": { "width": 0, "height": 0, "color_space": "unknown" },
            "preview_composite": { "path": "/a/b.png" },
            "layers": [
                {
                    "id": "layer_original",
                    "name": "original image",
                    "kind": "unknown",
                    "bbox": [0, 0, 0, 0],
                    "mask": { "path": "/a/b.png" },
                    "confidence": 1.0,
                    "locked": true,
                },
            ],
            "split_report": { "engine_version": "layer-split-stub/0.1" },
        });
        let manifest = layered_asset_manifest(&asset);
        assert_eq!(manifest["asset_id"], "layered-n1");
        assert_eq!(manifest["engine_version"], "layer-split-stub/0.1");
        assert_eq!(manifest["composite_preview"], "/a/b.png");
        let layers = manifest["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0]["name"], "original image");
        assert_eq!(layers[0]["alpha"], "/a/b.png");
        assert_eq!(layers[0]["locked"], true);
        assert_eq!(layers[0]["bbox"], json!([0, 0, 0, 0]));
    }

    #[test]
    fn requires_an_image_or_layered_asset() {
        let node = StudioGraphNode {
            id: "n1".to_string(),
            kind: "psdExport".to_string(),
            params: BTreeMap::new(),
        };
        let err = execute_studio_psd_export(&node, &BTreeMap::new()).unwrap_err();
        assert!(err.contains("image or layered asset"), "{err}");
    }
}
