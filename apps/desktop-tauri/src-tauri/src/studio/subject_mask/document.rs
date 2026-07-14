use std::collections::BTreeSet;

use image::imageops;
use serde_json::{json, Value};

use super::PointPrompt;

pub(super) fn parse_edit_paths(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Object(_)) => value.cloned(),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(text).ok()
        }
        _ => None,
    }
}

/// Trimap unknown-band strokes painted by the Image Editor "Matting" tool, read
/// from `edit_paths.matte_strokes` (same shape as `brush_strokes`: a polyline +
/// radius). Each becomes a disc-stamped band the matter resolves into soft
/// alpha. Empty ⇒ matting only runs when the `alpha_matting` flag is set.
pub(super) fn parse_matte_strokes(edit_paths: Option<&Value>) -> Vec<(Vec<(f32, f32)>, u32)> {
    let Some(value) = parse_edit_paths(edit_paths) else {
        return Vec::new();
    };
    value
        .get("matte_strokes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|stroke| {
            let points = parse_points(stroke.get("points"));
            if points.is_empty() {
                return None;
            }
            let radius = stroke
                .get("radius")
                .and_then(Value::as_f64)
                .unwrap_or(8.0)
                .max(0.0) as u32;
            Some((points, radius))
        })
        .collect()
}

pub(super) fn parse_points(value: Option<&Value>) -> Vec<(f32, f32)> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Value::Array(pair) if pair.len() >= 2 => {
                Some((json_f32(Some(&pair[0]))?, json_f32(Some(&pair[1]))?))
            }
            Value::Object(_) => Some((json_f32(item.get("x"))?, json_f32(item.get("y"))?)),
            _ => None,
        })
        .collect()
}

pub(super) fn json_f32(value: Option<&Value>) -> Option<f32> {
    value.and_then(Value::as_f64).map(|n| n as f32)
}

pub(super) fn normalise_edit_paths(value: Option<&Value>) -> Value {
    migrate_edit_paths(parse_edit_paths(value).unwrap_or_else(|| json!({})))
}

pub(super) fn migrate_edit_paths(value: Value) -> Value {
    let arr = |key: &str| -> Vec<Value> {
        value
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            if value.get("layers").and_then(Value::as_array).is_some() {
                3
            } else if let Some(ops) = value.get("ops").and_then(Value::as_array) {
                if ops.iter().any(|op| {
                    op.get("type").and_then(Value::as_str) == Some("wand")
                        && op.get("x").and_then(Value::as_f64).is_some()
                        && op.get("y").and_then(Value::as_f64).is_some()
                }) {
                    1
                } else {
                    2
                }
            } else {
                1
            }
        });
    if version >= 3 {
        let layer_groups = normalise_layer_groups(value.get("layerGroups"));
        let group_ids: BTreeSet<String> = layer_groups
            .iter()
            .filter_map(|group| group.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let layers: Vec<Value> = arr("layers")
            .into_iter()
            .filter_map(|layer| normalise_layer(layer, &group_ids))
            .collect();
        let active = if layers.is_empty() {
            -1
        } else {
            value
                .get("active")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .clamp(0, layers.len() as i64 - 1)
        };
        let mut doc = json!({
            "version": 3,
            "layers": layers,
            "active": active,
            "matte_strokes": arr("matte_strokes"),
            "points": normalise_points(value.get("points")),
            "layerGroups": layer_groups,
        });
        if let Some(canvas) = normalise_canvas(value.get("canvas")) {
            doc["canvas"] = canvas;
        }
        if value.get("activeTarget").and_then(Value::as_str) == Some("mask")
            && active >= 0
            && doc["layers"][active as usize].get("mask").is_some()
        {
            doc["activeTarget"] = json!("mask");
        }
        return doc;
    }
    let ops: Vec<Value> = if version >= 2 {
        arr("ops")
    } else {
        let mut ops: Vec<Value> = Vec::new();
        for mut path in arr("paths") {
            if let Some(obj) = path.as_object_mut() {
                obj.insert("type".into(), json!("path"));
            }
            ops.push(path);
        }
        for op in arr("ops") {
            match op.get("type").and_then(Value::as_str) {
                Some("wand") => {
                    let (Some(x), Some(y)) = (json_u32(op.get("x")), json_u32(op.get("y"))) else {
                        continue;
                    };
                    let mut wand = json!({ "type": "wand", "region": [x, y] });
                    if let Some(tolerance) = op.get("tolerance").and_then(Value::as_i64) {
                        wand["amount"] = json!(tolerance.clamp(0, 255));
                    }
                    ops.push(wand);
                }
                Some("invert") => ops.push(json!({ "type": "invert" })),
                _ => {}
            }
        }
        for mut stroke in arr("brush_strokes") {
            if let Some(obj) = stroke.as_object_mut() {
                obj.insert("type".into(), json!("brush"));
            }
            ops.push(stroke);
        }
        ops.extend(arr("operations"));
        ops
    };
    let mut layer = empty_pixel_layer();
    layer["ops"] = json!(ops);
    json!({
        "version": 3,
        "layers": [layer],
        "active": 0,
        "matte_strokes": arr("matte_strokes"),
        "points": normalise_points(value.get("points")),
        "layerGroups": [],
    })
}

