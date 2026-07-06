//! `smartLayerSplit` compute node: subject/background separation plus optional
//! multi-object instancing, text/logo region detection and shadow/reflection
//! candidates (docs/plans/completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md,
//! Phases 1–3), plus video-frame ingress (Phase 5): a connected video input
//! is resolved to the still nearest `frame_sec` through the media engine
//! before splitting.
//!
//! Splits a flat image into a `LayeredImageAsset` — a locked original layer
//! plus real background/subject candidates whose masks come from the shared
//! subject segmentation stack (`subject_segment`): a model backend (BiRefNet /
//! U²-Netp) when a weight resolves, else the deterministic weight-free builtin
//! CPU segmenter, so the node works end-to-end without any downloads. Layer
//! mask + RGBA cutout PNGs are written to the output directory. Keep the JSON
//! shape in lock-step with the TS mirror in
//! `studio-ui/src/production/layeredImage.ts` (the browser preview keeps the
//! placeholder stub — segmentation only runs in the desktop runtime).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{GrayImage, Luma};
use serde_json::{json, Value};

use super::graph::{
    bool_param, number_param, studio_output_map, studio_value_to_string, StudioGraphNode,
};
use super::persist::studio_reject_unsafe_basename;
use super::pixel_ops;
use super::studio_image;
use super::subject_sam2::Sam2Variant;
use super::subject_segment::{segmenter_for_mode, AutoMode, SegmentRequest};

/// Engine tag prefix recorded in `split_report.engine_version`; the segmenter
/// provider is appended (e.g. `layer-split/0.2 (builtin-cpu)`).
const LAYER_SPLIT_ENGINE: &str = "layer-split/0.2";

/// Provider id of the weight-free fallback segmenter (mirrors
/// `subject_segment::BuiltinCpuSegmenter::provider`). Its candidates are
/// low-confidence and flagged for review; a model backend's are not.
const BUILTIN_PROVIDER: &str = "builtin-cpu";

const ORIGINAL_LAYER_ID: &str = "layer_original";
const BACKGROUND_LAYER_ID: &str = "layer_background";
const SUBJECT_LAYER_ID: &str = "layer_subject";

/// A mask pixel at least half-opaque counts as selected for bbox / inversion
/// (mirrors `subject_mask::SELECTED_THRESHOLD`).
const SELECTED_THRESHOLD: u8 = 128;

/// A connected component must cover at least this fraction of the canvas to
/// become its own object instance layer; smaller blobs stay in the combined
/// subject candidate only.
const MIN_INSTANCE_AREA_FRACTION: f64 = 0.002;

/// Upper bound on emitted object instance layers (largest first); anything
/// beyond stays in the combined subject candidate and is reported as a warning.
const MAX_INSTANCES: usize = 8;