fn empty_pixel_layer() -> Value {
    json!({
        "name": "Background",
        "kind": "pixel",
        "blend": "normal",
        "opacity": 1.0,
        "visible": true,
        "ops": [],
    })
}

fn normalise_layer_groups(value: Option<&Value>) -> Vec<Value> {
    let Some(groups) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for group in groups {
        let Some(id) = group.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let Some(name) = group.get("name").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() || name.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let Some(color) = group.get("color").and_then(Value::as_str).filter(|color| {
            color.len() == 7
                && color.starts_with('#')
                && color.chars().skip(1).all(|ch| ch.is_ascii_hexdigit())
        }) else {
            continue;
        };
        out.push(json!({ "id": id, "name": name, "color": color.to_ascii_lowercase() }));
    }
    out
}

fn normalise_points(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|point| match point {
            Value::Array(pair) if pair.len() >= 2 => {
                pair[0].as_f64()?;
                pair[1].as_f64()?;
                let (x, y) = (pair[0].clone(), pair[1].clone());
                Some(json!({ "x": x, "y": y, "label": 1 }))
            }
            Value::Object(_) => {
                point.get("x")?.as_f64()?;
                point.get("y")?.as_f64()?;
                let (x, y) = (point.get("x")?.clone(), point.get("y")?.clone());
                let label = if point.get("label").and_then(Value::as_f64) == Some(0.0) {
                    0
                } else {
                    1
                };
                Some(json!({ "x": x, "y": y, "label": label }))
            }
            _ => None,
        })
        .collect()
}

fn normalise_layer_mask(value: Option<&Value>) -> Option<Value> {
    let mask = value?;
    if !mask.is_object() {
        return None;
    }
    let ops = mask
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = json!({
        "id": mask
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("mask"),
        "ops": ops,
    });
    if mask.get("disabled").and_then(Value::as_bool) == Some(true) {
        out["disabled"] = json!(true);
    }
    if mask.get("unlinked").and_then(Value::as_bool) == Some(true) {
        out["unlinked"] = json!(true);
    }
    Some(out)
}

fn normalise_layer(layer: Value, group_ids: &BTreeSet<String>) -> Option<Value> {
    if !layer.is_object() {
        return None;
    }
    let mut out = empty_pixel_layer();
    if let Some(id) = layer.get("id").and_then(Value::as_str) {
        out["id"] = json!(id);
    }
    if let Some(name) = layer.get("name").and_then(Value::as_str) {
        out["name"] = json!(name);
    }
    if let Some(blend @ ("normal" | "multiply" | "screen" | "darken" | "lighten" | "difference")) =
        layer.get("blend").and_then(Value::as_str)
    {
        out["blend"] = json!(blend);
    }
    if let Some(locked) = layer.get("locked").and_then(Value::as_bool) {
        if locked {
            out["locked"] = json!(true);
        }
    }
    if let Some(linked) = layer.get("linked").and_then(Value::as_bool) {
        if linked {
            out["linked"] = json!(true);
        }
    }
    if let Some(group_id) = layer.get("groupId").and_then(Value::as_str) {
        if group_ids.contains(group_id) {
            out["groupId"] = json!(group_id);
        }
    }
    if let Some(opacity) = layer.get("opacity").and_then(Value::as_f64) {
        out["opacity"] = json!(opacity.clamp(0.0, 1.0));
    }
    if let Some(visible) = layer.get("visible").and_then(Value::as_bool) {
        out["visible"] = json!(visible);
    }
    if let Some(ops) = layer.get("ops").and_then(Value::as_array) {
        out["ops"] = json!(ops);
    }
    if let Some(kind @ ("pixel" | "adjustment")) = layer.get("kind").and_then(Value::as_str) {
        out["kind"] = json!(kind);
    }
    if let Some(adjustment) = layer.get("adjustment") {
        out["adjustment"] = adjustment.clone();
    }
    if let Some(mask) = normalise_layer_mask(layer.get("mask")) {
        out["mask"] = mask;
    }
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CanvasSize {
    pub(super) w: u32,
    pub(super) h: u32,
    pub(super) resample: CanvasResample,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CanvasResample {
    Auto,
    Nearest,
    Bilinear,
    Bicubic,
}

impl CanvasSize {
    pub(super) fn filter(&self, src_w: u32, src_h: u32) -> imageops::FilterType {
        match self.resample {
            CanvasResample::Nearest => imageops::FilterType::Nearest,
            CanvasResample::Bilinear => imageops::FilterType::Triangle,
            CanvasResample::Bicubic => imageops::FilterType::CatmullRom,
            CanvasResample::Auto => {
                if self.w <= src_w && self.h <= src_h {
                    imageops::FilterType::Triangle
                } else {
                    imageops::FilterType::Lanczos3
                }
            }
        }
    }
}

impl CanvasResample {
    fn as_str(self) -> &'static str {
        match self {
            CanvasResample::Auto => "auto",
            CanvasResample::Nearest => "nearest",
            CanvasResample::Bilinear => "bilinear",
            CanvasResample::Bicubic => "bicubic",
        }
    }

    fn from_str(value: &str) -> CanvasResample {
        match value {
            "nearest" => CanvasResample::Nearest,
            "bilinear" => CanvasResample::Bilinear,
            "bicubic" => CanvasResample::Bicubic,
            _ => CanvasResample::Auto,
        }
    }
}

impl serde::Serialize for CanvasResample {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

fn normalise_canvas(value: Option<&Value>) -> Option<Value> {
    let canvas = parse_canvas_value(value?)?;
    Some(json!({ "w": canvas.w, "h": canvas.h, "resample": canvas.resample }))
}

pub(super) fn parse_canvas_size(edit_paths: Option<&Value>) -> Option<CanvasSize> {
    parse_canvas_value(parse_edit_paths(edit_paths)?.get("canvas")?)
}

fn parse_canvas_value(value: &Value) -> Option<CanvasSize> {
    let w = json_u32(value.get("w")).filter(|&w| w >= 1)?;
    let h = json_u32(value.get("h")).filter(|&h| h >= 1)?;
    let resample = value
        .get("resample")
        .and_then(Value::as_str)
        .map(CanvasResample::from_str)
        .unwrap_or(CanvasResample::Auto);
    Some(CanvasSize { w, h, resample })
}

pub(super) fn parse_point_prompts(edit_paths: Option<&Value>) -> Vec<PointPrompt> {
    let Some(value) = parse_edit_paths(edit_paths) else {
        return Vec::new();
    };
    value
        .get("points")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| match item {
            Value::Array(pair) if pair.len() >= 2 => Some(PointPrompt {
                x: json_u32(Some(&pair[0]))?,
                y: json_u32(Some(&pair[1]))?,
                positive: true,
            }),
            Value::Object(_) => Some(PointPrompt {
                x: json_u32(item.get("x"))?,
                y: json_u32(item.get("y"))?,
                positive: item.get("label").and_then(Value::as_f64) != Some(0.0),
            }),
            _ => None,
        })
        .collect()
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_f64)
        .filter(|n| *n >= 0.0)
        .map(|n| n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ImageDocumentFixtures {
        migration_cases: Vec<MigrationCase>,
    }

    #[derive(serde::Deserialize)]
    struct MigrationCase {
        name: String,
        input: Value,
        expected: Value,
    }

    fn image_document_fixtures() -> ImageDocumentFixtures {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../studio-ui/src/editor/imageDocumentContractFixtures.json"
        );
        let raw = std::fs::read_to_string(path).expect("image-document fixtures readable");
        serde_json::from_str(&raw).expect("image-document fixtures parse")
    }

    fn document_contract_summary(doc: &Value) -> Value {
        let layers = doc
            .get("layers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let layer_ops: Vec<Value> = layers
            .iter()
            .map(|layer| layer.get("ops").cloned().unwrap_or_else(|| json!([])))
            .collect();
        let layer_props: Vec<Value> = layers
            .iter()
            .map(|layer| {
                let mask = layer.get("mask").map(|mask| {
                    json!({
                        "ops": mask.get("ops").cloned().unwrap_or_else(|| json!([])),
                        "disabled": mask.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                        "unlinked": mask.get("unlinked").and_then(Value::as_bool).unwrap_or(false),
                    })
                });
                json!({
                    "name": layer.get("name").and_then(Value::as_str).unwrap_or("Background"),
                    "kind": layer.get("kind").and_then(Value::as_str).unwrap_or("pixel"),
                    "blend": layer.get("blend").and_then(Value::as_str).unwrap_or("normal"),
                    "opacity": layer.get("opacity").and_then(Value::as_f64).unwrap_or(1.0),
                    "visible": layer.get("visible").and_then(Value::as_bool).unwrap_or(true),
                    "locked": layer.get("locked").and_then(Value::as_bool).unwrap_or(false),
                    "linked": layer.get("linked").and_then(Value::as_bool).unwrap_or(false),
                    "groupId": layer.get("groupId").cloned().unwrap_or(Value::Null),
                    "adjustment": layer.get("adjustment").cloned().unwrap_or(Value::Null),
                    "mask": mask,
                })
            })
            .collect();
        json!({
            "version": doc.get("version").and_then(Value::as_i64).unwrap_or_default(),
            "layerCount": layers.len(),
            "active": doc.get("active").and_then(Value::as_i64).unwrap_or(-1),
            "layerOps": layer_ops,
            "layerProps": layer_props,
            "matteStrokes": doc
                .get("matte_strokes")
                .cloned()
                .unwrap_or_else(|| json!([])),
            "points": doc.get("points").cloned().unwrap_or_else(|| json!([])),
            "canvas": doc.get("canvas").cloned().unwrap_or(Value::Null),
            "layerGroups": doc.get("layerGroups").cloned().unwrap_or_else(|| json!([])),
            "activeTarget": doc
                .get("activeTarget")
                .and_then(Value::as_str)
                .unwrap_or("pixel"),
        })
    }

    #[test]
    fn parses_point_prompt_labels_with_legacy_fallback() {
        let value = json!({
            "points": [
                [10, 20],
                { "x": 30, "y": 40, "label": 0 },
                { "x": 5, "y": 6, "label": 1 },
                { "x": 7, "y": 8 }
            ]
        });
        let points = parse_point_prompts(Some(&value));
        assert_eq!(
            points,
            vec![
                PointPrompt {
                    x: 10,
                    y: 20,
                    positive: true
                },
                PointPrompt {
                    x: 30,
                    y: 40,
                    positive: false
                },
                PointPrompt {
                    x: 5,
                    y: 6,
                    positive: true
                },
                PointPrompt {
                    x: 7,
                    y: 8,
                    positive: true
                },
            ]
        );
    }

    #[test]
    fn normalise_edit_paths_defaults_to_versioned_envelope() {
        let value = normalise_edit_paths(None);
        assert_eq!(value.get("version").and_then(Value::as_i64), Some(3));
        assert_eq!(value["layers"].as_array().unwrap().len(), 1);
        assert_eq!(value["layers"][0]["ops"], json!([]));
        assert_eq!(value["layers"][0]["blend"], json!("normal"));
        assert_eq!(value["layers"][0]["visible"], json!(true));
        assert_eq!(value["matte_strokes"], json!([]));
        assert_eq!(value["points"], json!([]));
    }

    #[test]
    fn matches_the_shared_image_document_migration_contract() {
        let fixtures = image_document_fixtures();
        assert!(!fixtures.migration_cases.is_empty());
        for case in fixtures.migration_cases {
            let migrated = migrate_edit_paths(case.input);
            assert_eq!(
                document_contract_summary(&migrated),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn migrate_edit_paths_folds_version1_arrays_in_legacy_replay_order() {
        let legacy = json!({
            "version": 1,
            "paths": [{ "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
                        "points": [{ "x": 0, "y": 0 }, { "x": 4, "y": 0 }, { "x": 4, "y": 4 }] }],
            "ops": [{ "type": "wand", "x": 1, "y": 2, "tolerance": 300 }, { "type": "invert" }],
            "brush_strokes": [{ "id": "s1", "mode": "add", "radius": 3, "points": [[1, 1]] }],
            "matte_strokes": [{ "mode": "add", "radius": 2, "points": [[5, 5]] }],
            "operations": [{ "type": "feather", "amount": 2 }],
            "points": [[10, 20]]
        });
        let migrated = migrate_edit_paths(legacy);
        assert_eq!(migrated["version"], json!(3));
        let ops = &migrated["layers"][0]["ops"];
        let kinds: Vec<&str> = ops
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["path", "wand", "invert", "brush", "feather"]);
        assert_eq!(ops[1]["region"], json!([1, 2]));
        assert_eq!(ops[1]["amount"], json!(255));
        assert_eq!(migrated["matte_strokes"].as_array().unwrap().len(), 1);
        assert_eq!(
            migrated["points"],
            json!([{ "x": 10, "y": 20, "label": 1 }])
        );
    }

    #[test]
    fn migrate_edit_paths_preserves_canvas_size_request() {
        let doc = json!({
            "version": 3,
            "layers": [],
            "active": 0,
            "canvas": { "w": 320.4, "h": 200, "resample": "bicubic" }
        });
        let migrated = migrate_edit_paths(doc);
        assert_eq!(
            migrated["canvas"],
            json!({ "w": 320, "h": 200, "resample": "bicubic" })
        );
        let migrated = migrate_edit_paths(json!({ "version": 3, "canvas": { "w": 0, "h": 10 } }));
        assert!(migrated.get("canvas").is_none());
    }

    #[test]
    fn migrate_edit_paths_preserves_layer_group_metadata() {
        let doc = json!({
            "version": 3,
            "layerGroups": [
                { "id": "g1", "name": "Subject", "color": "#5aa7ff" },
                { "id": "skip-empty-name", "name": "", "color": "#000000" },
                { "id": "skip-bad-color", "name": "Bad", "color": "bad" },
                { "id": "g2", "name": "Light", "color": "#59c98f" }
            ],
            "layers": [
                { "name": "Background", "ops": [], "groupId": "g1" },
                { "name": "Top", "ops": [], "groupId": "g2" }
            ],
            "active": 1
        });
        let migrated = migrate_edit_paths(doc);
        assert_eq!(
            migrated["layerGroups"],
            json!([
                { "id": "g1", "name": "Subject", "color": "#5aa7ff" },
                { "id": "g2", "name": "Light", "color": "#59c98f" }
            ])
        );
        assert_eq!(migrated["layers"][0]["groupId"], json!("g1"));
        assert_eq!(migrated["layers"][1]["groupId"], json!("g2"));
        assert_eq!(
            migrated["layers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|layer| layer["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["Background", "Top"]
        );
    }

    #[test]
    fn parse_canvas_size_reads_document_request() {
        let doc = json!({ "version": 3, "canvas": { "w": 64, "h": 32, "resample": "nearest" } });
        let canvas = parse_canvas_size(Some(&doc)).unwrap();
        assert_eq!((canvas.w, canvas.h), (64, 32));
        assert_eq!(canvas.resample, CanvasResample::Nearest);
        assert_eq!(canvas.filter(128, 64), imageops::FilterType::Nearest);
        let doc = json!({ "canvas": { "w": 64, "h": 32, "resample": "mystery" } });
        let canvas = parse_canvas_size(Some(&doc)).unwrap();
        assert_eq!(canvas.filter(128, 64), imageops::FilterType::Triangle);
        assert_eq!(canvas.filter(32, 16), imageops::FilterType::Lanczos3);
        assert_eq!(parse_canvas_size(Some(&json!({ "version": 3 }))), None);
    }
}