/// `[x1, y1, x2, y2]` extents of the selected pixels, or `[0, 0, 0, 0]` when
/// the mask is empty (the protocol's "unknown" bbox).
pub(crate) fn mask_bbox(mask: &GrayImage) -> [u32; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut any = false;
    for (x, y, pixel) in mask.enumerate_pixels() {
        if pixel.0[0] >= SELECTED_THRESHOLD {
            any = true;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if any {
        [x0, y0, x1, y1]
    } else {
        [0, 0, 0, 0]
    }
}

/// Split a subject mask into per-object instance masks via 4-connected
/// components over the selected pixels. Components are returned largest-first;
/// blobs below [`MIN_INSTANCE_AREA_FRACTION`] of the canvas are dropped and
/// at most [`MAX_INSTANCES`] are kept. Each instance mask preserves the
/// original (soft) mask values inside its component.
pub(crate) fn instance_masks(mask: &GrayImage) -> Vec<GrayImage> {
    let (width, height) = mask.dimensions();
    let total = u64::from(width) * u64::from(height);
    if total == 0 {
        return Vec::new();
    }
    let min_area = ((total as f64 * MIN_INSTANCE_AREA_FRACTION).ceil() as u64).max(1);
    let index = |x: u32, y: u32| (y * width + x) as usize;
    let mut label: Vec<u32> = vec![0; total as usize];
    let mut components: Vec<(u64, GrayImage)> = Vec::new();
    let mut next = 0u32;
    let mut stack: Vec<(u32, u32)> = Vec::new();
    for y in 0..height {
        for x in 0..width {
            if mask.get_pixel(x, y).0[0] < SELECTED_THRESHOLD || label[index(x, y)] != 0 {
                continue;
            }
            next += 1;
            let mut area = 0u64;
            let mut instance = GrayImage::from_pixel(width, height, Luma([0]));
            stack.push((x, y));
            label[index(x, y)] = next;
            while let Some((cx, cy)) = stack.pop() {
                area += 1;
                instance.put_pixel(cx, cy, *mask.get_pixel(cx, cy));
                let neighbours = [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ];
                for (nx, ny) in neighbours {
                    if nx < width
                        && ny < height
                        && label[index(nx, ny)] == 0
                        && mask.get_pixel(nx, ny).0[0] >= SELECTED_THRESHOLD
                    {
                        label[index(nx, ny)] = next;
                        stack.push((nx, ny));
                    }
                }
            }
            if area >= min_area {
                components.push((area, instance));
            }
        }
    }
    components.sort_by(|a, b| b.0.cmp(&a.0));
    components.truncate(MAX_INSTANCES);
    components.into_iter().map(|(_, mask)| mask).collect()
}

fn invert_mask(mask: &GrayImage) -> GrayImage {
    let mut out = mask.clone();
    for pixel in out.pixels_mut() {
        *pixel = Luma([255 - pixel.0[0]]);
    }
    out
}

fn save_mask(mask: &GrayImage, path: &Path) -> Result<(), String> {
    mask.save(path)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn image_stem(path: &str) -> String {
    Path::new(path.trim())
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string())
}

pub(crate) fn execute_studio_smart_layer_split(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let image_input = inputs
        .get("image")
        .map(|value| studio_value_to_string(Some(value)))
        .unwrap_or_default();
    let video_input = inputs
        .get("video")
        .map(|value| studio_value_to_string(Some(value)))
        .unwrap_or_default();
    if image_input.trim().is_empty() && video_input.trim().is_empty() {
        return Err("Smart Layer Split needs a connected image or video input".to_string());
    }

    let output_dir = {
        let configured = studio_value_to_string(node.params.get("output_dir"));
        if configured.trim().is_empty() {
            crate::runtime_paths()?
                .output_dir
                .to_string_lossy()
                .to_string()
        } else {
            configured
        }
    };
    let dir = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;

    // Phase 5 video ingress: resolve a connected video to the still nearest
    // `frame_sec` (decoded through the shared media engine) and split that
    // frame; the video input wins when both are connected.
    let mut frame_source_note: Option<String> = None;
    let image_path = if !video_input.trim().is_empty() {
        let video = Path::new(video_input.trim());
        if !video.is_file() {
            return Err(format!("video does not exist: {}", video.display()));
        }
        let frame_sec = number_param(node, "frame_sec", 0.0).max(0.0);
        let ms = (frame_sec * 1000.0).round() as i64;
        let frame_path = dir.join(format!("{}_f{ms}", image_stem(&video_input)));
        let frame_path = frame_path.with_extension("png");
        let mut source = super::video_engine::make_frame_source();
        let written = source.decode_frame(video, frame_sec, &frame_path)?;
        frame_source_note = Some(format!(
            "still frame extracted from {} at {frame_sec}s — masks apply to this frame only",
            video.display()
        ));
        written.to_string_lossy().to_string()
    } else {
        image_input
    };

    let loaded = studio_image::load_working(
        Path::new(image_path.trim()),
        studio_image::DEFAULT_MAX_DECODE_PIXELS,
    )?;
    let working = loaded.image;
    let (width, height) = (working.width, working.height);
    let srgb = working.to_srgb_rgba8();

    // Segment the subject with the shared stack: a model backend when its
    // weight resolves, else the deterministic builtin CPU fallback.
    let segmenter = segmenter_for_mode(AutoMode::Subject, &[], Sam2Variant::default());
    let provider = segmenter.provider().to_string();
    let segmented = segmenter.segment(&SegmentRequest {
        image: &srgb,
        mode: AutoMode::Subject,
        placeholder: None,
        prompt: None,
        points: &[],
    })?;
    let subject_mask = segmented.mask;
    let background_mask = invert_mask(&subject_mask);

    let base = {
        let configured = studio_value_to_string(node.params.get("output_name"));
        if configured.trim().is_empty() {
            format!("{}_split", image_stem(&image_path))
        } else {
            configured.trim().to_string()
        }
    };
    studio_reject_unsafe_basename(&base)?;

    let subject_mask_path = dir.join(format!("{base}_subject_mask.png"));
    let subject_rgba_path = dir.join(format!("{base}_subject.png"));
    let background_mask_path = dir.join(format!("{base}_background_mask.png"));
    let background_rgba_path = dir.join(format!("{base}_background.png"));

    save_mask(&subject_mask, &subject_mask_path)?;
    save_mask(&background_mask, &background_mask_path)?;
    let subject_rgba = pixel_ops::apply_alpha_mask_working(&working, &subject_mask);
    studio_image::write_working_output(&subject_rgba_path, &subject_rgba)?;
    let background_rgba = pixel_ops::apply_alpha_mask_working(&working, &background_mask);
    studio_image::write_working_output(&background_rgba_path, &background_rgba)?;

    // Phase 2 instancing: split the subject mask into per-object layers via
    // connected components when requested.
    let instancing = {
        let raw = studio_value_to_string(node.params.get("instancing"));
        if raw.is_empty() {
            "off".to_string()
        } else {
            raw
        }
    };
    let instances = if instancing == "auto" {
        instance_masks(&subject_mask)
    } else {
        Vec::new()
    };

    // Phase 3 text regions: detect likely text lines so the Review Editor can
    // mark them protected when editing the surrounding pixels.
    let detect_text = bool_param(node, "detect_text", false);
    let text_regions = if detect_text {
        super::text_regions::text_region_masks(&srgb)
    } else {
        Vec::new()
    };

    // Phase 3 logo regions: compact high-contrast marks near the canvas
    // border, kept as protected candidates. Regions already claimed as text
    // are dropped — the text candidate wins the overlap.
    let detect_logo = bool_param(node, "detect_logo", false);
    let logo_regions: Vec<GrayImage> = if detect_logo {
        let text_bboxes: Vec<[u32; 4]> = text_regions.iter().map(mask_bbox).collect();
        super::text_regions::logo_region_masks(&srgb)
            .into_iter()
            .filter(|mask| {
                let [x0, y0, x1, y1] = mask_bbox(mask);
                !text_bboxes
                    .iter()
                    .any(|&[tx0, ty0, tx1, ty1]| x0 <= tx1 && x1 >= tx0 && y0 <= ty1 && y1 >= ty0)
            })
            .collect()
    } else {
        Vec::new()
    };

    let subject_bbox = mask_bbox(&subject_mask);

    // Phase 3 shadow candidate: a background region darker than the
    // background baseline next to the subject, kept as its own layer so it
    // can be preserved or regenerated separately.
    let detect_shadow = bool_param(node, "detect_shadow", false);
    let shadow_region = if detect_shadow {
        super::shadow_regions::shadow_region_mask(&srgb, &background_mask, subject_bbox)
    } else {
        None
    };

    // Phase 3 reflection candidate: a dimmer vertically mirrored copy of the
    // subject on the surface directly below it, kept as its own layer so it
    // can be preserved or regenerated separately.
    let detect_reflection = bool_param(node, "detect_reflection", false);
    let reflection_region = if detect_reflection {
        super::reflection_regions::reflection_region_mask(&srgb, &background_mask, subject_bbox)
    } else {
        None
    };

    let is_builtin = provider == BUILTIN_PROVIDER;
    // The weight-free fallback is a colour heuristic — keep its candidates
    // low-confidence and flagged for review; a model matte is trusted more.
    let confidence = if is_builtin { 0.4 } else { 0.75 };

    let source_image = json!({ "path": image_path, "width": width, "height": height });
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let candidate_note = format!("segmented by {provider}");
    let mut layers = vec![
        json!({
            "id": ORIGINAL_LAYER_ID,
            "name": "original image",
            "kind": "unknown",
            "bbox": [0, 0, width, height],
            "mask": source_image,
            "rgba": source_image,
            "confidence": 1.0,
            "source": "algorithm",
            "visible": true,
            "locked": true,
            "notes": ["locked original"],
        }),
        json!({
            "id": BACKGROUND_LAYER_ID,
            "name": "background candidate",
            "kind": "background",
            "bbox": [0, 0, width, height],
            "mask": { "path": background_mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": background_rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": confidence,
            "source": if is_builtin { "algorithm" } else { "model" },
            "visible": true,
            "notes": [candidate_note.clone()],
        }),
        json!({
            "id": SUBJECT_LAYER_ID,
            "name": "subject candidate",
            "kind": "subject",
            "bbox": subject_bbox,
            "mask": { "path": subject_mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": subject_rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": confidence,
            "source": if is_builtin { "algorithm" } else { "model" },
            "visible": true,
            "notes": [candidate_note.clone()],
        }),
    ];

    let mut warnings: Vec<Value> = Vec::new();
    let mut suggested_review: Vec<Value> = Vec::new();
    if let Some(note) = &frame_source_note {
        warnings.push(json!(note));
    }
    let review = |layer_id: &str, message: &str| json!({ "layer_id": layer_id, "severity": "warning", "message": message });
    if is_builtin {
        warnings.push(json!("builtin CPU segmentation (no model weight resolved)"));
        for id in [BACKGROUND_LAYER_ID, SUBJECT_LAYER_ID] {
            suggested_review.push(review(
                id,
                "builtin CPU heuristic mask — review before production use",
            ));
        }
    }

    // Instance layers are always lower-confidence than the combined subject:
    // connected components can merge touching objects or split one object, so
    // every instance is flagged for review.
    let instance_confidence = (confidence - 0.15_f64).max(0.1);
    for (n, instance_mask) in instances.iter().enumerate() {
        let ordinal = n + 1;
        let layer_id = format!("layer_object_{ordinal}");
        let mask_path = dir.join(format!("{base}_object_{ordinal}_mask.png"));
        let rgba_path = dir.join(format!("{base}_object_{ordinal}.png"));
        save_mask(instance_mask, &mask_path)?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, instance_mask);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        layers.push(json!({
            "id": layer_id,
            "name": format!("object {ordinal}"),
            "kind": "object",
            "bbox": mask_bbox(instance_mask),
            "mask": { "path": mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": instance_confidence,
            "source": if is_builtin { "algorithm" } else { "model" },
            "visible": true,
            "notes": [format!("instance {ordinal} of the subject mask (connected component)")],
        }));
        suggested_review.push(review(
            &layer_id,
            "auto instance — verify it is one object (merge/split if needed)",
        ));
    }
    // Text regions are filled-bbox candidates from a weight-free heuristic:
    // low-confidence, marked protected, and always flagged for review.
    for (n, region_mask) in text_regions.iter().enumerate() {
        let ordinal = n + 1;
        let layer_id = format!("layer_text_{ordinal}");
        let mask_path = dir.join(format!("{base}_text_{ordinal}_mask.png"));
        let rgba_path = dir.join(format!("{base}_text_{ordinal}.png"));
        save_mask(region_mask, &mask_path)?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, region_mask);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        layers.push(json!({
            "id": layer_id,
            "name": format!("text region {ordinal}"),
            "kind": "text",
            "bbox": mask_bbox(region_mask),
            "mask": { "path": mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": 0.3,
            "source": "algorithm",
            "visible": true,
            "protected": true,
            "notes": ["protected: likely text — keep when editing surrounding layers"],
        }));
        suggested_review.push(review(
            &layer_id,
            "heuristic text region — verify before relying on protection",
        ));
    }
    if detect_text && text_regions.is_empty() {
        warnings.push(json!("text detection found no text-like regions"));
    }
    // Logo regions mirror the text candidates: protected, low-confidence,
    // always flagged for review.
    for (n, region_mask) in logo_regions.iter().enumerate() {
        let ordinal = n + 1;
        let layer_id = format!("layer_logo_{ordinal}");
        let mask_path = dir.join(format!("{base}_logo_{ordinal}_mask.png"));
        let rgba_path = dir.join(format!("{base}_logo_{ordinal}.png"));
        save_mask(region_mask, &mask_path)?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, region_mask);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        layers.push(json!({
            "id": layer_id,
            "name": format!("logo region {ordinal}"),
            "kind": "logo",
            "bbox": mask_bbox(region_mask),
            "mask": { "path": mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": 0.3,
            "source": "algorithm",
            "visible": true,
            "protected": true,
            "notes": ["protected: likely logo / brand mark — keep when editing surrounding layers"],
        }));
        suggested_review.push(review(
            &layer_id,
            "heuristic logo region — verify before relying on protection",
        ));
    }
    if detect_logo && logo_regions.is_empty() {
        warnings.push(json!(
            "logo detection found no mark-like regions near the canvas border"
        ));
    }
    // The shadow candidate is a weight-free luminance heuristic: low
    // confidence and always flagged for review.
    if let Some(shadow_mask) = &shadow_region {
        let layer_id = "layer_shadow";
        let mask_path = dir.join(format!("{base}_shadow_mask.png"));
        let rgba_path = dir.join(format!("{base}_shadow.png"));
        save_mask(shadow_mask, &mask_path)?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, shadow_mask);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        layers.push(json!({
            "id": layer_id,
            "name": "shadow candidate",
            "kind": "shadow",
            "bbox": mask_bbox(shadow_mask),
            "mask": { "path": mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": 0.3,
            "source": "algorithm",
            "visible": true,
            "notes": ["cast-shadow candidate — keep with the subject or regenerate separately"],
        }));
        suggested_review.push(review(
            layer_id,
            "heuristic shadow region — verify it belongs to the subject",
        ));
    }
    if detect_shadow && shadow_region.is_none() {
        warnings.push(json!(
            "shadow detection found no shadow-like region next to the subject"
        ));
    }
    // The reflection candidate is a weight-free mirrored-luminance heuristic:
    // low confidence and always flagged for review.
    if let Some(reflection_mask) = &reflection_region {
        let layer_id = "layer_reflection";
        let mask_path = dir.join(format!("{base}_reflection_mask.png"));
        let rgba_path = dir.join(format!("{base}_reflection.png"));
        save_mask(reflection_mask, &mask_path)?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, reflection_mask);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        layers.push(json!({
            "id": layer_id,
            "name": "reflection candidate",
            "kind": "reflection",
            "bbox": mask_bbox(reflection_mask),
            "mask": { "path": mask_path.to_string_lossy(), "width": width, "height": height },
            "rgba": { "path": rgba_path.to_string_lossy(), "width": width, "height": height },
            "confidence": 0.3,
            "source": "algorithm",
            "visible": true,
            "notes": ["reflection candidate — keep with the subject or regenerate separately"],
        }));
        suggested_review.push(review(
            layer_id,
            "heuristic reflection region — verify it mirrors the subject",
        ));
    }
    if detect_reflection && reflection_region.is_none() {
        warnings.push(json!(
            "reflection detection found no mirror-like region below the subject"
        ));
    }
    if instancing == "auto" && instances.is_empty() {
        warnings.push(json!(
            "instancing found no components above the minimum area — only the combined subject is available"
        ));
    }
    let layers = json!(layers);
    let (warnings, suggested_review) = (json!(warnings), json!(suggested_review));
    let asset = json!({
        "id": format!("layered-{}", node.id),
        "source_asset_id": if video_input.trim().is_empty() { image_path.clone() } else { video_input.trim().to_string() },
        "source_node_id": node.id,
        "canvas": { "width": width, "height": height, "color_space": "srgb" },
        "base_image": source_image,
        "preview_composite": source_image,
        "layers": layers,
        "split_report": {
            "engine_version": format!("{LAYER_SPLIT_ENGINE} ({provider})"),
            "created_at": created_at,
            "warnings": warnings,
            "suggested_review": suggested_review,
        },
    });

    let selected_kind = {
        let raw = studio_value_to_string(node.params.get("selected_kind"));
        if raw.is_empty() {
            "subject".to_string()
        } else {
            raw
        }
    };
    let layer_list = asset["layers"].as_array().cloned().unwrap_or_default();
    let selected = layer_list
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
    let masks: Vec<Value> = layer_list
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
    use image::{Rgba, RgbaImage};

    fn node(root: &Path, params: &[(&str, Value)]) -> StudioGraphNode {
        let mut map: BTreeMap<String, Value> = params
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        map.insert(
            "output_dir".to_string(),
            json!(root.to_string_lossy().to_string()),
        );
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "smartLayerSplit".to_string(),
            params: map,
        }
    }

    fn temp_scene(tag: &str) -> (PathBuf, String) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_{tag}_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A grey scene with a red block: the builtin segmenter picks the block
        // as the subject.
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(12, 12, Rgba([120, 120, 120, 255]));
        for y in 4..8 {
            for x in 4..8 {
                image.put_pixel(x, y, Rgba([220, 20, 20, 255]));
            }
        }
        image.save(&image_path).unwrap();
        (root, image_path.to_string_lossy().to_string())
    }

    #[test]
    fn requires_a_connected_image() {
        let root = std::env::temp_dir();
        let err =
            execute_studio_smart_layer_split(&node(&root, &[]), &BTreeMap::new()).unwrap_err();
        assert!(err.contains("connected image or video"), "{err}");
    }

    #[test]
    fn video_input_must_exist_on_disk() {
        let root = std::env::temp_dir();
        let mut inputs = BTreeMap::new();
        inputs.insert("video".to_string(), json!("/no/such/clip.mp4"));
        let err = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap_err();
        assert!(err.contains("video does not exist"), "{err}");
    }

    #[test]
    fn emits_the_segmented_asset_and_flat_ports() {
        let (root, image_path) = temp_scene("asset");
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path));
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let asset = &out["layered_asset"];
        assert_eq!(asset["id"], "layered-n1");
        assert_eq!(asset["base_image"]["path"], image_path.as_str());
        assert_eq!(asset["canvas"]["width"], 12);
        assert_eq!(asset["canvas"]["height"], 12);
        let layers = asset["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0]["locked"], true);
        assert_eq!(layers[1]["kind"], "background");
        assert_eq!(layers[2]["kind"], "subject");
        // Real per-layer artifacts are written to the output dir.
        for layer in &layers[1..] {
            let mask = layer["mask"]["path"].as_str().unwrap();
            let rgba = layer["rgba"]["path"].as_str().unwrap();
            assert!(Path::new(mask).is_file(), "missing mask {mask}");
            assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
        }
        // The subject bbox tracks the segmented block, not the whole canvas.
        let bbox = layers[2]["bbox"].as_array().unwrap();
        assert_ne!(bbox[..], [json!(0), json!(0), json!(0), json!(0)][..]);
        let engine = asset["split_report"]["engine_version"].as_str().unwrap();
        assert!(engine.starts_with("layer-split/"), "{engine}");
        assert_eq!(out["composite_preview"], image_path.as_str());
        assert_eq!(out["masks"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn selected_kind_original_picks_the_locked_layer() {
        let (root, image_path) = temp_scene("original");
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("selected_kind", json!("original"))]),
            &inputs,
        )
        .unwrap();
        assert_eq!(out["selected_layer"], image_path.as_str());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn instancing_auto_emits_per_object_layers() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_instances_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A grey scene with a red block. The builtin fallback segmenter keeps
        // a single largest component, so instancing yields one object layer
        // here; multi-object masks (model backends) yield one layer per
        // component — covered by `instance_masks_splits_components_and_drops_specks`.
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(16, 16, Rgba([120, 120, 120, 255]));
        for y in 2..6 {
            for x in 2..6 {
                image.put_pixel(x, y, Rgba([220, 20, 20, 255]));
            }
        }
        image.save(&image_path).unwrap();
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path.to_string_lossy()));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("instancing", json!("auto"))]),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let objects: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "object")
            .collect();
        assert_eq!(objects.len(), 1, "{layers:?}");
        assert_eq!(objects[0]["id"], "layer_object_1");
        assert_eq!(objects[0]["name"], "object 1");
        for object in &objects {
            let mask = object["mask"]["path"].as_str().unwrap();
            let rgba = object["rgba"]["path"].as_str().unwrap();
            assert!(Path::new(mask).is_file(), "missing mask {mask}");
            assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
            let bbox = object["bbox"].as_array().unwrap();
            assert_ne!(bbox[..], [json!(0), json!(0), json!(0), json!(0)][..]);
        }
        // Every instance is flagged for review.
        let review = out["layered_asset"]["split_report"]["suggested_review"]
            .as_array()
            .unwrap()
            .clone();
        for object in &objects {
            assert!(
                review.iter().any(|issue| issue["layer_id"] == object["id"]),
                "no review issue for {}",
                object["id"]
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn instancing_off_keeps_the_phase_1_layers() {
        let (root, image_path) = temp_scene("off");
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path));
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 3);
        assert!(layers.iter().all(|layer| layer["kind"] != "object"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_text_emits_protected_text_layers() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_text_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A light canvas with a row of small dark "glyph" strokes: the
        // heuristic detector picks the line up as one text region.
        let image_path = root.join("poster.png");
        let mut image = RgbaImage::from_pixel(100, 60, Rgba([245, 245, 245, 255]));
        for g in 0..15u32 {
            let gx = 10 + g * 4;
            for y in 20..25 {
                for x in gx..gx + 2 {
                    image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
                }
            }
        }
        image.save(&image_path).unwrap();
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path.to_string_lossy()));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("detect_text", json!(true))]),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let texts: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "text")
            .collect();
        assert_eq!(texts.len(), 1, "expected one text layer in {layers:?}");
        let review = out["layered_asset"]["split_report"]["suggested_review"]
            .as_array()
            .unwrap()
            .clone();
        for text in &texts {
            assert_eq!(text["id"], "layer_text_1");
            assert_eq!(text["source"], "algorithm");
            assert_eq!(text["protected"], true);
            let notes = text["notes"].as_array().unwrap();
            assert!(notes[0].as_str().unwrap().starts_with("protected:"));
            let mask = text["mask"]["path"].as_str().unwrap();
            let rgba = text["rgba"]["path"].as_str().unwrap();
            assert!(Path::new(mask).is_file(), "missing mask {mask}");
            assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
            assert!(
                review.iter().any(|issue| issue["layer_id"] == text["id"]),
                "no review issue for {}",
                text["id"]
            );
        }
        // Without the param, no text layers are emitted.
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap();
        assert!(layers.iter().all(|layer| layer["kind"] != "text"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_logo_emits_protected_logo_layers() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_logo_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A light canvas with a compact grid of dark strokes in the corner:
        // the heuristic detector picks it up as one mark.
        let image_path = root.join("packshot.png");
        let mut image = RgbaImage::from_pixel(100, 100, Rgba([245, 245, 245, 255]));
        for row in 0..3u32 {
            for g in 0..3u32 {
                let gx = 4 + g * 4;
                let gy = 4 + row * 5;
                for y in gy..gy + 5 {
                    for x in gx..gx + 2 {
                        image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
                    }
                }
            }
        }
        image.save(&image_path).unwrap();
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path.to_string_lossy()));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("detect_logo", json!(true))]),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let logos: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "logo")
            .collect();
        assert_eq!(logos.len(), 1, "expected one logo layer in {layers:?}");
        let review = out["layered_asset"]["split_report"]["suggested_review"]
            .as_array()
            .unwrap()
            .clone();
        let logo = logos[0];
        assert_eq!(logo["id"], "layer_logo_1");
        assert_eq!(logo["source"], "algorithm");
        assert_eq!(logo["protected"], true);
        let notes = logo["notes"].as_array().unwrap();
        assert!(notes[0].as_str().unwrap().starts_with("protected:"));
        let mask = logo["mask"]["path"].as_str().unwrap();
        let rgba = logo["rgba"]["path"].as_str().unwrap();
        assert!(Path::new(mask).is_file(), "missing mask {mask}");
        assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
        assert!(
            review
                .iter()
                .any(|issue| issue["layer_id"] == "layer_logo_1"),
            "no review issue for the logo layer"
        );
        // With text detection on too, a region claimed as text is not
        // duplicated as a logo.
        let out = execute_studio_smart_layer_split(
            &node(
                &root,
                &[("detect_logo", json!(true)), ("detect_text", json!(true))],
            ),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let text_bboxes: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "text")
            .map(|layer| layer["bbox"].clone())
            .collect();
        for logo in layers.iter().filter(|layer| layer["kind"] == "logo") {
            assert!(
                !text_bboxes.contains(&logo["bbox"]),
                "logo duplicates a text region: {logo:?}"
            );
        }
        // Without the param, no logo layers are emitted.
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap();
        assert!(layers.iter().all(|layer| layer["kind"] != "logo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_shadow_emits_a_shadow_candidate_layer() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_shadow_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A light scene with a saturated red subject block and a mid-dark
        // patch right beside it: the builtin segmenter picks the block as the
        // subject, the luminance heuristic picks the patch as its shadow.
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        for y in 20..40 {
            for x in 20..32 {
                image.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        for y in 34..42 {
            for x in 33..48 {
                image.put_pixel(x, y, Rgba([110, 110, 110, 255]));
            }
        }
        image.save(&image_path).unwrap();
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path.to_string_lossy()));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("detect_shadow", json!(true))]),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let shadows: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "shadow")
            .collect();
        let warnings = out["layered_asset"]["split_report"]["warnings"]
            .as_array()
            .unwrap()
            .clone();
        if let [shadow] = shadows.as_slice() {
            assert_eq!(shadow["id"], "layer_shadow");
            assert_eq!(shadow["source"], "algorithm");
            let mask = shadow["mask"]["path"].as_str().unwrap();
            let rgba = shadow["rgba"]["path"].as_str().unwrap();
            assert!(Path::new(mask).is_file(), "missing mask {mask}");
            assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
            let review = out["layered_asset"]["split_report"]["suggested_review"]
                .as_array()
                .unwrap()
                .clone();
            assert!(
                review
                    .iter()
                    .any(|issue| issue["layer_id"] == "layer_shadow"),
                "no review issue for the shadow layer"
            );
        } else {
            // The builtin segmenter may claim the dark patch as subject; the
            // node must then report the empty detection instead of a layer.
            assert!(shadows.is_empty());
            assert!(
                warnings
                    .iter()
                    .any(|w| w.as_str().unwrap_or_default().contains("shadow detection")),
                "no shadow warning in {warnings:?}"
            );
        }
        // Without the param, no shadow layer and no shadow warning.
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap();
        assert!(layers.iter().all(|layer| layer["kind"] != "shadow"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_reflection_emits_a_reflection_candidate_layer() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_split_reflection_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        // A light scene with a saturated red subject block and a dimmer
        // mirrored copy directly below it: the builtin segmenter picks the
        // block as the subject, the mirrored-luminance heuristic picks the
        // copy as its reflection.
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        for y in 10..30 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([200, 40, 40, 255]));
            }
        }
        for y in 30..50 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([120, 24, 24, 255]));
            }
        }
        image.save(&image_path).unwrap();
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!(image_path.to_string_lossy()));
        let out = execute_studio_smart_layer_split(
            &node(&root, &[("detect_reflection", json!(true))]),
            &inputs,
        )
        .unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap().clone();
        let reflections: Vec<_> = layers
            .iter()
            .filter(|layer| layer["kind"] == "reflection")
            .collect();
        let warnings = out["layered_asset"]["split_report"]["warnings"]
            .as_array()
            .unwrap()
            .clone();
        if let [reflection] = reflections.as_slice() {
            assert_eq!(reflection["id"], "layer_reflection");
            assert_eq!(reflection["source"], "algorithm");
            let mask = reflection["mask"]["path"].as_str().unwrap();
            let rgba = reflection["rgba"]["path"].as_str().unwrap();
            assert!(Path::new(mask).is_file(), "missing mask {mask}");
            assert!(Path::new(rgba).is_file(), "missing rgba {rgba}");
            let review = out["layered_asset"]["split_report"]["suggested_review"]
                .as_array()
                .unwrap()
                .clone();
            assert!(
                review
                    .iter()
                    .any(|issue| issue["layer_id"] == "layer_reflection"),
                "no review issue for the reflection layer"
            );
        } else {
            // The builtin segmenter may claim the mirrored copy as subject;
            // the node must then report the empty detection instead.
            assert!(reflections.is_empty());
            assert!(
                warnings.iter().any(|w| w
                    .as_str()
                    .unwrap_or_default()
                    .contains("reflection detection")),
                "no reflection warning in {warnings:?}"
            );
        }
        // Without the param, no reflection layer and no reflection warning.
        let out = execute_studio_smart_layer_split(&node(&root, &[]), &inputs).unwrap();
        let layers = out["layered_asset"]["layers"].as_array().unwrap();
        assert!(layers.iter().all(|layer| layer["kind"] != "reflection"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn instance_masks_splits_components_and_drops_specks() {
        let mut mask = GrayImage::from_pixel(32, 32, Luma([0]));
        for y in 2..10 {
            for x in 2..10 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        for y in 20..30 {
            for x in 20..30 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        // A 1px speck below the minimum area fraction is dropped.
        mask.put_pixel(0, 31, Luma([255]));
        let instances = instance_masks(&mask);
        assert_eq!(instances.len(), 2);
        // Largest-first ordering: the 10x10 block precedes the 8x8 block.
        assert_eq!(mask_bbox(&instances[0]), [20, 20, 29, 29]);
        assert_eq!(mask_bbox(&instances[1]), [2, 2, 9, 9]);
    }

    #[test]
    fn mask_bbox_tracks_extents_and_handles_empty() {
        let mut mask = GrayImage::from_pixel(8, 8, Luma([0]));
        assert_eq!(mask_bbox(&mask), [0, 0, 0, 0]);
        mask.put_pixel(2, 3, Luma([255]));
        mask.put_pixel(5, 6, Luma([255]));
        assert_eq!(mask_bbox(&mask), [2, 3, 5, 6]);
    }
}
