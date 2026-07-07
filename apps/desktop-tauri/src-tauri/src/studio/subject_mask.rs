//! The `subjectMask` node executor: the first Studio card whose image
//! processing runs in-process in native Rust (the `Compute` executor lane)
//! rather than shelling out to a `python/bridge` CLI.
//!
//! Phase 1 is CPU-only and deterministic: it builds a subject matte from a base
//! mask (a connected `previous_mask` / `placeholder_mask`, else empty) plus the
//! manual edits carried in `edit_paths` (magic-wand flood fill, brush / eraser
//! strokes), then applies morphology (`grow` / `shrink`, `fill_holes`) and a
//! final feather. It emits the mask / alpha image / cutout triplet and an
//! enriched `matte_report`. The auto-subject model modes are Phase 2 (still on
//! the `Compute` lane, via `ort` / `candle`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::{imageops, GrayImage, Luma, Rgba, RgbaImage};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Value};

use super::graph::{
    bool_param, number_param, optional, studio_output_map, studio_value_to_string, StudioGraphNode,
};
use super::image_buffer;
use super::persist::studio_reject_unsafe_basename;
use super::pixel_ops;
use super::studio_image;
use super::subject_matte;
use super::subject_sam2::Sam2Variant;
use super::subject_segment::{segmenter_for_mode, AutoMode, PointPrompt, SegmentRequest};
use super::working_image::WorkingImage;

const MASK_ON: u8 = 255;
const MASK_OFF: u8 = 0;
/// A pixel counts as "selected" for coverage / bbox once it is at least
/// half-opaque.
const SELECTED_THRESHOLD: u8 = 128;

/// The flat enriched report mirrored onto the `matte_report` output port. Mirrors
/// the enriched-report convention used across the PSD chain (`source_mode`,
/// `exif_transposed`, `max_decode_pixels`, `processing_time_ms`, triplet
/// completeness).
#[derive(Debug, Serialize)]
struct MatteReport {
    mode: String,
    provider: String,
    /// Engine telemetry (GPU_DEVICE_STRATEGY_PLAN shared DeviceReport
    /// vocabulary), present only when an `auto_*` mode ran a segmenter:
    /// `onnxruntime` for the model backends, `cpu` for the builtin fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    engine: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_requested: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_fallback_reason: Option<String>,
    /// The weight file(s) inference ran on; absent for weight-free lanes
    /// (manual/hybrid and the builtin fallback segmenter).
    #[serde(skip_serializing_if = "Option::is_none")]
    model_path: Option<String>,
    source_mode: String,
    exif_transposed: bool,
    max_decode_pixels: u64,
    image_size: [u32; 2],
    mask_coverage: f64,
    detected_subjects: Vec<Value>,
    operations: Vec<Value>,
    triplet: Triplet,
    processing_time_ms: u128,
}

#[derive(Debug, Serialize)]
struct Triplet {
    mask: bool,
    alpha_image: bool,
    cutout_image: bool,
}

pub(super) fn execute_studio_subject_mask(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
    skip_write_ports: &std::collections::HashSet<String>,
) -> Result<BTreeMap<String, Value>, String> {
    let started = Instant::now();

    let image_path = studio_value_to_string(inputs.get("image"));
    if image_path.trim().is_empty() {
        return Err("Subject Mask needs a connected image input".to_string());
    }

    let max_decode_pixels = {
        let configured = number_param(node, "max_decode_pixels", -1.0);
        if configured < 0.0 {
            studio_image::DEFAULT_MAX_DECODE_PIXELS
        } else {
            configured as u64
        }
    };

    // Load the 16-bit canonical surface so the RGBA cutout / alpha products
    // carry through at full precision (a wide-gamut ProPhoto input, or an
    // upstream manual card's published surface, stays wide-gamut end-to-end).
    // Every model / analysis ingress — the auto segmenter, the matter, the
    // wand-select and the grayscale morphology — runs on the 8-bit sRGB egress
    // (`to_srgb_rgba8`), consistent with P3; only the cutout / alpha RGBA
    // outputs walk the 16-bit `working` surface.
    let loaded = studio_image::load_working(Path::new(image_path.trim()), max_decode_pixels)?;
    let working = loaded.image;
    let (width, height) = (working.width, working.height);
    let image = working.to_srgb_rgba8();

    let mode = param_or(node, "mode", "hybrid");
    let auto_mode = AutoMode::from_mode(&mode);
    let mut operations: Vec<Value> = Vec::new();
    let mut detected_subjects: Vec<Value> = Vec::new();
    // `rust-native` for the manual / hybrid lanes; an `auto_*` mode reports the
    // segmenter that produced its base matte (today the builtin fallback).
    let mut provider = "rust-native".to_string();
    let mut engine: Option<&'static str> = None;
    let mut engine_fallback_reason: Option<String> = None;
    // The node's `device` param: the requested execution device for the ONNX
    // lane (`auto` when unset). Recorded on the report whenever a segmenter
    // ran, so a request is never silently dropped.
    let device_request =
        super::onnx_pool::OnnxDeviceRequest::from_param(&param_or(node, "device", "auto"));
    let mut engine_device: Option<&'static str> = None;
    let mut model_path: Option<String> = None;

    let placeholder = match optional(studio_value_to_string(inputs.get("placeholder_mask"))) {
        Some(path) => Some(load_mask_sized(&path, width, height, max_decode_pixels)?),
        None => None,
    };

    // Base mask: continue a prior mask; else for an `auto_*` mode segment a base
    // matte from the image; else seed from a PSD placeholder; else start empty
    // (a fully transparent matte is a valid result).
    let mut mask = match optional(studio_value_to_string(inputs.get("previous_mask"))) {
        Some(path) => load_mask_sized(&path, width, height, max_decode_pixels)?,
        None => match auto_mode {
            Some(auto) => {
                let prompt = optional(studio_value_to_string(inputs.get("prompt")));
                let points = parse_point_prompts(inputs.get("edit_paths"));
                let sam2_variant = Sam2Variant::from_param(&param_or(node, "sam2_variant", "tiny"));
                let segmenter = segmenter_for_mode(auto, &points, sam2_variant);
                let result = segmenter.segment(&SegmentRequest {
                    image: &image,
                    mode: auto,
                    placeholder: placeholder.as_ref(),
                    prompt: prompt.as_deref(),
                    points: &points,
                })?;
                provider = segmenter.provider().to_string();
                model_path = segmenter.model_path();
                if provider == "builtin-cpu" {
                    engine = Some("cpu");
                    engine_device = Some("cpu");
                    engine_fallback_reason = Some(
                        "no ONNX segmentation weights resolved; deterministic builtin CPU segmenter"
                            .to_string(),
                    );
                } else {
                    // Resolve the requested device against the providers this
                    // build carries: cpu is honoured (no reason), cuda/auto
                    // fall back with distinct visible reasons.
                    let resolution = super::onnx_pool::resolve_provider(device_request);
                    engine = Some("onnxruntime");
                    engine_device = Some(resolution.device);
                    engine_fallback_reason = resolution.fallback_reason;
                }
                detected_subjects = result.detected_subjects;
                operations.push(json!({
                    "type": "auto_segment",
                    "mode": mode,
                    "provider": provider,
                }));
                result.mask
            }
            None => match &placeholder {
                Some(seed) => seed.clone(),
                None => GrayImage::from_pixel(width, height, Luma([MASK_OFF])),
            },
        },
    };

    let wand_tolerance = number_param(node, "wand_tolerance", 24.0).clamp(0.0, 255.0) as i32;

    apply_edit_paths(
        &image,
        &mut mask,
        inputs.get("edit_paths"),
        wand_tolerance,
        &mut operations,
    );

    if bool_param(node, "fill_holes", false) {
        fill_holes(&mut mask);
        operations.push(json!({ "type": "fill_holes" }));
    }

    let grow_px = number_param(node, "grow_px", 0.0) as i32;
    if grow_px > 0 {
        mask = dilate(&mask, grow_px as u32);
        operations.push(json!({ "type": "grow", "px": grow_px }));
    } else if grow_px < 0 {
        mask = erode(&mask, grow_px.unsigned_abs());
        operations.push(json!({ "type": "shrink", "px": grow_px.abs() }));
    }

    // Continuous alpha matting: resolve the binary edge into soft alpha (hair /
    // glass / translucency) via a trimap. Off by default so Phase 1 stays
    // binary + deterministic; behind the flag (or whenever the Mask-Edit
    // "Matting" brush painted an unknown band) it runs ViTMatte when its weight
    // resolves, else the deterministic builtin guided-filter fallback.
    // The trimap that drove matting, kept so the downstream Refine node can
    // protect the *unknown* band (genuine hair / fur / glass soft alpha) from
    // its erode / feather edge clean-up instead of treating it as fringe.
    let mut matting_trimap: Option<GrayImage> = None;
    let matte_strokes = parse_matte_strokes(inputs.get("edit_paths"));
    if bool_param(node, "alpha_matting", false) || !matte_strokes.is_empty() {
        let band = number_param(node, "matting_band_px", 12.0).max(0.0) as u32;
        let mut trimap = subject_matte::trimap_from_mask(&mask, band);
        // Hand-painted unknown band: stamp the strokes as the trimap unknown
        // level on top of the auto ring, so the matter resolves soft alpha
        // exactly where the user marked hair / fur / glass.
        for (points, radius) in &matte_strokes {
            stamp_stroke(&mut trimap, points, *radius, subject_matte::TRIMAP_UNKNOWN);
        }
        let matter = subject_matte::matter();
        let matte_provider = matter.provider().to_string();
        mask = matter.matte(&image, &trimap)?;
        operations.push(json!({
            "type": "alpha_matting",
            "provider": matte_provider,
            "band_px": band,
            "painted_strokes": matte_strokes.len(),
        }));
        matting_trimap = Some(trimap);
    }

    let feather_px = number_param(node, "feather_px", 0.0).max(0.0);
    if feather_px > 0.0 {
        mask = imageops::blur(&mask, feather_px as f32);
        operations.push(json!({ "type": "feather", "px": feather_px }));
    }

    // PS Image Size (Ctrl+Alt+I): the document-level `canvas` on `edit_paths`
    // requests an output pixel size; resample the working surface and the mask
    // together so every product (mask / alpha / cutout) lands at that size.
    let mut working = working;
    let (mut width, mut height) = (width, height);
    if let Some(canvas) = parse_canvas_size(inputs.get("edit_paths")) {
        if (canvas.w, canvas.h) != (width, height) {
            let filter = canvas.filter(width, height);
            working = pixel_ops::resize_working(&working, canvas.w, canvas.h, filter);
            mask = pixel_ops::resize_gray(&mask, canvas.w, canvas.h, filter);
            operations.push(json!({
                "type": "image_size",
                "from": [width, height],
                "to": [canvas.w, canvas.h],
                "resample": canvas.resample,
            }));
            width = canvas.w;
            height = canvas.h;
        }
    }

    let coverage = mask_coverage(&mask);
    let alpha_image = compose_alpha(&working, &mask);
    let cutout = cutout_to_bbox(&alpha_image, &mask);

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
    let base = {
        let configured = studio_value_to_string(node.params.get("output_name"));
        if configured.trim().is_empty() {
            format!("{}_mask", image_stem(&image_path))
        } else {
            configured.trim().to_string()
        }
    };
    studio_reject_unsafe_basename(&base)?;

    let dir = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;
    let mask_path = dir.join(format!("{base}.png"));
    let alpha_path = dir.join(format!("{base}_alpha.png"));
    let cutout_path = dir.join(format!("{base}_cutout.png"));
    let paths_path = dir.join(format!("{base}_paths.json"));

    // Persist the matting trimap (FG / unknown / BG levels) when matting ran, so
    // the Refine node can hand-protect the unknown band. Empty string otherwise.
    let trimap_out = match &matting_trimap {
        Some(trimap) => {
            let trimap_path = dir.join(format!("{base}_trimap.png"));
            if skip_write_ports.contains("trimap") && !trimap_path.exists() {
                image_buffer::publish_gray_deferred(&trimap_path, trimap);
            } else {
                save_png(&DynamicGray(trimap), &trimap_path)?;
                image_buffer::publish_gray(&trimap_path, trimap);
            }
            trimap_path.to_string_lossy().to_string()
        }
        None => String::new(),
    };

    // For each image output, skip the PNG encode+write when graph analysis
    // proved every consumer resolves it from the in-process buffer (another
    // compute card) — publishing a *deferred* surface that is
    // materialised only if evicted. Otherwise write the file and publish a
    // file-backed buffer as before (a `refineMaskEdge`/`psdExport` consumer, an
    // exported artifact, or the returned result all read the PNG). The
    // `!exists()` guard keeps a stale prior file from lingering behind a buffer.
    if skip_write_ports.contains("mask") && !mask_path.exists() {
        image_buffer::publish_gray_deferred(&mask_path, &mask);
    } else {
        save_png(&DynamicGray(&mask), &mask_path)?;
        image_buffer::publish_gray(&mask_path, &mask);
    }
    // The RGBA cutout / alpha products walk the 16-bit canonical surface: an
    // `Srgb` surface lands as the exact 8-bit PNG written before (byte-
    // identical), a `ProPhoto` surface as 16-bit RGBA PNG with the ProPhoto
    // profile embedded (`icc_preserved: true`), which the loader rebuilds at
    // full precision on reload. `write_working_output` picks PNG (the fixed
    // `.png` extension here) and publishes the native surface so a downstream
    // compute card skips the re-decode; the deferred variant is materialised
    // only if evicted, exactly as the 8-bit path did.
    if skip_write_ports.contains("alpha_image") && !alpha_path.exists() {
        image_buffer::publish_working_deferred(
            &alpha_path,
            &alpha_image,
            studio_image::png_output_meta(),
        );
    } else {
        studio_image::write_working_output(&alpha_path, &alpha_image)?;
        image_buffer::publish_working(&alpha_path, &alpha_image, studio_image::png_output_meta());
    }
    if skip_write_ports.contains("cutout_image") && !cutout_path.exists() {
        image_buffer::publish_working_deferred(
            &cutout_path,
            &cutout,
            studio_image::png_output_meta(),
        );
    } else {
        studio_image::write_working_output(&cutout_path, &cutout)?;
        image_buffer::publish_working(&cutout_path, &cutout, studio_image::png_output_meta());
    }

    let edit_paths_value = normalise_edit_paths(inputs.get("edit_paths"));
    std::fs::write(
        &paths_path,
        serde_json::to_vec_pretty(&edit_paths_value)
            .map_err(|err| format!("failed to encode edit_paths: {err}"))?,
    )
    .map_err(|err| format!("failed to write {}: {err}", paths_path.display()))?;

    let report = MatteReport {
        mode,
        provider,
        engine,
        device: engine_device,
        device_requested: engine.map(|_| device_request.as_str()),
        engine_fallback_reason,
        model_path,
        source_mode: loaded.meta.source_mode.clone(),
        exif_transposed: loaded.meta.exif_transposed,
        max_decode_pixels,
        image_size: [width, height],
        mask_coverage: coverage,
        detected_subjects,
        operations,
        // "available" (buffer-or-file), not strictly `is_file`: a skipped write
        // leaves the surface resident in the buffer with no PNG, yet the output
        // still resolves for every reader.
        triplet: Triplet {
            mask: image_buffer::is_available(&mask_path),
            alpha_image: image_buffer::is_available(&alpha_path),
            cutout_image: image_buffer::is_available(&cutout_path),
        },
        processing_time_ms: started.elapsed().as_millis(),
    };
    let report = serde_json::to_value(&report)
        .map_err(|err| format!("failed to encode matte_report: {err}"))?;

    Ok(studio_output_map([
        ("mask", json!(mask_path.to_string_lossy())),
        ("alpha_image", json!(alpha_path.to_string_lossy())),
        ("cutout_image", json!(cutout_path.to_string_lossy())),
        ("trimap", json!(trimap_out)),
        ("matte_report", report),
        ("edit_paths", edit_paths_value),
    ]))
}

fn param_or(node: &StudioGraphNode, key: &str, default: &str) -> String {
    match optional(studio_value_to_string(node.params.get(key))) {
        Some(value) => value,
        None => default.to_string(),
    }
}

fn image_stem(path: &str) -> String {
    Path::new(path.trim())
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string())
}

fn load_mask_sized(
    path: &str,
    width: u32,
    height: u32,
    max_pixels: u64,
) -> Result<GrayImage, String> {
    let mask = studio_image::load_mask(Path::new(path.trim()), max_pixels)?;
    Ok(pixel_ops::resize_gray(
        &mask,
        width,
        height,
        imageops::FilterType::Nearest,
    ))
}

// --- pure mask operations (unit-tested without disk) -----------------------

/// Apply the manual edits recorded in `edit_paths` by compositing the
/// document's layer stack (see `docs/design/ps-editor-architecture.md`, M3).
/// The bottom layer's ordered `ops` stack replays directly onto the base mask
/// — so a single-layer document rasterises byte-identically to the pre-M3
/// flow — while layers above replay onto an empty surface and composite per
/// blend mode + opacity. A version-1 / version-2 value is migrated to a
/// single-layer document first, preserving the legacy replay order, so old
/// workflows rasterise identically. Unknown entries are ignored.
fn apply_edit_paths(
    image: &RgbaImage,
    mask: &mut GrayImage,
    edit_paths: Option<&Value>,
    default_tolerance: i32,
    operations: &mut Vec<Value>,
) {
    let Some(value) = parse_edit_paths(edit_paths) else {
        return;
    };
    let value = migrate_edit_paths(value);

    for (index, layer) in value
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if layer.get("visible").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        // Adjustment layers (M6) carry no edit stack: they tone-map the
        // composite below them per a 256-entry LUT, lerped by opacity.
        if layer.get("kind").and_then(Value::as_str) == Some("adjustment") {
            if let Some(adjustment) = layer.get("adjustment") {
                let opacity = layer
                    .get("opacity")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0);
                apply_adjustment(mask, adjustment, opacity, operations);
            }
            continue;
        }
        let ops = layer.get("ops");
        if index == 0 {
            replay_ops(image, mask, ops, default_tolerance, operations);
        } else if ops
            .and_then(Value::as_array)
            .is_none_or(|list| list.is_empty())
        {
            // A content-less upper layer (PS: fully transparent) composites
            // nothing; blending its empty surface would wipe the layers below.
            continue;
        } else {
            // Upper layers replay from an empty surface, so their result is a
            // pure function of (dims, ops, tolerance[, image for wand]) and is
            // cached across runs (M7): re-running after editing one layer
            // skips the full replay of every other layer.
            let key =
                replay_cache::layer_key(mask.width(), mask.height(), ops, default_tolerance, image);
            let (surface, log) = match replay_cache::get(key) {
                Some(hit) => hit,
                None => {
                    let mut surface =
                        GrayImage::from_pixel(mask.width(), mask.height(), Luma([MASK_OFF]));
                    let mut log = Vec::new();
                    replay_ops(image, &mut surface, ops, default_tolerance, &mut log);
                    replay_cache::put(key, surface.clone(), log.clone());
                    (surface, log)
                }
            };
            operations.extend(log);
            let blend = layer
                .get("blend")
                .and_then(Value::as_str)
                .unwrap_or("normal");
            let opacity = layer
                .get("opacity")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .clamp(0.0, 1.0);
            blend_layer(mask, &surface, blend, opacity);
            operations.push(json!({
                "type": "layer_composite",
                "blend": blend,
                "opacity": opacity,
            }));
        }
    }
}

/// Process-global LRU of replayed upper-layer surfaces (M7 performance layer;
/// the run-side counterpart of the frontend `ProxyLayerCache`). An upper
/// layer's replay starts from an empty surface, so its result is fully
/// determined by the cache key; the entry stores the surface *and* the ops it
/// logged so a hit reproduces an identical `matte_report`. Bounded to a few
/// entries — full-resolution surfaces are megabytes each — mirroring the
/// `image_buffer` LRU this grows out of.
mod replay_cache {
    use std::sync::{Mutex, OnceLock};

    use image::{GrayImage, RgbaImage};
    use serde_json::Value;

    const CAPACITY: usize = 4;

    struct Entry {
        key: u64,
        surface: GrayImage,
        log: Vec<Value>,
    }

    static CACHE: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();

    fn cache() -> &'static Mutex<Vec<Entry>> {
        CACHE.get_or_init(|| Mutex::new(Vec::new()))
    }

    /// FNV-1a over `bytes`, chained from `hash`.
    fn fnv1a(mut hash: u64, bytes: &[u8]) -> u64 {
        for b in bytes {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        hash
    }

    /// Cache key for one upper layer's replay: dims + tolerance + the ops
    /// JSON, plus a fingerprint of the source pixels when the stack contains
    /// an op that reads the image (wand family / quick selection /
    /// background eraser).
    pub(super) fn layer_key(
        width: u32,
        height: u32,
        ops: Option<&Value>,
        default_tolerance: i32,
        image: &RgbaImage,
    ) -> u64 {
        let mut hash = fnv1a(0xcbf2_9ce4_8422_2325, &width.to_le_bytes());
        hash = fnv1a(hash, &height.to_le_bytes());
        hash = fnv1a(hash, &default_tolerance.to_le_bytes());
        let ops_json = ops.map(Value::to_string).unwrap_or_default();
        hash = fnv1a(hash, ops_json.as_bytes());
        let has_wand = ops
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|op| {
                matches!(
                    op.get("type").and_then(Value::as_str),
                    Some(
                        "wand"
                            | "quick_select"
                            | "background_eraser"
                            | "red_eye"
                            | "object_select"
                            | "remove"
                    )
                )
            });
        if has_wand {
            hash = fnv1a(hash, image.as_raw());
        }
        hash
    }

    pub(super) fn get(key: u64) -> Option<(GrayImage, Vec<Value>)> {
        let mut lru = cache().lock().ok()?;
        let pos = lru.iter().position(|e| e.key == key)?;
        let entry = lru.remove(pos);
        let hit = (entry.surface.clone(), entry.log.clone());
        lru.push(entry); // most-recently used at the back
        Some(hit)
    }

    pub(super) fn put(key: u64, surface: GrayImage, log: Vec<Value>) {
        let Ok(mut lru) = cache().lock() else {
            return;
        };
        if let Some(pos) = lru.iter().position(|e| e.key == key) {
            lru.remove(pos);
        }
        lru.push(Entry { key, surface, log });
        while lru.len() > CAPACITY {
            lru.remove(0);
        }
    }
}

/// Apply an adjustment layer's tone map to the composite in place (M6):
/// build the 256-entry LUT for its params and lerp each pixel toward the
/// mapped value by the layer `opacity`.
fn apply_adjustment(
    mask: &mut GrayImage,
    adjustment: &Value,
    opacity: f64,
    operations: &mut Vec<Value>,
) {
    let Some(kind) = adjustment.get("type").and_then(Value::as_str) else {
        return;
    };
    let Some(lut) = adjustment_lut(kind, adjustment) else {
        return;
    };
    for p in mask.pixels_mut() {
        let v = f64::from(p.0[0]);
        let mapped = f64::from(lut[p.0[0] as usize]);
        p.0[0] = (v + (mapped - v) * opacity).round().clamp(0.0, 255.0) as u8;
    }
    operations.push(json!({
        "type": "adjustment",
        "kind": kind,
        "opacity": opacity,
    }));
}

/// Build the 256-entry LUT an adjustment layer's params resolve to. Mirrors
/// `adjustmentLut` in `maskMorphology.ts` exactly, so the proxy preview and
/// the run cannot drift. Unknown kinds return `None` (ignored).
fn adjustment_lut(kind: &str, adjustment: &Value) -> Option<[u8; 256]> {
    let field = |key: &str, default: f64| {
        adjustment
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or(default)
    };
    let mut lut = [0u8; 256];
    match kind {
        "levels" => {
            let in_black = field("in_black", 0.0).clamp(0.0, 255.0);
            let in_white = field("in_white", 255.0).clamp(0.0, 255.0);
            let gamma = field("gamma", 1.0).max(1e-6);
            let out_black = field("out_black", 0.0).clamp(0.0, 255.0);
            let out_white = field("out_white", 255.0).clamp(0.0, 255.0);
            let span = (in_white - in_black).max(1e-6);
            for (v, out) in lut.iter_mut().enumerate() {
                let t = ((v as f64 - in_black) / span)
                    .clamp(0.0, 1.0)
                    .powf(1.0 / gamma);
                *out = (out_black + t * (out_white - out_black))
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
        "curve" => {
            let mut pts: Vec<(f64, f64)> = adjustment
                .get("points")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?))
                })
                .collect();
            pts.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (v, out) in lut.iter_mut().enumerate() {
                let v = v as f64;
                *out = if pts.len() < 2 {
                    v as u8
                } else if v <= pts[0].0 {
                    pts[0].1.round().clamp(0.0, 255.0) as u8
                } else if v >= pts[pts.len() - 1].0 {
                    pts[pts.len() - 1].1.round().clamp(0.0, 255.0) as u8
                } else {
                    let i = pts
                        .iter()
                        .position(|p| p.0 >= v)
                        .unwrap_or(pts.len() - 1)
                        .max(1);
                    let (x0, y0) = pts[i - 1];
                    let (x1, y1) = pts[i];
                    let t = (v - x0) / (x1 - x0).max(1e-6);
                    (y0 + t * (y1 - y0)).round().clamp(0.0, 255.0) as u8
                };
            }
        }
        "brightness_contrast" => {
            let brightness = field("brightness", 0.0).clamp(-100.0, 100.0) / 100.0 * 255.0;
            let slope = 1.0 + field("contrast", 0.0).clamp(-100.0, 100.0) / 100.0;
            for (v, out) in lut.iter_mut().enumerate() {
                *out = ((v as f64 - 127.5) * slope + 127.5 + brightness)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
        _ => return None,
    }
    Some(lut)
}

/// One blended sample per the layer blend mode (grayscale 0..255; mirrors the
/// TS `blendValue` in `maskMorphology.ts` so the preview cannot drift).
fn blend_value(dv: f64, sv: f64, blend: &str) -> f64 {
    match blend {
        "multiply" => dv * sv / 255.0,
        "screen" => 255.0 - (255.0 - dv) * (255.0 - sv) / 255.0,
        "darken" => dv.min(sv),
        "lighten" => dv.max(sv),
        "difference" => (dv - sv).abs(),
        _ => sv,
    }
}

/// Composite the layer `surface` onto `dst` in place per the layer blend mode,
/// lerped by the layer `opacity`. Grayscale surfaces (0..255); mirrors the
/// proxy compositor in `maskMorphology.ts` so the preview cannot drift from
/// the run.
fn blend_layer(dst: &mut GrayImage, src: &GrayImage, blend: &str, opacity: f64) {
    for (d, s) in dst.pixels_mut().zip(src.pixels()) {
        let dv = f64::from(d.0[0]);
        let sv = f64::from(s.0[0]);
        d.0[0] = (dv + (blend_value(dv, sv, blend) - dv) * opacity)
            .round()
            .clamp(0.0, 255.0) as u8;
    }
}

/// The marquee selection recorded on an edit step (`clip`): image-space
/// `[x1, y1, x2, y2]`, elliptical when `ellipse`.
fn parse_clip(op: &Value) -> Option<(Vec<f64>, bool)> {
    let clip = op.get("clip")?;
    let region: Vec<f64> = clip
        .get("region")?
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    if region.len() < 4 {
        return None;
    }
    let ellipse = clip.get("ellipse").and_then(Value::as_bool) == Some(true);
    Some((region, ellipse))
}

/// Confine a replayed step to its recorded marquee selection (PS selection
/// semantics): pixels outside the clip region are restored from the pre-step
/// mask. Mirrors the TS `restoreOutsideClip` in `maskMorphology.ts`.
fn restore_outside_clip(mask: &mut GrayImage, before: &GrayImage, region: &[f64], ellipse: bool) {
    let x1 = region[0].min(region[2]);
    let y1 = region[1].min(region[3]);
    let x2 = region[0].max(region[2]);
    let y2 = region[1].max(region[3]);
    let cx = (x1 + x2) / 2.0;
    let cy = (y1 + y2) / 2.0;
    let rx = ((x2 - x1) / 2.0).max(0.5);
    let ry = ((y2 - y1) / 2.0).max(0.5);
    for (x, y, p) in mask.enumerate_pixels_mut() {
        let px = f64::from(x) + 0.5;
        let py = f64::from(y) + 0.5;
        let mut inside = px >= x1 && px <= x2 && py >= y1 && py <= y2;
        if inside && ellipse {
            let nx = (px - cx) / rx;
            let ny = (py - cy) / ry;
            inside = nx * nx + ny * ny <= 1.0;
        }
        if !inside {
            p.0[0] = before.get_pixel(x, y).0[0];
        }
    }
}

/// Replay one layer's ordered `ops` stack (see M1): pen / lasso vector paths
/// (rasterised and boolean-combined), brush / eraser strokes, and the queued
/// magic-wand / marquee / morphology operations, in recorded order.
fn replay_ops(
    image: &RgbaImage,
    mask: &mut GrayImage,
    ops: Option<&Value>,
    default_tolerance: i32,
    operations: &mut Vec<Value>,
) {
    // The layer's pre-edit state, the history brush's restore source (only
    // snapshotted when the stack contains a `history_brush` step).
    let base = ops
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|op| {
            matches!(
                op.get("type").and_then(Value::as_str),
                Some("history_brush" | "art_history_brush")
            )
        })
        .then(|| mask.clone());
    for op in ops.and_then(Value::as_array).into_iter().flatten() {
        // Disabled history steps stay recorded but are skipped on replay.
        if op.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        // A step recorded while a marquee selection was active carries it as
        // `clip`: the step's effect is confined to the selection.
        let clip = parse_clip(op);
        let before = clip.as_ref().map(|_| mask.clone());
        match op.get("type").and_then(Value::as_str) {
            Some("path") => {
                let Some(path) = parse_mask_path(op) else {
                    continue;
                };
                apply_mask_path(mask, &path);
                operations.push(json!({
                    "type": format!("path_{}", path.mode.as_str()),
                    "tool": path.tool,
                    "points": path.polygon.len(),
                }));
            }
            Some("brush") => {
                let subtract = op.get("mode").and_then(Value::as_str) == Some("subtract");
                let radius = op
                    .get("radius")
                    .and_then(Value::as_f64)
                    .unwrap_or(8.0)
                    .max(0.0) as u32;
                let points = parse_points(op.get("points"));
                if points.is_empty() {
                    continue;
                }
                let field = |key: &str, default: f64| {
                    op.get(key)
                        .and_then(Value::as_f64)
                        .unwrap_or(default)
                        .clamp(0.0, 1.0) as f32
                };
                let hardness = field("hardness", 1.0);
                let flow = field("flow", 1.0);
                if hardness < 1.0 || flow < 1.0 {
                    // Soft brush (M4): graded coverage stamps. Legacy hard
                    // strokes take the byte-identical fast path below.
                    let spacing = field("spacing", 0.25).max(0.01);
                    stamp_stroke_soft(mask, &points, radius, hardness, flow, spacing, subtract);
                    operations.push(json!({
                        "type": if subtract { "brush_subtract" } else { "brush_add" },
                        "radius": radius,
                        "hardness": hardness,
                        "flow": flow,
                    }));
                } else {
                    stamp_stroke(
                        mask,
                        &points,
                        radius,
                        if subtract { MASK_OFF } else { MASK_ON },
                    );
                    operations.push(json!({
                        "type": if subtract { "brush_subtract" } else { "brush_add" },
                        "radius": radius,
                    }));
                }
            }
            Some("history_brush") => {
                // History brush (M13): restore the stroke coverage to the
                // layer's pre-edit state. `amount` is the brush radius;
                // `points` the stroke polyline.
                let Some(base) = base.as_ref() else {
                    continue;
                };
                let radius = op
                    .get("amount")
                    .and_then(Value::as_f64)
                    .unwrap_or(8.0)
                    .max(1.0) as u32;
                let points = parse_points(op.get("points"));
                if points.is_empty() {
                    continue;
                }
                let (w, h) = mask.dimensions();
                let mut coverage = GrayImage::new(w, h);
                stamp_stroke(&mut coverage, &points, radius, MASK_ON);
                history_region(mask, base, &coverage);
                operations.push(json!({ "type": "history_brush", "radius": radius }));
            }
            Some("art_history_brush") => {
                // Art history brush (M16): restore the stroke coverage to the
                // layer's pre-edit state through a deterministic per-pixel
                // jitter, giving the stylised smeared look.
                let Some(base) = base.as_ref() else {
                    continue;
                };
                let radius = op
                    .get("amount")
                    .and_then(Value::as_f64)
                    .unwrap_or(8.0)
                    .max(1.0) as u32;
                let points = parse_points(op.get("points"));
                if points.is_empty() {
                    continue;
                }
                let (w, h) = mask.dimensions();
                let mut coverage = GrayImage::new(w, h);
                stamp_stroke(&mut coverage, &points, radius, MASK_ON);
                art_history_region(mask, base, &coverage, radius);
                operations.push(json!({ "type": "art_history_brush", "radius": radius }));
            }
            Some(_) => apply_queued_operation(image, mask, op, default_tolerance, operations),
            None => {}
        }
        if let (Some((region, ellipse)), Some(before)) = (clip, before) {
            restore_outside_clip(mask, &before, &region, ellipse);
        }
    }
}

/// Apply one queued `operations` entry recorded by the Mask-Edit modal
/// (`MaskOperation`: `type` + optional `amount` scalar + optional `region`).
fn apply_queued_operation(
    image: &RgbaImage,
    mask: &mut GrayImage,
    op: &Value,
    default_tolerance: i32,
    operations: &mut Vec<Value>,
) {
    let amount = op.get("amount").and_then(Value::as_f64);
    let region: Vec<f64> = op
        .get("region")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .collect();
    match op.get("type").and_then(Value::as_str) {
        Some("wand") => {
            // Region carries the `[x, y]` seed; `amount` is the tolerance.
            // `mode: "subtract"` (magic eraser) clears the flooded region
            // instead of selecting it.
            let (Some(&x), Some(&y)) = (region.first(), region.get(1)) else {
                return;
            };
            if x < 0.0 || y < 0.0 {
                return;
            }
            let tolerance = amount
                .map(|t| (t as i64).clamp(0, 255) as i32)
                .unwrap_or(default_tolerance);
            let subtract = op.get("mode").and_then(Value::as_str) == Some("subtract");
            let fill = if subtract { MASK_OFF } else { MASK_ON };
            wand_select(image, mask, x as u32, y as u32, tolerance, fill);
            operations
                .push(json!({ "type": "wand", "tolerance": tolerance, "subtract": subtract }));
        }
        Some("quick_select") => {
            // Quick selection (PS W flyout): every stroke point seeds a
            // tolerance flood-fill; the fills union into the mask.
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let tolerance = amount
                .map(|t| (t as i64).clamp(0, 255) as i32)
                .unwrap_or(default_tolerance);
            let (w, h) = image.dimensions();
            for &(px, py) in &points {
                if px < 0.0 || py < 0.0 || px >= w as f32 || py >= h as f32 {
                    continue;
                }
                wand_select(image, mask, px as u32, py as u32, tolerance, MASK_ON);
            }
            operations.push(
                json!({ "type": "quick_select", "tolerance": tolerance, "seeds": points.len() }),
            );
        }
        Some("background_eraser") => {
            // Background eraser (PS E flyout): for each stamp along the
            // stroke, pixels inside the brush disc whose colour stays within
            // `tolerance` of the colour under the stamp's centre are erased.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let tolerance = op
                .get("tolerance")
                .and_then(Value::as_f64)
                .map(|t| (t as i64).clamp(0, 255) as i32)
                .unwrap_or(default_tolerance);
            background_erase(image, mask, &points, radius, tolerance);
            operations.push(
                json!({ "type": "background_eraser", "radius": radius, "tolerance": tolerance }),
            );
        }
        Some("object_select") => {
            // Object selection (M16): the segmenter (SAM 2 when its weights
            // resolve, else the builtin fallback) masks the object inside
            // the `region` box; the result unions into the mask.
            if region.len() < 4 {
                return;
            }
            object_select_region(image, mask, &region);
            operations.push(json!({ "type": "object_select" }));
        }
        Some("remove") => {
            // Remove (M16): the stroke points seed the segmenter and the
            // segmented object is subtracted from the mask.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            remove_region(image, mask, &points, radius);
            operations.push(json!({ "type": "remove", "radius": radius, "seeds": points.len() }));
        }
        Some("red_eye") => {
            // Red eye (M15): region carries the `[x, y]` click; the
            // contiguous red-dominant region around it floods into the mask.
            let (Some(&x), Some(&y)) = (region.first(), region.get(1)) else {
                return;
            };
            if x < 0.0 || y < 0.0 {
                return;
            }
            red_eye_select(image, mask, x as u32, y as u32);
            operations.push(json!({ "type": "red_eye" }));
        }
        Some(kind @ ("rect" | "ellipse")) => {
            if region.len() < 4 {
                return;
            }
            fill_marquee(mask, kind, &region);
            operations.push(json!({ "type": kind }));
        }
        Some("crop") => {
            if region.len() < 4 {
                return;
            }
            crop_mask(mask, &region);
            operations.push(json!({ "type": "crop" }));
        }
        Some("perspective_crop") => {
            if region.len() < 8 {
                return;
            }
            *mask = perspective_crop_mask(mask, &region);
            operations.push(json!({ "type": "perspective_crop" }));
        }
        Some("gradient") => {
            if region.len() < 4 {
                return;
            }
            let subtract = op.get("mode").and_then(Value::as_str) == Some("subtract");
            fill_gradient(mask, &region, subtract);
            operations.push(json!({ "type": "gradient" }));
        }
        Some("transform") => {
            let field =
                |key: &str, default: f64| op.get(key).and_then(Value::as_f64).unwrap_or(default);
            let dx = field("dx", 0.0);
            let dy = field("dy", 0.0);
            let scale = field("scale", 1.0);
            let rotate = field("rotate", 0.0);
            if dx != 0.0 || dy != 0.0 || scale != 1.0 || rotate != 0.0 {
                *mask = transform_mask(mask, dx, dy, scale, rotate);
                operations.push(json!({
                    "type": "transform",
                    "dx": dx,
                    "dy": dy,
                    "scale": scale,
                    "rotate": rotate,
                }));
            }
        }
        Some("invert") => {
            invert(mask);
            operations.push(json!({ "type": "invert" }));
        }
        Some("select_all") => {
            // PS Select All (M9): the whole canvas selected, as a history step.
            for p in mask.pixels_mut() {
                p.0[0] = MASK_ON;
            }
            operations.push(json!({ "type": "select_all" }));
        }
        Some("delete") => {
            // PS Delete (M9): drop the selection, as a history step (unlike
            // Ctrl+D clear, which wipes the edit stack itself).
            for p in mask.pixels_mut() {
                p.0[0] = MASK_OFF;
            }
            operations.push(json!({ "type": "delete" }));
        }
        Some("fill") => {
            // PS Fill dialog (M11): flood the layer at an opacity — `add`
            // lerps toward on, `subtract` scales toward off. Mirrors the
            // proxy `fillCoverage` in `maskMorphology.ts`.
            let a = (amount.unwrap_or(100.0) / 100.0).clamp(0.0, 1.0);
            let subtract = op.get("mode").and_then(Value::as_str) == Some("subtract");
            for p in mask.pixels_mut() {
                let v = f64::from(p.0[0]);
                p.0[0] = if subtract {
                    (v * (1.0 - a)).round() as u8
                } else {
                    (v + (255.0 - v) * a).round().clamp(0.0, 255.0) as u8
                };
            }
            operations.push(json!({
                "type": "fill",
                "mode": if subtract { "subtract" } else { "add" },
                "opacity": a,
            }));
        }
        Some("fill_holes") => {
            fill_holes(mask);
            operations.push(json!({ "type": "fill_holes" }));
        }
        Some("heal") => {
            // Spot-heal (M13): rebuild the mask under the stroke coverage
            // from its surroundings. `amount` is the brush radius; `points`
            // the stroke polyline.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            heal_region(mask, &coverage);
            operations.push(json!({ "type": "heal", "radius": radius }));
        }
        Some("clone") => {
            // Clone stamp (M13): copy the mask into the stroke coverage from
            // the `dx`/`dy` source offset. `amount` is the brush radius;
            // `points` the stroke polyline.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let field =
                |key: &str| op.get(key).and_then(Value::as_f64).unwrap_or(0.0).round() as i64;
            let (dx, dy) = (field("dx"), field("dy"));
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            clone_region(mask, &coverage, dx, dy);
            operations.push(json!({ "type": "clone", "radius": radius, "dx": dx, "dy": dy }));
        }
        Some("healing_brush") => {
            // Healing brush (M14): copy the mask into the stroke coverage
            // from the `dx`/`dy` source offset like the clone stamp, but
            // blend through a feathered coverage so the patch's edges melt
            // into the surroundings.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let field =
                |key: &str| op.get(key).and_then(Value::as_f64).unwrap_or(0.0).round() as i64;
            let (dx, dy) = (field("dx"), field("dy"));
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            healing_brush_region(mask, &coverage, dx, dy, radius);
            operations
                .push(json!({ "type": "healing_brush", "radius": radius, "dx": dx, "dy": dy }));
        }
        Some("patch") => {
            // Patch (M15): refill the lassoed polygon from the `dx`/`dy`
            // drop offset, blended through a feathered edge like the
            // healing brush.
            let points = parse_points(op.get("points"));
            if points.len() < 3 {
                return;
            }
            let field =
                |key: &str| op.get(key).and_then(Value::as_f64).unwrap_or(0.0).round() as i64;
            let (dx, dy) = (field("dx"), field("dy"));
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            apply_mask_path(
                &mut coverage,
                &MaskPath {
                    mode: PathMode::Add,
                    tool: "patch".to_string(),
                    polygon: points.clone(),
                },
            );
            healing_brush_region(mask, &coverage, dx, dy, 2 * PATCH_FEATHER);
            operations.push(json!({ "type": "patch", "dx": dx, "dy": dy, "points": points.len() }));
        }
        Some("content_aware_move") => {
            // Content-aware move (M16): the lassoed polygon moves by
            // `dx`/`dy` — blended into the destination through a feathered
            // coverage — and the hole behind it is healed from its
            // surroundings.
            let points = parse_points(op.get("points"));
            if points.len() < 3 {
                return;
            }
            let field =
                |key: &str| op.get(key).and_then(Value::as_f64).unwrap_or(0.0).round() as i64;
            let (dx, dy) = (field("dx"), field("dy"));
            content_aware_move_region(mask, &points, dx, dy);
            operations.push(json!({
                "type": "content_aware_move",
                "dx": dx,
                "dy": dy,
                "points": points.len(),
            }));
        }
        Some("pattern_stamp") => {
            // Pattern stamp (M16): covered pixels take the repeating checker
            // pattern.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            pattern_stamp_region(mask, &coverage);
            operations.push(json!({ "type": "pattern_stamp", "radius": radius }));
        }
        Some("sponge") => {
            // Sponge (M14): push the mask's soft values toward hard on/off
            // (`saturate`) or toward mid-grey (`desaturate`) under the stroke
            // coverage.
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let desaturate = op.get("mode").and_then(Value::as_str) == Some("desaturate");
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            sponge_region(mask, &coverage, desaturate);
            operations.push(json!({
                "type": "sponge",
                "radius": radius,
                "mode": if desaturate { "desaturate" } else { "saturate" },
            }));
        }
        Some("dodge_burn") => {
            // Dodge / burn (M13): lighten or darken the mask under the stroke
            // coverage. `amount` is the brush radius; `points` the stroke
            // polyline; `mode` picks the direction (absent ⇒ dodge).
            let radius = amount.unwrap_or(8.0).max(1.0) as u32;
            let points = parse_points(op.get("points"));
            if points.is_empty() {
                return;
            }
            let burn = op.get("mode").and_then(Value::as_str) == Some("burn");
            let (w, h) = mask.dimensions();
            let mut coverage = GrayImage::new(w, h);
            stamp_stroke(&mut coverage, &points, radius, MASK_ON);
            dodge_burn_region(mask, &coverage, burn);
            operations.push(json!({
                "type": "dodge_burn",
                "radius": radius,
                "mode": if burn { "burn" } else { "dodge" },
            }));
        }
        Some("grow") => {
            let px = amount.unwrap_or(0.0).max(0.0) as u32;
            if px > 0 {
                *mask = dilate(mask, px);
                operations.push(json!({ "type": "grow", "px": px }));
            }
        }
        Some("shrink") => {
            let px = amount.unwrap_or(0.0).max(0.0) as u32;
            if px > 0 {
                *mask = erode(mask, px);
                operations.push(json!({ "type": "shrink", "px": px }));
            }
        }
        Some("feather") => {
            let px = amount.unwrap_or(0.0).max(0.0);
            if px > 0.0 {
                *mask = imageops::blur(mask, px as f32);
                operations.push(json!({ "type": "feather", "px": px }));
            }
        }
        Some("blur") => {
            // Gaussian-blur filter step (M6); revisable like feather but a
            // distinct history entry.
            let px = amount.unwrap_or(0.0).max(0.0);
            if px > 0.0 {
                *mask = imageops::blur(mask, px as f32);
                operations.push(json!({ "type": "blur", "px": px }));
            }
        }
        Some("sharpen") => {
            // Unsharp-mask filter step (M6): `out = clamp(2v − blur(v))`,
            // mirroring the proxy `sharpen` in `maskMorphology.ts`.
            let px = amount.unwrap_or(0.0).max(0.0);
            if px > 0.0 {
                let blurred = imageops::blur(mask, px as f32);
                for (p, b) in mask.pixels_mut().zip(blurred.pixels()) {
                    let v = i32::from(p.0[0]);
                    let bl = i32::from(b.0[0]);
                    p.0[0] = (2 * v - bl).clamp(0, 255) as u8;
                }
                operations.push(json!({ "type": "sharpen", "px": px }));
            }
        }
        Some("smooth") => {
            let px = amount.unwrap_or(0.0).max(0.0) as u32;
            if px > 0 {
                // Morphological open (despeckle) then close (fill nicks).
                *mask = dilate(&erode(mask, px), px);
                *mask = erode(&dilate(mask, px), px);
                operations.push(json!({ "type": "smooth", "px": px }));
            }
        }
        _ => {}
    }
}

/// Fill a marquee `rect` / `ellipse` region (`[x1, y1, x2, y2]` image-space).
fn fill_marquee(mask: &mut GrayImage, kind: &str, region: &[f64]) {
    let (width, height) = mask.dimensions();
    let x1 = region[0].min(region[2]);
    let y1 = region[1].min(region[3]);
    let x2 = region[0].max(region[2]);
    let y2 = region[1].max(region[3]);
    let cx = (x1 + x2) / 2.0;
    let cy = (y1 + y2) / 2.0;
    let rx = ((x2 - x1) / 2.0).max(0.5);
    let ry = ((y2 - y1) / 2.0).max(0.5);
    let px0 = x1.floor().max(0.0) as u32;
    let py0 = y1.floor().max(0.0) as u32;
    let px1 = (x2.ceil() as i64).clamp(0, width as i64 - 1) as u32;
    let py1 = (y2.ceil() as i64).clamp(0, height as i64 - 1) as u32;
    for y in py0..=py1 {
        for x in px0..=px1 {
            if kind == "ellipse" {
                let nx = (x as f64 - cx) / rx;
                let ny = (y as f64 - cy) / ry;
                if nx * nx + ny * ny > 1.0 {
                    continue;
                }
            }
            mask.put_pixel(x, y, Luma([MASK_ON]));
        }
    }
}

/// Composite a linear gradient ramp (M10): full selection at the drag start
/// fading to none at the end (`region: [x1, y1, x2, y2]` image-space). `add`
/// unions the ramp into the mask; `subtract` cuts it away. Mirrors the proxy
/// `fillGradient` in `maskMorphology.ts`.
fn fill_gradient(mask: &mut GrayImage, region: &[f64], subtract: bool) {
    let ax = region[0];
    let ay = region[1];
    let dx = region[2] - ax;
    let dy = region[3] - ay;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-6 {
        return;
    }
    let (w, h) = mask.dimensions();
    for y in 0..h {
        for x in 0..w {
            let t =
                (((x as f64 + 0.5 - ax) * dx + (y as f64 + 0.5 - ay) * dy) / len2).clamp(0.0, 1.0);
            let ramp = (255.0 * (1.0 - t)).round() as i32;
            let px = &mut mask.get_pixel_mut(x, y).0[0];
            let v = *px as i32;
            *px = if subtract {
                (v - ramp).max(0) as u8
            } else {
                v.max(ramp) as u8
            };
        }
    }
}

/// Clear the mask outside a `crop` region (`[x1, y1, x2, y2]` image-space).
fn crop_mask(mask: &mut GrayImage, region: &[f64]) {
    let x1 = region[0].min(region[2]);
    let y1 = region[1].min(region[3]);
    let x2 = region[0].max(region[2]);
    let y2 = region[1].max(region[3]);
    for (x, y, p) in mask.enumerate_pixels_mut() {
        let cx = f64::from(x) + 0.5;
        let cy = f64::from(y) + 0.5;
        if cx < x1 || cx > x2 || cy < y1 || cy > y2 {
            p.0[0] = MASK_OFF;
        }
    }
}

/// Move / scale / rotate the mask about the image centre (M5 free transform):
/// inverse-mapped nearest-neighbour sampling, pixels mapping outside the
/// source read as background. `dx`/`dy` are px, `rotate` degrees clockwise,
/// `scale` a uniform factor. Mirrors the proxy `transformMask` in
/// `maskMorphology.ts`.
fn transform_mask(mask: &GrayImage, dx: f64, dy: f64, scale: f64, rotate: f64) -> GrayImage {
    let (width, height) = mask.dimensions();
    let s = scale.max(1e-6);
    let rad = rotate.to_radians();
    let (sin, cos) = rad.sin_cos();
    let cx = f64::from(width) / 2.0;
    let cy = f64::from(height) / 2.0;
    let mut out = GrayImage::new(width, height);
    for (x, y, p) in out.enumerate_pixels_mut() {
        // Invert: un-translate, un-rotate, un-scale about the centre.
        let tx = f64::from(x) + 0.5 - dx - cx;
        let ty = f64::from(y) + 0.5 - dy - cy;
        let rx = (tx * cos + ty * sin) / s + cx;
        let ry = (-tx * sin + ty * cos) / s + cy;
        let sx = rx.floor();
        let sy = ry.floor();
        if sx < 0.0 || sy < 0.0 || sx >= f64::from(width) || sy >= f64::from(height) {
            continue;
        }
        p.0[0] = mask.get_pixel(sx as u32, sy as u32).0[0];
    }
    out
}

/// Flood-fill from a seed, painting `fill` over the contiguous region whose
/// colour stays within `tolerance` (max per-channel RGB distance) of the seed
/// colour — `MASK_ON` selects (wand / paint bucket), `MASK_OFF` erases (magic
/// eraser).
fn wand_select(
    image: &RgbaImage,
    mask: &mut GrayImage,
    seed_x: u32,
    seed_y: u32,
    tolerance: i32,
    fill: u8,
) {
    let (width, height) = image.dimensions();
    if seed_x >= width || seed_y >= height {
        return;
    }
    let seed = image.get_pixel(seed_x, seed_y).0;
    let mut visited = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    queue.push_back((seed_x, seed_y));
    visited[(seed_y * width + seed_x) as usize] = true;

    while let Some((x, y)) = queue.pop_front() {
        let px = image.get_pixel(x, y).0;
        let dist = (0..3)
            .map(|c| (i32::from(px[c]) - i32::from(seed[c])).abs())
            .max()
            .unwrap_or(0);
        if dist > tolerance {
            continue;
        }
        mask.put_pixel(x, y, Luma([fill]));
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !visited[idx] {
                visited[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
}

/// Minimum redness (`r − max(g, b)`) for a pixel to read as part of a red
/// reflection.
const RED_EYE_MIN: i32 = 32;

/// How red-dominant a pixel is: the red channel's excess over the stronger
/// of green / blue.
fn redness(px: [u8; 4]) -> i32 {
    i32::from(px[0]) - i32::from(px[1]).max(i32::from(px[2]))
}

/// Red eye (PS J flyout, on a mask): flood-fill from the click over the
/// contiguous red-dominant region (`redness ≥ RED_EYE_MIN`), selecting it
/// into the mask. A click on a non-red pixel is a no-op.
fn red_eye_select(image: &RgbaImage, mask: &mut GrayImage, seed_x: u32, seed_y: u32) {
    let (width, height) = image.dimensions();
    if seed_x >= width || seed_y >= height {
        return;
    }
    if redness(image.get_pixel(seed_x, seed_y).0) < RED_EYE_MIN {
        return;
    }
    let mut visited = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    queue.push_back((seed_x, seed_y));
    visited[(seed_y * width + seed_x) as usize] = true;
    while let Some((x, y)) = queue.pop_front() {
        if redness(image.get_pixel(x, y).0) < RED_EYE_MIN {
            continue;
        }
        mask.put_pixel(x, y, Luma([MASK_ON]));
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !visited[idx] {
                visited[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
}

fn neighbours(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(4);
    if x > 0 {
        out.push((x - 1, y));
    }
    if x + 1 < width {
        out.push((x + 1, y));
    }
    if y > 0 {
        out.push((x, y - 1));
    }
    if y + 1 < height {
        out.push((x, y + 1));
    }
    out
}

/// Spot-heal (PS J on a mask): rebuild the mask inside `coverage` from its
/// surroundings by diffusion — iterative 4-neighbour averaging with the
/// boundary held fixed, converging toward the harmonic (smooth) fill.
/// Alternating forward / backward Gauss-Seidel sweeps over the coverage
/// bounding box; iterations scale with the region size under a fixed work
/// budget. Mirrors the proxy `healStroke` in `maskMorphology.ts`.
fn heal_region(mask: &mut GrayImage, coverage: &GrayImage) {
    let (w, h) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w as i64, h as i64, -1i64, -1i64);
    let mut area: u64 = 0;
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            area += 1;
            x0 = x0.min(x as i64);
            x1 = x1.max(x as i64);
            y0 = y0.min(y as i64);
            y1 = y1.max(y as i64);
        }
    }
    if x1 < 0 {
        return;
    }
    let (x0, y0, x1, y1) = (x0 as u32, y0 as u32, x1 as u32, y1 as u32);
    // Diffusion converges in ~O(d²) sweeps for a region d pixels across;
    // clamped, and capped by a fixed total work budget for huge regions.
    let max_dim = (x1 - x0 + 1).max(y1 - y0 + 1) as u64;
    let iters = (max_dim * max_dim)
        .min(512)
        .min(400_000_000 / area.max(1))
        .max(16);
    let mut buf: Vec<f32> = mask.pixels().map(|p| f32::from(p.0[0])).collect();
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let mut relax = |buf: &mut Vec<f32>, x: u32, y: u32| {
        if coverage.get_pixel(x, y).0[0] == 0 {
            return;
        }
        let i = idx(x, y);
        let left = if x > 0 { buf[i - 1] } else { buf[i] };
        let right = if x < w - 1 { buf[i + 1] } else { buf[i] };
        let up = if y > 0 { buf[i - w as usize] } else { buf[i] };
        let down = if y < h - 1 {
            buf[i + w as usize]
        } else {
            buf[i]
        };
        buf[i] = (left + right + up + down) / 4.0;
    };
    for it in 0..iters {
        if it % 2 == 0 {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    relax(&mut buf, x, y);
                }
            }
        } else {
            for y in (y0..=y1).rev() {
                for x in (x0..=x1).rev() {
                    relax(&mut buf, x, y);
                }
            }
        }
    }
    for y in y0..=y1 {
        for x in x0..=x1 {
            if coverage.get_pixel(x, y).0[0] != 0 {
                mask.put_pixel(x, y, Luma([buf[idx(x, y)].round().clamp(0.0, 255.0) as u8]));
            }
        }
    }
}

/// Per-stroke exposure of the dodge / burn tool: each pass moves the covered
/// pixels half-way toward on (dodge) or off (burn).
const DODGE_BURN_EXPOSURE: f64 = 0.5;

/// Dodge / burn (PS O on a mask): locally lighten (dodge) or darken (burn)
/// the mask inside `coverage` — each covered pixel is lerped toward 255 / 0
/// by the fixed exposure. Mirrors the proxy `dodgeBurnStroke` in
/// `maskMorphology.ts`.
fn dodge_burn_region(mask: &mut GrayImage, coverage: &GrayImage, burn: bool) {
    for (m, c) in mask.pixels_mut().zip(coverage.pixels()) {
        if c.0[0] == 0 {
            continue;
        }
        let v = f64::from(m.0[0]);
        let out = if burn {
            v * (1.0 - DODGE_BURN_EXPOSURE)
        } else {
            v + (255.0 - v) * DODGE_BURN_EXPOSURE
        };
        m.0[0] = out.round().clamp(0.0, 255.0) as u8;
    }
}

/// History brush (PS Y on a mask): restore the mask inside `coverage` to the
/// layer's pre-edit state `base`. Mirrors the proxy `historyStroke` in
/// `maskMorphology.ts`.
fn history_region(mask: &mut GrayImage, base: &GrayImage, coverage: &GrayImage) {
    for ((m, b), c) in mask.pixels_mut().zip(base.pixels()).zip(coverage.pixels()) {
        if c.0[0] != 0 {
            m.0[0] = b.0[0];
        }
    }
}

/// Clone stamp (PS S on a mask): copy the mask inside `coverage` from the
/// `dx`/`dy` source offset — each covered pixel `p` reads the pre-op mask at
/// `p + [dx, dy]` (out-of-bounds reads as empty). Mirrors the proxy
/// `cloneStroke` in `maskMorphology.ts`.
fn clone_region(mask: &mut GrayImage, coverage: &GrayImage, dx: i64, dy: i64) {
    let (w, h) = mask.dimensions();
    let base = mask.clone();
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            let sx = x as i64 + dx;
            let sy = y as i64 + dy;
            let v = if sx >= 0 && sx < w as i64 && sy >= 0 && sy < h as i64 {
                base.get_pixel(sx as u32, sy as u32).0[0]
            } else {
                0
            };
            mask.put_pixel(x, y, Luma([v]));
        }
    }
}

/// Background eraser (PS E flyout, on a mask): for each stamp along the
/// stroke, erase mask pixels inside the brush disc whose colour stays within
/// `tolerance` (max per-channel RGB distance) of the image colour under the
/// stamp's centre.
fn background_erase(
    image: &RgbaImage,
    mask: &mut GrayImage,
    points: &[(f32, f32)],
    radius: u32,
    tolerance: i32,
) {
    let (width, height) = image.dimensions();
    let r = radius as i32;
    for &(px, py) in points {
        let cx = px.round() as i32;
        let cy = py.round() as i32;
        if cx < 0 || cy < 0 || cx as u32 >= width || cy as u32 >= height {
            continue;
        }
        let seed = image.get_pixel(cx as u32, cy as u32).0;
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy > r * r {
                    continue;
                }
                let x = cx + dx;
                let y = cy + dy;
                if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
                    continue;
                }
                let c = image.get_pixel(x as u32, y as u32).0;
                let dist = (0..3)
                    .map(|ch| (i32::from(c[ch]) - i32::from(seed[ch])).abs())
                    .max()
                    .unwrap_or(0);
                if dist <= tolerance {
                    mask.put_pixel(x as u32, y as u32, Luma([MASK_OFF]));
                }
            }
        }
    }
}

/// Separable box blur (one pass), clamped at the borders. Mirrors the proxy
/// `boxBlur` in `maskMorphology.ts` (round-half-up on positive values).
fn box_blur(mask: &GrayImage, radius: u32) -> GrayImage {
    let (w, h) = mask.dimensions();
    if radius == 0 {
        return mask.clone();
    }
    let r = radius as i64;
    let win = (2 * r + 1) as f64;
    let at = |img: &GrayImage, x: i64, y: i64| {
        f64::from(
            img.get_pixel(
                x.clamp(0, i64::from(w) - 1) as u32,
                y.clamp(0, i64::from(h) - 1) as u32,
            )
            .0[0],
        )
    };
    let mut tmp = GrayImage::new(w, h);
    for y in 0..h {
        let mut sum = 0.0;
        for x in -r..=r {
            sum += at(mask, x, i64::from(y));
        }
        for x in 0..w {
            tmp.put_pixel(x, y, Luma([(sum / win).round() as u8]));
            sum += at(mask, i64::from(x) + r + 1, i64::from(y))
                - at(mask, i64::from(x) - r, i64::from(y));
        }
    }
    let mut out = GrayImage::new(w, h);
    for x in 0..w {
        let mut sum = 0.0;
        for y in -r..=r {
            sum += at(&tmp, i64::from(x), y);
        }
        for y in 0..h {
            out.put_pixel(x, y, Luma([(sum / win).round() as u8]));
            sum += at(&tmp, i64::from(x), i64::from(y) + r + 1)
                - at(&tmp, i64::from(x), i64::from(y) - r);
        }
    }
    out
}

/// Healing brush (PS J flyout, on a mask): copy the mask inside `coverage`
/// from the `dx`/`dy` source offset like `clone_region`, but blend through a
/// feathered (box-blurred) coverage so the patch's edges melt into the
/// surroundings. Mirrors the proxy `healingBrushStroke` in
/// `maskMorphology.ts`.
fn healing_brush_region(mask: &mut GrayImage, coverage: &GrayImage, dx: i64, dy: i64, radius: u32) {
    let (w, h) = mask.dimensions();
    let soft = box_blur(coverage, ((f64::from(radius) / 2.0).round() as u32).max(1));
    let base = mask.clone();
    for y in 0..h {
        for x in 0..w {
            let weight = f64::from(soft.get_pixel(x, y).0[0]) / 255.0;
            if weight == 0.0 {
                continue;
            }
            let sx = x as i64 + dx;
            let sy = y as i64 + dy;
            let cloned = if sx >= 0 && sx < i64::from(w) && sy >= 0 && sy < i64::from(h) {
                f64::from(base.get_pixel(sx as u32, sy as u32).0[0])
            } else {
                0.0
            };
            let v = f64::from(base.get_pixel(x, y).0[0]);
            mask.put_pixel(
                x,
                y,
                Luma([(v * (1.0 - weight) + cloned * weight).round() as u8]),
            );
        }
    }
}

/// Object selection (PS W flyout, on a mask): run the segmentation kernel
/// constrained to the `region` box — the box becomes a placeholder
/// constraint plus a positive point prompt at its centre — and union the
/// segmented object into the mask. Needs the real image, so it has no proxy
/// preview (render lane).
fn object_select_region(image: &RgbaImage, mask: &mut GrayImage, region: &[f64]) {
    let (w, h) = image.dimensions();
    let x1 = region[0].min(region[2]).max(0.0) as u32;
    let y1 = region[1].min(region[3]).max(0.0) as u32;
    let x2 = (region[0].max(region[2]) as u32).min(w.saturating_sub(1));
    let y2 = (region[1].max(region[3]) as u32).min(h.saturating_sub(1));
    if x2 <= x1 || y2 <= y1 {
        return;
    }
    let mut placeholder = GrayImage::new(w, h);
    for y in y1..=y2 {
        for x in x1..=x2 {
            placeholder.put_pixel(x, y, Luma([MASK_ON]));
        }
    }
    let points = [PointPrompt {
        x: x1 + (x2 - x1) / 2,
        y: y1 + (y2 - y1) / 2,
        positive: true,
    }];
    let segmenter = segmenter_for_mode(AutoMode::Subject, &points, Sam2Variant::default());
    let Ok(result) = segmenter.segment(&SegmentRequest {
        image,
        mode: AutoMode::Subject,
        placeholder: Some(&placeholder),
        prompt: None,
        points: &points,
    }) else {
        return;
    };
    for (m, s) in mask.pixels_mut().zip(result.mask.pixels()) {
        m.0[0] = m.0[0].max(s.0[0]);
    }
}

/// Remove (PS J flyout, on a mask): the stroke points seed the segmentation
/// kernel — constrained to the stroke's bounding box expanded by four brush
/// radii — and the segmented object is subtracted from the mask. Needs the
/// real image, so it has no proxy preview (render lane).
fn remove_region(image: &RgbaImage, mask: &mut GrayImage, points: &[(f32, f32)], radius: u32) {
    let (w, h) = image.dimensions();
    let prompts: Vec<PointPrompt> = points
        .iter()
        .filter(|&&(px, py)| px >= 0.0 && py >= 0.0 && px < w as f32 && py < h as f32)
        .map(|&(px, py)| PointPrompt {
            x: px as u32,
            y: py as u32,
            positive: true,
        })
        .collect();
    if prompts.is_empty() {
        return;
    }
    let pad = 4 * radius;
    let x1 = prompts
        .iter()
        .map(|p| p.x)
        .min()
        .unwrap_or(0)
        .saturating_sub(pad);
    let y1 = prompts
        .iter()
        .map(|p| p.y)
        .min()
        .unwrap_or(0)
        .saturating_sub(pad);
    let x2 = (prompts.iter().map(|p| p.x).max().unwrap_or(0) + pad).min(w.saturating_sub(1));
    let y2 = (prompts.iter().map(|p| p.y).max().unwrap_or(0) + pad).min(h.saturating_sub(1));
    let mut placeholder = GrayImage::new(w, h);
    for y in y1..=y2 {
        for x in x1..=x2 {
            placeholder.put_pixel(x, y, Luma([MASK_ON]));
        }
    }
    let segmenter = segmenter_for_mode(AutoMode::Subject, &prompts, Sam2Variant::default());
    let Ok(result) = segmenter.segment(&SegmentRequest {
        image,
        mode: AutoMode::Subject,
        placeholder: Some(&placeholder),
        prompt: None,
        points: &prompts,
    }) else {
        return;
    };
    for (m, s) in mask.pixels_mut().zip(result.mask.pixels()) {
        m.0[0] = m.0[0].min(MASK_ON - s.0[0]);
    }
}

/// Content-aware move (PS J flyout, on a mask): the lassoed polygon's values
/// blend into the `dx`/`dy` destination through a feathered coverage, and
/// the hole behind it is healed from its surroundings by the same diffusion
/// the heal tool uses. Mirrors the proxy `contentAwareMove` in
/// `maskMorphology.ts`.
fn content_aware_move_region(mask: &mut GrayImage, points: &[(f32, f32)], dx: i64, dy: i64) {
    let (w, h) = mask.dimensions();
    let mut coverage = GrayImage::new(w, h);
    apply_mask_path(
        &mut coverage,
        &MaskPath {
            mode: PathMode::Add,
            tool: "content_aware_move".to_string(),
            polygon: points.to_vec(),
        },
    );
    let soft = box_blur(&coverage, PATCH_FEATHER);
    let base = mask.clone();
    heal_region(mask, &coverage);
    for y in 0..h {
        for x in 0..w {
            let sx = x as i64 - dx;
            let sy = y as i64 - dy;
            if sx < 0 || sx >= i64::from(w) || sy < 0 || sy >= i64::from(h) {
                continue;
            }
            let weight = f64::from(soft.get_pixel(sx as u32, sy as u32).0[0]) / 255.0;
            if weight == 0.0 {
                continue;
            }
            let moved = f64::from(base.get_pixel(sx as u32, sy as u32).0[0]);
            let v = f64::from(mask.get_pixel(x, y).0[0]);
            mask.put_pixel(
                x,
                y,
                Luma([(v * (1.0 - weight) + moved * weight).round() as u8]),
            );
        }
    }
}

/// Cell size (px) of the pattern stamp's checkerboard. Mirrors
/// `PATTERN_CELL` in `maskMorphology.ts`.
const PATTERN_CELL: u32 = 8;

/// Pattern stamp (PS S flyout, on a mask): covered pixels take the repeating
/// checker pattern at their image-space cell. Mirrors the proxy
/// `patternStampStroke` in `maskMorphology.ts`.
fn pattern_stamp_region(mask: &mut GrayImage, coverage: &GrayImage) {
    let (w, h) = mask.dimensions();
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            let on = (x / PATTERN_CELL + y / PATTERN_CELL) % 2 == 0;
            mask.put_pixel(x, y, Luma([if on { MASK_ON } else { MASK_OFF }]));
        }
    }
}

/// Art history brush (PS Y flyout, on a mask): restore the mask inside
/// `coverage` to the layer's pre-edit state `base` through a deterministic
/// per-pixel jitter — each covered pixel reads `base` at a hashed offset
/// within half the brush radius. Mirrors the proxy `artHistoryStroke` in
/// `maskMorphology.ts`.
fn art_history_region(mask: &mut GrayImage, base: &GrayImage, coverage: &GrayImage, radius: u32) {
    let (w, h) = mask.dimensions();
    let amp = ((f64::from(radius) / 2.0).round() as i64).max(1);
    let span = (2 * amp + 1) as u64;
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            let hash = (u64::from(x) * 374_761_393 + u64::from(y) * 668_265_263) % 4_294_967_296;
            let sx = (i64::from(x) + ((hash / 8) % span) as i64 - amp).clamp(0, i64::from(w) - 1);
            let sy =
                (i64::from(y) + ((hash / 131_072) % span) as i64 - amp).clamp(0, i64::from(h) - 1);
            mask.put_pixel(x, y, Luma([base.get_pixel(sx as u32, sy as u32).0[0]]));
        }
    }
}

/// Per-stroke exposure of the sponge tool: each pass moves the covered pixels
/// half-way toward hard on/off (saturate) or toward mid-grey (desaturate).
const SPONGE_EXPOSURE: f64 = 0.5;

/// Feathered edge (px) of the patch tool's blend into the surroundings — the
/// patch op runs `healing_brush_region` at radius `2 * PATCH_FEATHER` (its
/// blur is half the radius). Mirrors `PATCH_FEATHER` in `maskMorphology.ts`.
const PATCH_FEATHER: u32 = 4;

/// Homography coefficients mapping the unit square onto the quad
/// `[p00, p10, p11, p01]` (TL, TR, BR, BL):
/// `X = (a·u + b·v + c) / (g·u + h·v + 1)`, same for `Y` with `d, e, f`.
/// Degenerate quads fall back to the affine map (`g = h = 0`). Mirrors the
/// proxy `quadHomography` in `maskMorphology.ts`.
fn quad_homography(quad: &[(f64, f64); 4]) -> [f64; 8] {
    let (p00, p10, p11, p01) = (quad[0], quad[1], quad[2], quad[3]);
    let sx = p00.0 - p10.0 + p11.0 - p01.0;
    let sy = p00.1 - p10.1 + p11.1 - p01.1;
    let d1x = p10.0 - p11.0;
    let d1y = p10.1 - p11.1;
    let d2x = p01.0 - p11.0;
    let d2y = p01.1 - p11.1;
    let den = d1x * d2y - d1y * d2x;
    let mut g = 0.0;
    let mut h = 0.0;
    if (sx != 0.0 || sy != 0.0) && den.abs() > 1e-9 {
        g = (sx * d2y - sy * d2x) / den;
        h = (d1x * sy - sx * d1y) / den;
    }
    [
        p10.0 - p00.0 + g * p10.0,
        p01.0 - p00.0 + h * p01.0,
        p00.0,
        p10.1 - p00.1 + g * p10.1,
        p01.1 - p00.1 + h * p01.1,
        p00.1,
        g,
        h,
    ]
}

/// Perspective crop (PS C flyout, on a mask): straighten the quad
/// `region: [x0,y0, x1,y1, x2,y2, x3,y3]` (TL, TR, BR, BL image-space) into
/// its bounding rectangle — each rect pixel inverse-maps through the
/// rect→quad homography (nearest-neighbour), everything outside the rect is
/// cleared. Mirrors the proxy `perspectiveCrop` in `maskMorphology.ts`.
fn perspective_crop_mask(mask: &GrayImage, region: &[f64]) -> GrayImage {
    let quad = [
        (region[0], region[1]),
        (region[2], region[3]),
        (region[4], region[5]),
        (region[6], region[7]),
    ];
    let bx1 = quad.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let by1 = quad.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let bx2 = quad.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let by2 = quad.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let bw = (bx2 - bx1).max(1e-6);
    let bh = (by2 - by1).max(1e-6);
    let [a, b, c, d, e, f, g, hh] = quad_homography(&quad);
    let (w, h) = mask.dimensions();
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let cx = f64::from(x) + 0.5;
            let cy = f64::from(y) + 0.5;
            if cx < bx1 || cx > bx2 || cy < by1 || cy > by2 {
                continue;
            }
            let u = (cx - bx1) / bw;
            let v = (cy - by1) / bh;
            let den = g * u + hh * v + 1.0;
            if den.abs() < 1e-9 {
                continue;
            }
            let sx = ((a * u + b * v + c) / den).floor();
            let sy = ((d * u + e * v + f) / den).floor();
            if sx < 0.0 || sy < 0.0 || sx >= f64::from(w) || sy >= f64::from(h) {
                continue;
            }
            out.put_pixel(x, y, *mask.get_pixel(sx as u32, sy as u32));
        }
    }
    out
}

/// Sponge (PS O flyout, on a mask): locally push the mask's soft values
/// toward hard on/off (saturate) or toward mid-grey (desaturate) inside
/// `coverage`. Mirrors the proxy `spongeStroke` in `maskMorphology.ts`.
fn sponge_region(mask: &mut GrayImage, coverage: &GrayImage, desaturate: bool) {
    for (m, c) in mask.pixels_mut().zip(coverage.pixels()) {
        if c.0[0] == 0 {
            continue;
        }
        let v = f64::from(m.0[0]);
        let out = if desaturate {
            v + (128.0 - v) * SPONGE_EXPOSURE
        } else if v >= 128.0 {
            v + (255.0 - v) * SPONGE_EXPOSURE
        } else {
            v * (1.0 - SPONGE_EXPOSURE)
        };
        m.0[0] = out.round().clamp(0.0, 255.0) as u8;
    }
}

/// Stamp filled discs of `radius` along a polyline, writing `value`.
fn stamp_stroke(mask: &mut GrayImage, points: &[(f32, f32)], radius: u32, value: u8) {
    for &(px, py) in points {
        stamp_disc(mask, px, py, radius, value);
    }
}

fn stamp_disc(mask: &mut GrayImage, cx: f32, cy: f32, radius: u32, value: u8) {
    let (width, height) = mask.dimensions();
    let r = radius as i32;
    let cxi = cx.round() as i32;
    let cyi = cy.round() as i32;
    for dy in -r..=r {
        for dx in -r..=r {
            if dx * dx + dy * dy > r * r {
                continue;
            }
            let x = cxi + dx;
            let y = cyi + dy;
            if x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                mask.put_pixel(x as u32, y as u32, Luma([value]));
            }
        }
    }
}

/// Stamp soft discs along a polyline at `spacing * diameter` intervals
/// (resampling between the recorded points so sparse polylines still read as
/// a continuous band).
fn stamp_stroke_soft(
    mask: &mut GrayImage,
    points: &[(f32, f32)],
    radius: u32,
    hardness: f32,
    flow: f32,
    spacing: f32,
    subtract: bool,
) {
    let step = (spacing * 2.0 * radius.max(1) as f32).max(1.0);
    if points.len() == 1 {
        stamp_disc_soft(
            mask,
            points[0].0,
            points[0].1,
            radius,
            hardness,
            flow,
            subtract,
        );
        return;
    }
    for pair in points.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        let dist = (x1 - x0).hypot(y1 - y0);
        let steps = (dist / step).ceil().max(1.0) as u32;
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let x = x0 + (x1 - x0) * t;
            let y = y0 + (y1 - y0) * t;
            stamp_disc_soft(mask, x, y, radius, hardness, flow, subtract);
        }
    }
}

/// Stamp one soft disc: full coverage inside `hardness * r` falling linearly
/// to 0 at the rim, capped by `flow`. Add max-composites the coverage up;
/// subtract multiplies the mask down — so overlapping stamps don't build
/// past the flow cap (mirrors the proxy stamp in `maskMorphology.ts`).
fn stamp_disc_soft(
    mask: &mut GrayImage,
    cx: f32,
    cy: f32,
    radius: u32,
    hardness: f32,
    flow: f32,
    subtract: bool,
) {
    let (width, height) = mask.dimensions();
    let r = (radius.max(1)) as f32;
    let hard = hardness.clamp(0.0, 1.0) * r;
    let ri = r.ceil() as i32;
    let cxi = cx.round() as i32;
    let cyi = cy.round() as i32;
    for dy in -ri..=ri {
        for dx in -ri..=ri {
            let d = ((dx * dx + dy * dy) as f32).sqrt();
            if d > r {
                continue;
            }
            let x = cxi + dx;
            let y = cyi + dy;
            if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
                continue;
            }
            let falloff = if d <= hard {
                1.0
            } else {
                (r - d) / (r - hard).max(1e-6)
            };
            let cov = (flow.clamp(0.0, 1.0) * falloff).clamp(0.0, 1.0);
            let p = mask.get_pixel_mut(x as u32, y as u32);
            let v = f32::from(p.0[0]);
            p.0[0] = if subtract {
                (v * (1.0 - cov)).round().clamp(0.0, 255.0) as u8
            } else {
                v.max((cov * 255.0).round()) as u8
            };
        }
    }
}

fn invert(mask: &mut GrayImage) {
    for p in mask.pixels_mut() {
        p.0[0] = 255 - p.0[0];
    }
}

/// Fill interior holes: flood the background inward from the borders, then any
/// off pixel the flood never reached is an enclosed hole and is turned on.
fn fill_holes(mask: &mut GrayImage) {
    let (width, height) = mask.dimensions();
    let mut reachable = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    let mut seed = |x: u32, y: u32, queue: &mut VecDeque<(u32, u32)>| {
        let idx = (y * width + x) as usize;
        if !reachable[idx] && mask.get_pixel(x, y).0[0] < SELECTED_THRESHOLD {
            reachable[idx] = true;
            queue.push_back((x, y));
        }
    };
    for x in 0..width {
        seed(x, 0, &mut queue);
        seed(x, height - 1, &mut queue);
    }
    for y in 0..height {
        seed(0, y, &mut queue);
        seed(width - 1, y, &mut queue);
    }
    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !reachable[idx] && mask.get_pixel(nx, ny).0[0] < SELECTED_THRESHOLD {
                reachable[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            if !reachable[idx] && mask.get_pixel(x, y).0[0] < SELECTED_THRESHOLD {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
    }
}

/// Separable max filter: grow the matte outward by `radius` px. Also used by
/// [`subject_matte`](super::subject_matte) to build trimaps.
pub(super) fn dilate(mask: &GrayImage, radius: u32) -> GrayImage {
    morphology(mask, radius, true)
}

/// Separable min filter: bite the matte inward by `radius` px. Also used by
/// [`subject_matte`](super::subject_matte) to build trimaps.
pub(super) fn erode(mask: &GrayImage, radius: u32) -> GrayImage {
    morphology(mask, radius, false)
}

fn morphology(mask: &GrayImage, radius: u32, grow: bool) -> GrayImage {
    if radius == 0 {
        return mask.clone();
    }
    let (width, height) = mask.dimensions();
    let (w, h) = (width as usize, height as usize);
    let r = radius as usize;
    let init = if grow { MASK_OFF } else { MASK_ON };
    let pick = |acc: u8, v: u8| if grow { acc.max(v) } else { acc.min(v) };
    let src = mask.as_raw();

    // Horizontal pass: each output row depends only on the matching source row,
    // so rows are independent and processed in parallel across CPU workers.
    let mut tmp = vec![0u8; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let base = y * w;
        for (x, slot) in row.iter_mut().enumerate() {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            let mut acc = init;
            for sx in lo..=hi {
                acc = pick(acc, src[base + sx]);
            }
            *slot = acc;
        }
    });

    // Vertical pass: each output row reads a column window from `tmp`; the rows
    // are still independent, so the same row-parallel split applies.
    let mut out = vec![0u8; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        for (x, slot) in row.iter_mut().enumerate() {
            let mut acc = init;
            for sy in lo..=hi {
                acc = pick(acc, tmp[sy * w + x]);
            }
            *slot = acc;
        }
    });

    GrayImage::from_raw(width, height, out).expect("morphology buffer matches dimensions")
}

fn mask_coverage(mask: &GrayImage) -> f64 {
    let total = mask.pixels().len();
    if total == 0 {
        return 0.0;
    }
    let on = mask
        .pixels()
        .filter(|p| p.0[0] >= SELECTED_THRESHOLD)
        .count();
    on as f64 / total as f64
}

fn compose_alpha(image: &WorkingImage, mask: &GrayImage) -> WorkingImage {
    // Full-resolution "cutout" on the 16-bit canonical surface: keep the RGB at
    // full precision, take alpha from the mask (widened to 16-bit). The space /
    // ICC tag carries through so a ProPhoto surface stays wide-gamut. Shared
    // (rayon-parallel) with the rest of the compute lane via `pixel_ops`.
    pixel_ops::apply_alpha_mask_working(image, mask)
}

fn cutout_to_bbox(alpha_image: &WorkingImage, mask: &GrayImage) -> WorkingImage {
    match selection_bbox(mask) {
        Some((x0, y0, x1, y1)) => {
            pixel_ops::crop_working(alpha_image, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
        }
        // Empty selection: a valid 1x1 transparent cutout (never panic). Keep
        // the source space / ICC so it egresses like every other output.
        None => WorkingImage {
            width: 1,
            height: 1,
            pixels: vec![0u16; 4],
            space: alpha_image.space,
            icc: alpha_image.icc.clone(),
        },
    }
}

fn selection_bbox(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (width, height) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut any = false;
    for y in 0..height {
        for x in 0..width {
            if mask.get_pixel(x, y).0[0] >= SELECTED_THRESHOLD {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    any.then_some((x0, y0, x1, y1))
}

// --- edit_paths parsing ----------------------------------------------------

fn parse_edit_paths(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Object(_)) => value.cloned(),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(text).ok()
        }
        _ => None,
    }
}

/// The object echoed onto the `edit_paths` output / written to disk: the parsed
/// input migrated to the version-3 layered-document envelope, else an empty one.
fn normalise_edit_paths(value: Option<&Value>) -> Value {
    migrate_edit_paths(parse_edit_paths(value).unwrap_or_else(|| json!({})))
}

/// Migrate an `edit_paths` value to the version-3 envelope: a `layers` stack
/// (each layer one ordered `ops` list plus `blend` / `opacity` / `visible`)
/// plus the non-sequential document-level `matte_strokes` / `points`. A
/// version-3 value passes through (missing fields filled in); a version-2
/// value's `ops` stack becomes the single background layer; a version-1
/// value's per-kind arrays are folded onto `ops` in the legacy replay order —
/// `paths`, then the legacy inline `ops` (wand / invert, rewritten to the
/// queued-operation shape), then `brush_strokes`, then `operations` — so
/// replaying the migrated document rasterises identically.
fn migrate_edit_paths(value: Value) -> Value {
    let arr = |key: &str| -> Vec<Value> {
        value
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version >= 3 {
        let layer_groups = normalise_layer_groups(value.get("layerGroups"));
        let group_ids: BTreeSet<String> = layer_groups
            .iter()
            .filter_map(|group| group.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let layers: Vec<Value> = arr("layers")
            .into_iter()
            .map(|layer| normalise_layer(layer, &group_ids))
            .collect();
        let layers = if layers.is_empty() {
            vec![empty_layer()]
        } else {
            layers
        };
        let active = value
            .get("active")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(layers.len() as u64 - 1);
        let mut doc = json!({
            "version": 3,
            "layers": layers,
            "active": active,
            "matte_strokes": arr("matte_strokes"),
            "points": arr("points"),
            "layerGroups": layer_groups,
        });
        if let Some(canvas) = normalise_canvas(value.get("canvas")) {
            doc["canvas"] = canvas;
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
                // Legacy inline wand: `{ x, y, tolerance? }` → queued shape.
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
    let mut layer = empty_layer();
    layer["ops"] = json!(ops);
    json!({
        "version": 3,
        "layers": [layer],
        "active": 0,
        "matte_strokes": arr("matte_strokes"),
        "points": arr("points"),
        "layerGroups": [],
    })
}

fn empty_layer() -> Value {
    json!({
        "name": "Background",
        "kind": "mask",
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
        out.push(json!({ "id": id, "name": name, "color": color }));
    }
    out
}

// Fill in a stored layer's missing / malformed fields with their defaults.
fn normalise_layer(layer: Value, group_ids: &BTreeSet<String>) -> Value {
    let mut out = empty_layer();
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
    if let Some(kind @ ("mask" | "adjustment")) = layer.get("kind").and_then(Value::as_str) {
        out["kind"] = json!(kind);
    }
    if let Some(adjustment) = layer.get("adjustment") {
        out["adjustment"] = adjustment.clone();
    }
    out
}

/// The document-level PS Image Size request: the output pixel size plus the
/// resampling filter choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CanvasSize {
    w: u32,
    h: u32,
    resample: CanvasResample,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CanvasResample {
    Auto,
    Nearest,
    Bilinear,
    Bicubic,
}

impl CanvasSize {
    /// The `image` crate filter for this request. `Auto` picks bilinear for a
    /// downscale and Lanczos for an upscale (the convention the enhance card
    /// resamples with).
    fn filter(&self, src_w: u32, src_h: u32) -> imageops::FilterType {
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

/// The normalised `canvas` object echoed back onto the migrated document, or
/// `None` when absent / malformed (a missing canvas means "keep source size").
fn normalise_canvas(value: Option<&Value>) -> Option<Value> {
    let canvas = parse_canvas_value(value?)?;
    Some(json!({ "w": canvas.w, "h": canvas.h, "resample": canvas.resample }))
}

/// The document-level Image Size request on `edit_paths`, when present.
fn parse_canvas_size(edit_paths: Option<&Value>) -> Option<CanvasSize> {
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

/// Optional point prompts for the auto-subject segmenter, read from a top-level
/// `points` array on `edit_paths`. Each point is either a legacy `[x, y]` pair
/// (read as positive) or an object `{ "x", "y", "label" }` where `label` is `0`
/// for a negative (exclude) point and anything else (or absent) for a positive
/// one. Absent ⇒ no prompts (the segmenter falls back to its largest component).
fn parse_point_prompts(edit_paths: Option<&Value>) -> Vec<PointPrompt> {
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

/// How a rasterised pen / lasso path combines with the mask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathMode {
    Add,
    Subtract,
    Intersect,
}

impl PathMode {
    fn as_str(self) -> &'static str {
        match self {
            PathMode::Add => "add",
            PathMode::Subtract => "subtract",
            PathMode::Intersect => "intersect",
        }
    }
}

/// A parsed pen / lasso vector path, flattened to a closed polygon.
#[derive(Debug)]
struct MaskPath {
    mode: PathMode,
    tool: String,
    polygon: Vec<(f32, f32)>,
}

/// One anchor of a pen path: the point plus optional bezier control handles.
#[derive(Debug, Clone, Copy)]
struct PathAnchor {
    x: f32,
    y: f32,
    /// Incoming control handle (the curve arrives through this point).
    handle_in: Option<(f32, f32)>,
    /// Outgoing control handle (the curve leaves through this point).
    handle_out: Option<(f32, f32)>,
}

/// Parse one pen / lasso vector path entry into a flattened closed polygon
/// ready to rasterise. A path needs at least 3 anchors to enclose an area; the
/// polygon is always closed for the fill (a lasso releases into a closed loop,
/// a pen path closes back to its first anchor).
fn parse_mask_path(path: &Value) -> Option<MaskPath> {
    let anchors: Vec<PathAnchor> = path
        .get("points")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_path_anchor)
        .collect();
    if anchors.len() < 3 {
        return None;
    }
    let mode = match path.get("mode").and_then(Value::as_str) {
        Some("subtract") => PathMode::Subtract,
        Some("intersect") => PathMode::Intersect,
        _ => PathMode::Add,
    };
    let tool = path
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("pen")
        .to_string();
    Some(MaskPath {
        mode,
        tool,
        polygon: flatten_path(&anchors),
    })
}

fn parse_path_anchor(value: &Value) -> Option<PathAnchor> {
    let x = json_f32(value.get("x"))?;
    let y = json_f32(value.get("y"))?;
    let handle = |key: &str| -> Option<(f32, f32)> {
        let pair = value.get(key)?.as_array()?;
        Some((json_f32(pair.first())?, json_f32(pair.get(1))?))
    };
    Some(PathAnchor {
        x,
        y,
        handle_in: handle("in"),
        handle_out: handle("out"),
    })
}

/// Flatten the anchor loop into a polygon. A segment whose endpoints carry
/// bezier control handles (`out` on the start / `in` on the end) is sampled as
/// a cubic bezier; a handle-less segment is a straight line. The closing
/// segment (last anchor back to the first) is included so the fill always sees
/// a closed loop.
fn flatten_path(anchors: &[PathAnchor]) -> Vec<(f32, f32)> {
    let mut polygon = Vec::new();
    for i in 0..anchors.len() {
        let a = anchors[i];
        let b = anchors[(i + 1) % anchors.len()];
        polygon.push((a.x, a.y));
        if a.handle_out.is_none() && b.handle_in.is_none() {
            continue;
        }
        let c1 = a.handle_out.unwrap_or((a.x, a.y));
        let c2 = b.handle_in.unwrap_or((b.x, b.y));
        let chord = ((b.x - a.x).hypot(b.y - a.y)
            + (c1.0 - a.x).hypot(c1.1 - a.y)
            + (c2.0 - b.x).hypot(c2.1 - b.y)) as usize;
        let steps = chord.clamp(8, 128);
        for s in 1..steps {
            let t = s as f32 / steps as f32;
            polygon.push(cubic_bezier(a, c1, c2, b, t));
        }
    }
    polygon
}

fn cubic_bezier(
    a: PathAnchor,
    c1: (f32, f32),
    c2: (f32, f32),
    b: PathAnchor,
    t: f32,
) -> (f32, f32) {
    let u = 1.0 - t;
    let (uu, tt) = (u * u, t * t);
    let (uuu, ttt) = (uu * u, tt * t);
    (
        uuu * a.x + 3.0 * uu * t * c1.0 + 3.0 * u * tt * c2.0 + ttt * b.x,
        uuu * a.y + 3.0 * uu * t * c1.1 + 3.0 * u * tt * c2.1 + ttt * b.y,
    )
}

/// Rasterise the flattened polygon (even-odd scanline fill at pixel centres)
/// and boolean-combine it with the mask: `add` turns the interior on,
/// `subtract` turns it off, `intersect` keeps only what is already selected
/// inside it (everything outside goes off).
fn apply_mask_path(mask: &mut GrayImage, path: &MaskPath) {
    let (width, height) = mask.dimensions();
    let polygon = &path.polygon;
    if polygon.len() < 3 {
        return;
    }
    for y in 0..height {
        let scan = y as f32 + 0.5;
        // Even-odd rule: collect the x-crossings of every polygon edge with
        // this scanline, sort them, and fill between alternating pairs.
        let mut crossings: Vec<f32> = Vec::new();
        for i in 0..polygon.len() {
            let (x0, y0) = polygon[i];
            let (x1, y1) = polygon[(i + 1) % polygon.len()];
            if (y0 <= scan) == (y1 <= scan) {
                continue;
            }
            crossings.push(x0 + (scan - y0) / (y1 - y0) * (x1 - x0));
        }
        crossings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut inside_spans: Vec<(u32, u32)> = Vec::new();
        for pair in crossings.chunks_exact(2) {
            let start = pair[0].max(0.0).round() as i64;
            let end = (pair[1].round() as i64 - 1).min(width as i64 - 1);
            if end >= start && start < width as i64 {
                inside_spans.push((start as u32, end as u32));
            }
        }
        match path.mode {
            PathMode::Add | PathMode::Subtract => {
                let value = if path.mode == PathMode::Add {
                    MASK_ON
                } else {
                    MASK_OFF
                };
                for &(start, end) in &inside_spans {
                    for x in start..=end {
                        mask.put_pixel(x, y, Luma([value]));
                    }
                }
            }
            PathMode::Intersect => {
                let mut inside = vec![false; width as usize];
                for &(start, end) in &inside_spans {
                    for x in start..=end {
                        inside[x as usize] = true;
                    }
                }
                for x in 0..width {
                    if !inside[x as usize] {
                        mask.put_pixel(x, y, Luma([MASK_OFF]));
                    }
                }
            }
        }
    }
}

/// Trimap unknown-band strokes painted by the Mask-Edit "Matting" tool, read
/// from `edit_paths.matte_strokes` (same shape as `brush_strokes`: a polyline +
/// radius). Each becomes a disc-stamped band the matter resolves into soft
/// alpha. Empty ⇒ matting only runs when the `alpha_matting` flag is set.
fn parse_matte_strokes(edit_paths: Option<&Value>) -> Vec<(Vec<(f32, f32)>, u32)> {
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

fn parse_points(value: Option<&Value>) -> Vec<(f32, f32)> {
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

fn json_f32(value: Option<&Value>) -> Option<f32> {
    value.and_then(Value::as_f64).map(|n| n as f32)
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_f64)
        .filter(|n| *n >= 0.0)
        .map(|n| n as u32)
}

// --- PNG save helper -------------------------------------------------------

/// A thin wrapper so a `GrayImage` saves through the same `.save()` path as the
/// RGBA surfaces without an extra `DynamicImage` clone elsewhere.
struct DynamicGray<'a>(&'a GrayImage);

fn save_png(gray: &DynamicGray, path: &Path) -> Result<(), String> {
    gray.0
        .save(path)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Run a subject-mask node with no skippable ports (the default for every
    /// test that isn't specifically exercising the write-skip path).
    fn run(node: &StudioGraphNode, inputs: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
        execute_studio_subject_mask(node, inputs, &HashSet::new()).unwrap()
    }

    fn node() -> StudioGraphNode {
        StudioGraphNode {
            id: "n1".to_string(),
            kind: "subjectMask".to_string(),
            params: BTreeMap::new(),
        }
    }

    fn solid(width: u32, height: u32, value: u8) -> GrayImage {
        GrayImage::from_pixel(width, height, Luma([value]))
    }

    #[test]
    fn rejects_missing_image_input() {
        let err =
            execute_studio_subject_mask(&node(), &BTreeMap::new(), &HashSet::new()).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn rejects_blank_image_input() {
        let mut inputs = BTreeMap::new();
        inputs.insert("image".to_string(), json!("   "));
        let err = execute_studio_subject_mask(&node(), &inputs, &HashSet::new()).unwrap_err();
        assert!(err.contains("connected image input"), "{err}");
    }

    #[test]
    fn wand_selects_contiguous_same_colour_region() {
        // Left half red, right half blue; seeding the left selects only the left.
        let mut image = RgbaImage::new(4, 2);
        for y in 0..2 {
            for x in 0..4 {
                let colour = if x < 2 {
                    Rgba([200, 0, 0, 255])
                } else {
                    Rgba([0, 0, 200, 255])
                };
                image.put_pixel(x, y, colour);
            }
        }
        let mut mask = solid(4, 2, MASK_OFF);
        wand_select(&image, &mut mask, 0, 0, 20, MASK_ON);
        for y in 0..2 {
            assert_eq!(mask.get_pixel(0, y).0[0], MASK_ON);
            assert_eq!(mask.get_pixel(1, y).0[0], MASK_ON);
            assert_eq!(mask.get_pixel(2, y).0[0], MASK_OFF);
            assert_eq!(mask.get_pixel(3, y).0[0], MASK_OFF);
        }
        // Magic eraser: the same flood with `MASK_OFF` clears the region.
        wand_select(&image, &mut mask, 0, 0, 20, MASK_OFF);
        for y in 0..2 {
            assert_eq!(mask.get_pixel(0, y).0[0], MASK_OFF);
            assert_eq!(mask.get_pixel(1, y).0[0], MASK_OFF);
        }
    }

    #[test]
    fn brush_stroke_adds_and_eraser_subtracts() {
        let mut mask = solid(9, 9, MASK_OFF);
        stamp_stroke(&mut mask, &[(4.0, 4.0)], 2, MASK_ON);
        assert_eq!(mask.get_pixel(4, 4).0[0], MASK_ON);
        stamp_stroke(&mut mask, &[(4.0, 4.0)], 2, MASK_OFF);
        assert_eq!(mask.get_pixel(4, 4).0[0], MASK_OFF);
    }

    #[test]
    fn soft_disc_grades_coverage_and_caps_at_flow() {
        // Hardness 0.5: full coverage inside r/2, linear falloff to the rim.
        let mut mask = solid(41, 41, MASK_OFF);
        stamp_disc_soft(&mut mask, 20.0, 20.0, 10, 0.5, 1.0, false);
        assert_eq!(mask.get_pixel(20, 20).0[0], MASK_ON);
        let near_rim = mask.get_pixel(28, 20).0[0]; // d=8 between hard=5 and r=10
        assert!(
            near_rim > 0 && near_rim < MASK_ON,
            "graded edge, got {near_rim}"
        );
        assert_eq!(mask.get_pixel(35, 20).0[0], MASK_OFF);

        // Flow 0.5 caps the add at ~128; soft subtract scales down by 1-cov.
        let mut mask = solid(21, 21, MASK_OFF);
        stamp_disc_soft(&mut mask, 10.0, 10.0, 5, 1.0, 0.5, false);
        assert_eq!(mask.get_pixel(10, 10).0[0], 128);
        let mut sub = solid(21, 21, MASK_ON);
        stamp_disc_soft(&mut sub, 10.0, 10.0, 5, 1.0, 0.5, true);
        assert_eq!(sub.get_pixel(10, 10).0[0], 128);
        assert_eq!(sub.get_pixel(0, 0).0[0], MASK_ON);
    }

    #[test]
    fn soft_brush_op_replays_with_graded_edge_and_hard_stays_binary() {
        let image = RgbaImage::from_pixel(41, 41, Rgba([0, 0, 0, 255]));
        let soft = json!({
            "version": 2,
            "ops": [{ "type": "brush", "mode": "add", "radius": 10,
                       "points": [[20, 20]], "hardness": 0.3, "flow": 1.0, "spacing": 0.25 }]
        });
        let mut mask = solid(41, 41, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&soft), 24, &mut operations);
        assert!(
            mask.as_raw().iter().any(|&v| v > 0 && v < MASK_ON),
            "soft edge expected"
        );
        assert!((operations[0]["hardness"].as_f64().unwrap() - 0.3).abs() < 1e-6);

        // Without the soft fields the legacy binary stamp path is taken.
        let hard = json!({
            "version": 2,
            "ops": [{ "type": "brush", "mode": "add", "radius": 10, "points": [[20, 20]] }]
        });
        let mut mask = solid(41, 41, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&hard), 24, &mut Vec::new());
        assert!(mask.as_raw().iter().all(|&v| v == MASK_OFF || v == MASK_ON));
    }

    #[test]
    fn dilate_grows_and_erode_shrinks() {
        let mut mask = solid(7, 7, MASK_OFF);
        stamp_disc(&mut mask, 3.0, 3.0, 1, MASK_ON);
        let before = mask_coverage(&mask);
        let grown = dilate(&mask, 1);
        assert!(mask_coverage(&grown) > before);
        let shrunk = erode(&grown, 1);
        assert!(mask_coverage(&shrunk) < mask_coverage(&grown));
    }

    /// Straightforward, obviously-correct serial reference the parallel
    /// [`morphology`] must match bit-for-bit.
    fn morphology_serial(mask: &GrayImage, radius: u32, grow: bool) -> GrayImage {
        if radius == 0 {
            return mask.clone();
        }
        let (width, height) = mask.dimensions();
        let r = radius as i32;
        let pick = |acc: u8, v: u8| if grow { acc.max(v) } else { acc.min(v) };
        let init = if grow { MASK_OFF } else { MASK_ON };
        let mut tmp = GrayImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let mut acc = init;
                for dx in -r..=r {
                    let sx = x as i32 + dx;
                    if sx >= 0 && (sx as u32) < width {
                        acc = pick(acc, mask.get_pixel(sx as u32, y).0[0]);
                    }
                }
                tmp.put_pixel(x, y, Luma([acc]));
            }
        }
        let mut out = GrayImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let mut acc = init;
                for dy in -r..=r {
                    let sy = y as i32 + dy;
                    if sy >= 0 && (sy as u32) < height {
                        acc = pick(acc, tmp.get_pixel(x, sy as u32).0[0]);
                    }
                }
                out.put_pixel(x, y, Luma([acc]));
            }
        }
        out
    }

    #[test]
    fn parallel_compose_alpha_matches_serial_reference() {
        // Deterministic LCG fills so the check needs no RNG dependency.
        let mut state: u32 = 0x0bad_c0de;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        };
        let (w, h) = (13u32, 11u32);
        let mut image = RgbaImage::new(w, h);
        for p in image.pixels_mut() {
            p.0 = [next(), next(), next(), next()];
        }
        let mut mask = GrayImage::new(w, h);
        for p in mask.pixels_mut() {
            p.0[0] = next();
        }
        // compose_alpha now walks the 16-bit surface; widen/narrow round-trips
        // 8-bit values exactly, so narrowing back reproduces the 8-bit contract.
        use super::super::working_image::WorkingSpace;
        let working = WorkingImage::from_rgba8(&image, WorkingSpace::Srgb, None);
        let got = compose_alpha(&working, &mask).to_rgba8();
        // Serial reference: RGB preserved, alpha taken from the mask.
        for y in 0..h {
            for x in 0..w {
                let src = image.get_pixel(x, y).0;
                let a = mask.get_pixel(x, y).0[0];
                assert_eq!(got.get_pixel(x, y).0, [src[0], src[1], src[2], a]);
            }
        }
    }

    #[test]
    fn parallel_morphology_matches_serial_reference() {
        // Deterministic LCG so the fuzz mask is reproducible without an RNG dep.
        let mut state: u32 = 0x1234_5678;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        };
        let mut mask = GrayImage::new(37, 23);
        for p in mask.pixels_mut() {
            // Mixed hard/soft edges: mostly 0/255 with some mid-tones.
            let v = next();
            p.0[0] = if v < 110 {
                MASK_OFF
            } else if v < 220 {
                MASK_ON
            } else {
                v
            };
        }
        for grow in [true, false] {
            for radius in [1u32, 2, 5, 13] {
                let got = morphology(&mask, radius, grow);
                let want = morphology_serial(&mask, radius, grow);
                assert_eq!(
                    got.as_raw(),
                    want.as_raw(),
                    "grow={grow} radius={radius} parallel morphology diverged from serial"
                );
            }
        }
    }

    #[test]
    fn fill_holes_closes_enclosed_gap() {
        // A 5x5 on-block with a single off pixel in the centre.
        let mut mask = solid(5, 5, MASK_ON);
        mask.put_pixel(2, 2, Luma([MASK_OFF]));
        fill_holes(&mut mask);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON);
    }

    #[test]
    fn fill_holes_leaves_open_background() {
        let mut mask = solid(5, 5, MASK_OFF);
        fill_holes(&mut mask);
        assert_eq!(mask_coverage(&mask), 0.0);
    }

    #[test]
    fn dodge_burn_region_lightens_and_darkens_under_coverage() {
        // A mid-grey mask: dodging lightens the covered pixels toward on,
        // burning darkens them toward off; outside the stroke is untouched.
        let mut mask = solid(21, 21, 128);
        let mut coverage = GrayImage::new(21, 21);
        stamp_stroke(&mut coverage, &[(10.0, 10.0)], 3, MASK_ON);
        dodge_burn_region(&mut mask, &coverage, false);
        assert_eq!(mask.get_pixel(10, 10).0[0], 192); // 128 + 127 * 0.5
        assert_eq!(mask.get_pixel(0, 0).0[0], 128); // outside the stroke
        dodge_burn_region(&mut mask, &coverage, true);
        assert_eq!(mask.get_pixel(10, 10).0[0], 96); // 192 * 0.5
    }

    #[test]
    fn sponge_region_pushes_toward_hard_or_mid() {
        // Above mid-grey, saturating pushes toward on; desaturating pulls
        // back toward mid-grey; below mid-grey, saturating pushes toward off.
        let mut mask = solid(21, 21, 192);
        let mut coverage = GrayImage::new(21, 21);
        stamp_stroke(&mut coverage, &[(10.0, 10.0)], 3, MASK_ON);
        sponge_region(&mut mask, &coverage, false);
        assert_eq!(mask.get_pixel(10, 10).0[0], 224); // 192 + 63 * 0.5, rounded
        assert_eq!(mask.get_pixel(0, 0).0[0], 192); // outside the stroke
        sponge_region(&mut mask, &coverage, true);
        assert_eq!(mask.get_pixel(10, 10).0[0], 176); // 224 + (128 - 224) * 0.5
        mask.put_pixel(10, 10, Luma([64]));
        sponge_region(&mut mask, &coverage, false);
        assert_eq!(mask.get_pixel(10, 10).0[0], 32);
    }

    #[test]
    fn healing_brush_region_blends_source_through_feathered_edge() {
        // An empty mask with an on-square at the top-left: healing with the
        // source offset pointing into the square copies it under the stroke
        // centre; far from the stroke stays untouched.
        let mut mask = solid(41, 41, MASK_OFF);
        for y in 0..=12 {
            for x in 0..=12 {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
        let mut coverage = GrayImage::new(41, 41);
        stamp_stroke(&mut coverage, &[(25.0, 25.0)], 4, MASK_ON);
        healing_brush_region(&mut mask, &coverage, -20, -20, 4);
        assert!(mask.get_pixel(25, 25).0[0] > 200); // sampled from (5, 5)
        assert_eq!(mask.get_pixel(38, 38).0[0], MASK_OFF); // far untouched
    }

    #[test]
    fn patch_op_refills_the_polygon_from_the_drop_offset() {
        // An empty mask with an on-square at the top-left: patching with the
        // drop offset pointing into the square refills the loop from it.
        let mut mask = solid(41, 41, MASK_OFF);
        for y in 0..=12 {
            for x in 0..=12 {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
        let image = RgbaImage::new(41, 41);
        let op = json!({
            "type": "patch",
            "points": [
                { "x": 20.0, "y": 20.0 },
                { "x": 32.0, "y": 20.0 },
                { "x": 32.0, "y": 32.0 },
                { "x": 20.0, "y": 32.0 },
            ],
            "dx": -20.0,
            "dy": -20.0,
        });
        let mut log = Vec::new();
        apply_queued_operation(&image, &mut mask, &op, 32, &mut log);
        assert!(mask.get_pixel(26, 26).0[0] > 200); // sampled from (6, 6)
        assert_eq!(mask.get_pixel(5, 39).0[0], MASK_OFF); // far untouched
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn perspective_crop_mask_straightens_the_quad() {
        // An axis-aligned quad is an identity warp inside its bounds and
        // clears everything outside.
        let mask = solid(40, 40, MASK_ON);
        let out = perspective_crop_mask(&mask, &[10.0, 10.0, 30.0, 10.0, 30.0, 30.0, 10.0, 30.0]);
        assert_eq!(out.get_pixel(20, 20).0[0], MASK_ON); // inside preserved
        assert_eq!(out.get_pixel(5, 5).0[0], MASK_OFF); // outside cleared

        // A skewed quad samples the quad's corner regions into the rect's.
        let mut m2 = GrayImage::new(40, 40);
        for y in 3..8 {
            for x in 27..33 {
                m2.put_pixel(x, y, Luma([MASK_ON])); // blob at the quad's TR
            }
        }
        let o2 = perspective_crop_mask(&m2, &[10.0, 10.0, 30.0, 5.0, 35.0, 35.0, 5.0, 30.0]);
        assert_eq!(o2.get_pixel(34, 5).0[0], MASK_ON); // rect TR ← quad TR blob
        assert_eq!(o2.get_pixel(6, 34).0[0], MASK_OFF); // rect BL far from blob
    }

    #[test]
    fn red_eye_select_floods_the_red_dominant_region() {
        // A red square on a grey image: clicking inside floods exactly the
        // contiguous red-dominant pixels; clicking grey is a no-op.
        let mut image = RgbaImage::from_pixel(21, 21, Rgba([90, 90, 90, 255]));
        for y in 8..13 {
            for x in 8..13 {
                image.put_pixel(x, y, Rgba([200, 60, 60, 255]));
            }
        }
        let mut mask = GrayImage::new(21, 21);
        red_eye_select(&image, &mut mask, 10, 10);
        assert_eq!(mask.get_pixel(10, 10).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(8, 8).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF);
        let mut untouched = GrayImage::new(21, 21);
        red_eye_select(&image, &mut untouched, 2, 2);
        assert!(untouched.pixels().all(|p| p.0[0] == MASK_OFF));
    }

    #[test]
    fn object_select_op_masks_the_object_inside_the_box() {
        // A distinct block on a uniform background: the box constrains the
        // segmenter (builtin fallback in tests) to the object inside it.
        let mut image = RgbaImage::from_pixel(41, 41, Rgba([230, 230, 230, 255]));
        for y in 15..26 {
            for x in 15..26 {
                image.put_pixel(x, y, Rgba([20, 30, 200, 255]));
            }
        }
        let mut mask = GrayImage::new(41, 41);
        let op = json!({ "type": "object_select", "region": [10.0, 10.0, 30.0, 30.0] });
        let mut log = Vec::new();
        apply_queued_operation(&image, &mut mask, &op, 32, &mut log);
        assert_eq!(mask.get_pixel(20, 20).0[0], MASK_ON); // object selected
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_OFF); // background untouched
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn remove_op_subtracts_the_segmented_object() {
        // A distinct block on a uniform background, mask fully on: a stroke
        // over the block seeds the segmenter and subtracts the object.
        let mut image = RgbaImage::from_pixel(41, 41, Rgba([230, 230, 230, 255]));
        for y in 15..26 {
            for x in 15..26 {
                image.put_pixel(x, y, Rgba([20, 30, 200, 255]));
            }
        }
        let mut mask = solid(41, 41, MASK_ON);
        let op = json!({
            "type": "remove",
            "amount": 6.0,
            "points": [{ "x": 20.0, "y": 20.0 }],
        });
        let mut log = Vec::new();
        apply_queued_operation(&image, &mut mask, &op, 32, &mut log);
        assert_eq!(mask.get_pixel(20, 20).0[0], MASK_OFF); // object removed
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON); // background kept
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn content_aware_move_op_moves_the_loop_and_heals_the_hole() {
        // An on-square inside the lassoed loop, everything else off: moving
        // it carries the values to the drop offset and heals the source hole
        // from its (off) surroundings.
        let mut mask = solid(41, 41, MASK_OFF);
        for y in 6..=18 {
            for x in 6..=18 {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
        let image = RgbaImage::new(41, 41);
        let op = json!({
            "type": "content_aware_move",
            "points": [
                { "x": 6.0, "y": 6.0 },
                { "x": 18.0, "y": 6.0 },
                { "x": 18.0, "y": 18.0 },
                { "x": 6.0, "y": 18.0 },
            ],
            "dx": 20.0,
            "dy": 20.0,
        });
        let mut log = Vec::new();
        apply_queued_operation(&image, &mut mask, &op, 32, &mut log);
        assert!(mask.get_pixel(32, 32).0[0] > 200); // moved to the drop site
        assert!(mask.get_pixel(12, 12).0[0] < 200); // source hole healed
        assert_eq!(mask.get_pixel(2, 39).0[0], MASK_OFF); // far untouched
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn pattern_stamp_region_paints_the_checker() {
        let mut mask = GrayImage::new(21, 21);
        let mut coverage = GrayImage::new(21, 21);
        stamp_stroke(&mut coverage, &[(10.0, 10.0)], 5, MASK_ON);
        pattern_stamp_region(&mut mask, &coverage);
        assert_eq!(mask.get_pixel(8, 8).0[0], MASK_ON); // even checker cell
        assert_eq!(mask.get_pixel(8, 7).0[0], MASK_OFF); // odd checker cell
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF); // outside untouched
    }

    #[test]
    fn art_history_region_restores_base_through_jitter() {
        // Base fully on, mask empty: brushing restores the covered pixels to
        // on (the jitter reads a uniform base), outside stays off.
        let base = solid(21, 21, MASK_ON);
        let mut mask = GrayImage::new(21, 21);
        let mut coverage = GrayImage::new(21, 21);
        stamp_stroke(&mut coverage, &[(10.0, 10.0)], 4, MASK_ON);
        art_history_region(&mut mask, &base, &coverage, 4);
        assert_eq!(mask.get_pixel(10, 10).0[0], MASK_ON); // restored
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF); // outside untouched
    }

    #[test]
    fn background_erase_clears_matching_colours_inside_disc() {
        // Left half dark, right half bright, mask fully on: erasing with the
        // brush centred in the dark half clears only dark pixels in the disc.
        let mut image = RgbaImage::new(21, 21);
        for (x, _y, p) in image.enumerate_pixels_mut() {
            let v = if x < 10 { 10 } else { 240 };
            p.0 = [v, v, v, 255];
        }
        let mut mask = solid(21, 21, MASK_ON);
        background_erase(&image, &mut mask, &[(9.0, 10.0)], 4, 32);
        assert_eq!(mask.get_pixel(9, 10).0[0], MASK_OFF); // centre erased
        assert_eq!(mask.get_pixel(12, 10).0[0], MASK_ON); // bright side kept
        assert_eq!(mask.get_pixel(2, 10).0[0], MASK_ON); // outside the disc
    }

    #[test]
    fn history_region_restores_base_under_coverage() {
        // Base is empty; the current mask is fully on: brushing restores the
        // covered pixels to the empty base and leaves the rest on.
        let base = solid(21, 21, MASK_OFF);
        let mut mask = solid(21, 21, MASK_ON);
        let mut coverage = GrayImage::new(21, 21);
        stamp_stroke(&mut coverage, &[(10.0, 10.0)], 3, MASK_ON);
        history_region(&mut mask, &base, &coverage);
        assert_eq!(mask.get_pixel(10, 10).0[0], MASK_OFF); // restored
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON); // outside the stroke
    }

    #[test]
    fn clone_region_copies_from_source_offset() {
        // An empty mask with an on-square at the top-left: cloning with the
        // source offset pointing into the square copies it under the stroke;
        // an out-of-bounds source reads as empty.
        let mut mask = solid(31, 31, MASK_OFF);
        for y in 2..=8 {
            for x in 2..=8 {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
        let mut coverage = GrayImage::new(31, 31);
        stamp_stroke(&mut coverage, &[(20.0, 20.0)], 3, MASK_ON);
        clone_region(&mut mask, &coverage, -15, -15);
        assert_eq!(mask.get_pixel(20, 20).0[0], MASK_ON); // sampled from (5, 5)
        assert_eq!(mask.get_pixel(28, 28).0[0], MASK_OFF); // outside the stroke
        let mut oob = GrayImage::new(31, 31);
        stamp_stroke(&mut oob, &[(29.0, 29.0)], 1, MASK_ON);
        mask.put_pixel(29, 29, Luma([MASK_ON]));
        clone_region(&mut mask, &oob, 15, 15);
        assert_eq!(mask.get_pixel(29, 29).0[0], MASK_OFF);
    }

    #[test]
    fn heal_region_rebuilds_blemish_from_surroundings() {
        // A solid mask with an off blemish in the middle: healing over it
        // pulls the region back toward the surrounding on-value, leaving
        // pixels outside the coverage untouched.
        let mut mask = solid(31, 31, MASK_ON);
        stamp_disc(&mut mask, 15.0, 15.0, 4, MASK_OFF);
        assert_eq!(mask.get_pixel(15, 15).0[0], MASK_OFF);
        let mut coverage = GrayImage::new(31, 31);
        stamp_stroke(&mut coverage, &[(15.0, 15.0)], 6, MASK_ON);
        heal_region(&mut mask, &coverage);
        assert!(mask.get_pixel(15, 15).0[0] > 200);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON);
    }

    #[test]
    fn empty_selection_yields_transparent_cutout() {
        use super::super::working_image::WorkingSpace;
        let image = RgbaImage::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
        let mask = solid(4, 4, MASK_OFF);
        let working = WorkingImage::from_rgba8(&image, WorkingSpace::Srgb, None);
        let alpha = compose_alpha(&working, &mask);
        // Alpha is the (16-bit) mask sample: MASK_OFF -> fully transparent.
        assert_eq!(alpha.pixels[3], 0);
        let cutout = cutout_to_bbox(&alpha, &mask);
        assert_eq!((cutout.width, cutout.height), (1, 1));
        assert_eq!(cutout.pixels[3], 0);
        assert_eq!(mask_coverage(&mask), 0.0);
    }

    #[test]
    fn invert_flips_mask() {
        let mut mask = solid(2, 2, MASK_OFF);
        invert(&mut mask);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON);
    }

    #[test]
    fn select_all_fills_and_delete_clears_as_history_steps() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "select_all" }] }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("select_all")));

        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "select_all" }, { "type": "delete" }] }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_OFF));
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("delete")));
    }

    #[test]
    fn gradient_op_composites_a_linear_ramp() {
        let image = RgbaImage::from_pixel(32, 32, Rgba([0, 0, 0, 255]));
        // Left-to-right ramp across the full width: full at x=0, none at x=w.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "gradient", "region": [0, 16, 32, 16] }] }
        ]});
        let mut add = solid(32, 32, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut add, Some(&doc), 24, &mut operations);
        assert!(add.get_pixel(0, 0).0[0] > 240);
        assert!(add.get_pixel(31, 0).0[0] < 15);
        let mid = add.get_pixel(16, 0).0[0];
        assert!(mid > 100 && mid < 155);
        assert_eq!(add.get_pixel(0, 31).0[0], add.get_pixel(0, 0).0[0]);
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("gradient")));

        // Subtract cuts the ramp out of a full mask (complement of add).
        let doc = json!({ "version": 3, "layers": [
            { "ops": [
                { "type": "select_all" },
                { "type": "gradient", "region": [0, 16, 32, 16], "mode": "subtract" }
            ] }
        ]});
        let mut sub = solid(32, 32, MASK_OFF);
        apply_edit_paths(&image, &mut sub, Some(&doc), 24, &mut Vec::new());
        for x in 0..32 {
            assert_eq!(sub.get_pixel(x, 0).0[0], 255 - add.get_pixel(x, 0).0[0]);
        }

        // Degenerate (zero-length) drags are a no-op.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "gradient", "region": [3, 16, 3, 16] }] }
        ]});
        let mut none = solid(32, 32, MASK_OFF);
        apply_edit_paths(&image, &mut none, Some(&doc), 24, &mut Vec::new());
        assert!(none.as_raw().iter().all(|&px| px == MASK_OFF));
    }

    #[test]
    fn fill_op_floods_at_an_opacity() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        // 100% add fill ≡ select all.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "fill" }] }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("fill")));

        // 50% add on an empty layer lands halfway (mirrors the proxy).
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "fill", "amount": 50 }] }
        ]});
        let mut half = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut half, Some(&doc), 24, &mut Vec::new());
        assert!(half.as_raw().iter().all(|&px| px == 128));

        // 50% subtract on a full mask scales it down to half.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [
                { "type": "select_all" },
                { "type": "fill", "mode": "subtract", "amount": 50 }
            ] }
        ]});
        let mut sub = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut sub, Some(&doc), 24, &mut Vec::new());
        assert!(sub.as_raw().iter().all(|&px| px == 128));

        // 100% subtract ≡ delete; 0% is the identity.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [
                { "type": "select_all" },
                { "type": "fill", "mode": "subtract", "amount": 100 },
                { "type": "fill", "amount": 0 }
            ] }
        ]});
        let mut wiped = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut wiped, Some(&doc), 24, &mut Vec::new());
        assert!(wiped.as_raw().iter().all(|&px| px == MASK_OFF));
    }

    #[test]
    fn parses_brush_points_from_pairs_and_objects() {
        let value = json!({
            "brush_strokes": [
                { "mode": "add", "radius": 1, "points": [[1, 1], {"x": 2, "y": 2}] }
            ]
        });
        let mut mask = solid(5, 5, MASK_OFF);
        let mut ops = Vec::new();
        apply_edit_paths(
            &RgbaImage::from_pixel(5, 5, Rgba([0, 0, 0, 255])),
            &mut mask,
            Some(&value),
            24,
            &mut ops,
        );
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn lasso_path_rasterises_as_filled_polygon() {
        // A straight-edged rectangle lasso [2,2]..[7,6] on a 10x10 mask.
        let value = json!({
            "paths": [{
                "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
                "points": [
                    { "x": 2, "y": 2 }, { "x": 8, "y": 2 },
                    { "x": 8, "y": 7 }, { "x": 2, "y": 7 }
                ]
            }]
        });
        let mut mask = solid(10, 10, MASK_OFF);
        let mut ops = Vec::new();
        apply_edit_paths(
            &RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255])),
            &mut mask,
            Some(&value),
            24,
            &mut ops,
        );
        assert_eq!(mask.get_pixel(4, 4).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(9, 9).0[0], MASK_OFF);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["type"], "path_add");
        assert_eq!(ops[0]["tool"], "lasso");
    }

    #[test]
    fn subtract_and_intersect_paths_boolean_combine() {
        let mut mask = solid(10, 10, MASK_ON);
        let subtract = json!({
            "paths": [{
                "id": "p1", "mode": "subtract", "tool": "lasso", "closed": true,
                "points": [
                    { "x": 0, "y": 0 }, { "x": 5, "y": 0 },
                    { "x": 5, "y": 10 }, { "x": 0, "y": 10 }
                ]
            }]
        });
        let image = RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255]));
        apply_edit_paths(&image, &mut mask, Some(&subtract), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(2, 5).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(7, 5).0[0], MASK_ON);

        let intersect = json!({
            "paths": [{
                "id": "p2", "mode": "intersect", "tool": "lasso", "closed": true,
                "points": [
                    { "x": 6, "y": 0 }, { "x": 10, "y": 0 },
                    { "x": 10, "y": 4 }, { "x": 6, "y": 4 }
                ]
            }]
        });
        apply_edit_paths(&image, &mut mask, Some(&intersect), 24, &mut Vec::new());
        // Only the on-pixels inside the intersect region survive.
        assert_eq!(mask.get_pixel(7, 2).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(7, 8).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_OFF);
    }

    #[test]
    fn pen_path_with_bezier_handles_bulges_past_the_chord() {
        // A triangle whose top edge bows upward via control handles: the curve
        // must select pixels above the straight chord between its anchors.
        let value = json!({
            "paths": [{
                "id": "p1", "mode": "add", "tool": "pen", "closed": true,
                "points": [
                    { "x": 4, "y": 20, "out": [4, 2] },
                    { "x": 26, "y": 20, "in": [26, 2] },
                    { "x": 15, "y": 28 }
                ]
            }]
        });
        let mut mask = solid(30, 30, MASK_OFF);
        apply_edit_paths(
            &RgbaImage::from_pixel(30, 30, Rgba([0, 0, 0, 255])),
            &mut mask,
            Some(&value),
            24,
            &mut Vec::new(),
        );
        // Above the chord y=20 (the bezier bulge) is selected...
        assert_eq!(mask.get_pixel(15, 10).0[0], MASK_ON);
        // ...the interior below the chord too, and the far corner is not.
        assert_eq!(mask.get_pixel(15, 22).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF);
    }

    #[test]
    fn open_or_degenerate_paths_are_ignored_below_three_anchors() {
        let value = json!({
            "paths": [{
                "id": "p1", "mode": "add", "tool": "pen", "closed": false,
                "points": [ { "x": 1, "y": 1 }, { "x": 8, "y": 8 } ]
            }]
        });
        let mut mask = solid(10, 10, MASK_OFF);
        let mut ops = Vec::new();
        apply_edit_paths(
            &RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255])),
            &mut mask,
            Some(&value),
            24,
            &mut ops,
        );
        assert_eq!(mask_coverage(&mask), 0.0);
        assert!(ops.is_empty());
    }

    #[test]
    fn queued_operations_apply_marquee_and_morphology() {
        // The Mask-Edit modal records `operations` (type/amount/region): a rect
        // marquee fill, then a whole-mask invert.
        let value = json!({
            "operations": [
                { "type": "rect", "region": [2, 2, 8, 7] },
                { "type": "invert" }
            ]
        });
        let mut mask = solid(10, 10, MASK_OFF);
        let mut ops = Vec::new();
        apply_edit_paths(
            &RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255])),
            &mut mask,
            Some(&value),
            24,
            &mut ops,
        );
        // Rect filled then inverted: inside off, outside on.
        assert_eq!(mask.get_pixel(4, 4).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON);
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn queued_wand_operation_reads_region_seed_and_amount_tolerance() {
        // Left half red, right half blue (as in the direct wand test), recorded
        // in the modal's `operations` shape: region = seed, amount = tolerance.
        let mut image = RgbaImage::new(4, 2);
        for y in 0..2 {
            for x in 0..4 {
                let colour = if x < 2 {
                    Rgba([200, 0, 0, 255])
                } else {
                    Rgba([0, 0, 200, 255])
                };
                image.put_pixel(x, y, colour);
            }
        }
        let value = json!({
            "operations": [ { "type": "wand", "amount": 20, "region": [0, 0] } ]
        });
        let mut mask = solid(4, 2, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(3, 1).0[0], MASK_OFF);
    }

    #[test]
    fn parses_point_prompt_labels_with_legacy_fallback() {
        // Legacy `[x, y]` pairs and label-less objects read as positive; an
        // object with `label: 0` reads as a negative (exclude) point.
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
        // The legacy inline wand is rewritten to the queued shape (clamped).
        assert_eq!(ops[1]["region"], json!([1, 2]));
        assert_eq!(ops[1]["amount"], json!(255));
        // Non-sequential fields survive unchanged.
        assert_eq!(migrated["matte_strokes"].as_array().unwrap().len(), 1);
        assert_eq!(migrated["points"], json!([[10, 20]]));
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
        // Malformed / absent canvas is dropped (keep the source size).
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
        // Unknown resample names fall back to auto: bilinear on a downscale,
        // Lanczos on an upscale.
        let doc = json!({ "canvas": { "w": 64, "h": 32, "resample": "mystery" } });
        let canvas = parse_canvas_size(Some(&doc)).unwrap();
        assert_eq!(canvas.filter(128, 64), imageops::FilterType::Triangle);
        assert_eq!(canvas.filter(32, 16), imageops::FilterType::Lanczos3);
        assert_eq!(parse_canvas_size(Some(&json!({ "version": 3 }))), None);
    }

    #[test]
    fn migrated_version1_replays_identically_to_legacy_semantics() {
        // Golden: a v1 record and its migrated v3 form must rasterise the same.
        let legacy = json!({
            "version": 1,
            "paths": [{ "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
                        "points": [{ "x": 2, "y": 2 }, { "x": 8, "y": 2 },
                                   { "x": 8, "y": 7 }, { "x": 2, "y": 7 }] }],
            "brush_strokes": [{ "id": "s1", "mode": "subtract", "radius": 1, "points": [[4, 4]] }],
            "operations": [{ "type": "invert" }]
        });
        let image = RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255]));
        let mut legacy_mask = solid(10, 10, MASK_OFF);
        apply_edit_paths(&image, &mut legacy_mask, Some(&legacy), 24, &mut Vec::new());
        let migrated = migrate_edit_paths(legacy);
        let mut migrated_mask = solid(10, 10, MASK_OFF);
        apply_edit_paths(
            &image,
            &mut migrated_mask,
            Some(&migrated),
            24,
            &mut Vec::new(),
        );
        assert_eq!(legacy_mask.as_raw(), migrated_mask.as_raw());
    }

    #[test]
    fn version2_ops_replay_in_recorded_order() {
        // invert *then* brush must differ from brush *then* invert: the stack
        // is ordered, unlike the v1 per-kind arrays.
        let image = RgbaImage::from_pixel(5, 5, Rgba([0, 0, 0, 255]));
        let brush = json!({ "type": "brush", "mode": "add", "radius": 0, "points": [[2, 2]] });
        let invert_first = json!({ "version": 2, "ops": [{ "type": "invert" }, brush.clone()] });
        let mut mask = solid(5, 5, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&invert_first), 24, &mut Vec::new());
        // Everything on (inverted), the brush re-adds inside it.
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_ON);

        let brush_first = json!({ "version": 2, "ops": [brush, { "type": "invert" }] });
        let mut mask = solid(5, 5, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&brush_first), 24, &mut Vec::new());
        // Brush dot then invert: the dot is off, the rest on.
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON);
    }

    #[test]
    fn disabled_ops_are_skipped_on_replay() {
        // A `disabled: true` step stays recorded (history panel) but must not
        // affect the rasterised mask.
        let image = RgbaImage::from_pixel(5, 5, Rgba([0, 0, 0, 255]));
        let value = json!({
            "version": 2,
            "ops": [
                { "type": "brush", "mode": "add", "radius": 0, "points": [[2, 2]], "disabled": true },
                { "type": "invert", "disabled": true }
            ]
        });
        let mut mask = solid(5, 5, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_OFF));
        assert!(operations.is_empty());
    }

    #[test]
    fn transform_op_translates_the_mask() {
        // M5: a `transform` step with only dx/dy moves the mask verbatim.
        let image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        let value = json!({
            "version": 2,
            "ops": [
                { "type": "brush", "mode": "add", "radius": 0, "points": [[2, 2]] },
                { "type": "transform", "dx": 3, "dy": 1 }
            ]
        });
        let mut mask = solid(9, 9, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(5, 3).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(2, 2).0[0], MASK_OFF);
    }

    #[test]
    fn transform_op_rotates_about_the_centre() {
        // 90° clockwise about the centre of a 9x9: (2,4) → (4,2).
        let image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        let value = json!({
            "version": 2,
            "ops": [
                { "type": "brush", "mode": "add", "radius": 0, "points": [[2, 4]] },
                { "type": "transform", "rotate": 90 }
            ]
        });
        let mut mask = solid(9, 9, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(4, 2).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(2, 4).0[0], MASK_OFF);
    }

    #[test]
    fn identity_transform_is_a_noop() {
        let image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        let value = json!({
            "version": 2,
            "ops": [
                { "type": "invert" },
                { "type": "transform" }
            ]
        });
        let mut mask = solid(9, 9, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
        // Only the invert is recorded: the identity transform is skipped.
        assert_eq!(operations.len(), 1);
    }

    #[test]
    fn crop_op_clears_the_mask_outside_the_region() {
        let image = RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255]));
        let value = json!({
            "version": 2,
            "ops": [
                { "type": "invert" },
                { "type": "crop", "region": [3, 3, 7, 7] }
            ]
        });
        let mut mask = solid(10, 10, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&value), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(5, 5).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_OFF);
        assert_eq!(mask.get_pixel(9, 9).0[0], MASK_OFF);
    }

    #[test]
    fn single_layer_document_replays_byte_identically_to_flat_ops() {
        // M3 acceptance: a one-layer v3 document must rasterise exactly like
        // the same ops as a flat v2 stack (no compositing side-effects).
        let image = RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 255]));
        let ops = json!([
            { "type": "path", "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
              "points": [{ "x": 2, "y": 2 }, { "x": 8, "y": 2 }, { "x": 8, "y": 7 }, { "x": 2, "y": 7 }] },
            { "type": "brush", "mode": "subtract", "radius": 1, "points": [[4, 4]] },
            { "type": "invert" }
        ]);
        let flat = json!({ "version": 2, "ops": ops });
        let mut flat_mask = solid(10, 10, MASK_OFF);
        apply_edit_paths(&image, &mut flat_mask, Some(&flat), 24, &mut Vec::new());

        let layered = json!({ "version": 3, "layers": [{ "ops": ops }], "active": 0 });
        let mut layered_mask = solid(10, 10, MASK_OFF);
        apply_edit_paths(
            &image,
            &mut layered_mask,
            Some(&layered),
            24,
            &mut Vec::new(),
        );
        assert_eq!(flat_mask.as_raw(), layered_mask.as_raw());
    }

    #[test]
    fn upper_layers_composite_per_blend_and_opacity() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let base = json!({ "type": "invert" }); // background: everything on
        let dot = json!({ "type": "brush", "mode": "add", "radius": 0, "points": [[1, 1]] });

        // normal @ 100%: the upper layer's surface replaces the background.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [base.clone()] },
            { "ops": [dot.clone()], "blend": "normal", "opacity": 1.0 }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF);

        // multiply: the dark upper surface knocks the background out except the dot.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [base.clone()] },
            { "ops": [dot.clone()], "blend": "multiply", "opacity": 1.0 }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_OFF);

        // screen: union — the background stays on everywhere.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [base.clone()] },
            { "ops": [dot.clone()], "blend": "screen", "opacity": 1.0 }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(1, 1).0[0], MASK_ON);
        assert_eq!(mask.get_pixel(0, 0).0[0], MASK_ON);

        // normal @ 50%: half-way between background (on) and surface (off).
        let doc = json!({ "version": 3, "layers": [
            { "ops": [base] },
            { "ops": [dot], "blend": "normal", "opacity": 0.5 }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert_eq!(mask.get_pixel(0, 0).0[0], 128);
    }

    #[test]
    fn blend_value_covers_the_full_mode_set() {
        assert_eq!(blend_value(100.0, 200.0, "normal"), 200.0);
        assert_eq!(blend_value(102.0, 51.0, "multiply"), 102.0 * 51.0 / 255.0);
        assert_eq!(
            blend_value(102.0, 51.0, "screen"),
            255.0 - (255.0 - 102.0) * (255.0 - 51.0) / 255.0
        );
        assert_eq!(blend_value(100.0, 200.0, "darken"), 100.0);
        assert_eq!(blend_value(100.0, 200.0, "lighten"), 200.0);
        assert_eq!(blend_value(100.0, 200.0, "difference"), 100.0);
        assert_eq!(blend_value(100.0, 200.0, "unknown"), 200.0); // falls back to normal
    }

    #[test]
    fn adjustment_layers_tone_map_the_composite_below() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        // Background all-on; a −100 brightness adjustment crushes it to black.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "invert" }] },
            { "kind": "adjustment", "ops": [],
              "adjustment": { "type": "brightness_contrast", "brightness": -100 } }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_OFF));
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("adjustment")));

        // Half opacity lerps halfway toward the mapped value.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "invert" }] },
            { "kind": "adjustment", "ops": [], "opacity": 0.5,
              "adjustment": { "type": "brightness_contrast", "brightness": -100 } }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert!(mask.as_raw().iter().all(|&px| px == 128));

        // Hidden adjustment layers are skipped.
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "invert" }] },
            { "kind": "adjustment", "ops": [], "visible": false,
              "adjustment": { "type": "brightness_contrast", "brightness": -100 } }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut Vec::new());
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
    }

    #[test]
    fn adjustment_lut_matches_the_proxy_formulas() {
        // Mirrors the vitest cases over `adjustmentLut` in
        // `maskMorphology.test.ts` — the two implementations must agree.
        let levels = adjustment_lut("levels", &json!({ "in_black": 64, "in_white": 192 })).unwrap();
        assert_eq!(levels[64], 0);
        assert_eq!(levels[128], 128);
        assert_eq!(levels[192], 255);

        let curve = adjustment_lut(
            "curve",
            &json!({ "points": [[0, 0], [128, 192], [255, 255]] }),
        )
        .unwrap();
        assert_eq!(curve[64], 96);
        assert_eq!(curve[128], 192);
        let identity = adjustment_lut("curve", &json!({})).unwrap();
        assert_eq!(identity[77], 77);

        let bc = adjustment_lut("brightness_contrast", &json!({ "contrast": 100 })).unwrap();
        assert_eq!(bc[64], 1);
        assert_eq!(bc[192], 255);

        assert!(adjustment_lut("posterize", &json!({})).is_none());
    }

    #[test]
    fn upper_layer_replay_is_cached_and_a_hit_reproduces_the_run() {
        let image = RgbaImage::from_pixel(6, 6, Rgba([0, 0, 0, 255]));
        let doc = json!({ "version": 3, "layers": [
            { "ops": [] },
            { "ops": [
                { "type": "brush", "mode": "add", "radius": 1, "points": [[2, 2]] },
                { "type": "grow", "amount": 1 }
            ], "blend": "screen", "opacity": 0.5 }
        ]});

        // First run populates the replay cache; the second must hit it and
        // produce a byte-identical mask and operations log.
        let mut first_mask = solid(6, 6, MASK_OFF);
        let mut first_ops = Vec::new();
        apply_edit_paths(&image, &mut first_mask, Some(&doc), 24, &mut first_ops);
        let mut second_mask = solid(6, 6, MASK_OFF);
        let mut second_ops = Vec::new();
        apply_edit_paths(&image, &mut second_mask, Some(&doc), 24, &mut second_ops);
        assert_eq!(first_mask.as_raw(), second_mask.as_raw());
        assert_eq!(first_ops, second_ops);
    }

    #[test]
    fn replay_cache_keys_separate_dims_ops_tolerance_and_wand_pixels() {
        let dark = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let light = RgbaImage::from_pixel(4, 4, Rgba([255, 255, 255, 255]));
        let brush = json!([{ "type": "brush", "mode": "add", "radius": 1, "points": [[1, 1]] }]);
        let grow = json!([{ "type": "grow", "amount": 2 }]);
        let wand = json!([{ "type": "wand", "region": [1, 1] }]);

        let base = replay_cache::layer_key(4, 4, Some(&brush), 24, &dark);
        assert_ne!(base, replay_cache::layer_key(8, 4, Some(&brush), 24, &dark));
        assert_ne!(base, replay_cache::layer_key(4, 4, Some(&grow), 24, &dark));
        assert_ne!(base, replay_cache::layer_key(4, 4, Some(&brush), 32, &dark));
        // Pixel-independent ops ignore the image; a wand stack keys on it.
        assert_eq!(
            base,
            replay_cache::layer_key(4, 4, Some(&brush), 24, &light)
        );
        assert_ne!(
            replay_cache::layer_key(4, 4, Some(&wand), 24, &dark),
            replay_cache::layer_key(4, 4, Some(&wand), 24, &light),
        );
    }

    #[test]
    fn replay_cache_lru_roundtrips_and_evicts_oldest() {
        // Distinct high keys so this test cannot collide with entries other
        // tests put in the process-global cache.
        let surface = |v: u8| GrayImage::from_pixel(2, 2, Luma([v]));
        let k = |i: u64| 0xDEAD_BEEF_0000_0000 + i;
        for i in 0..6 {
            replay_cache::put(k(i), surface(i as u8), vec![json!({ "i": i })]);
        }
        // Capacity is 4: the two oldest fell out. (Concurrent tests only add
        // entries, which can only evict more — never resurrect these.)
        assert!(replay_cache::get(k(0)).is_none());
        assert!(replay_cache::get(k(1)).is_none());
        // Roundtrip: a fresh put is immediately readable with its log.
        replay_cache::put(k(5), surface(5), vec![json!({ "i": 5 })]);
        let (hit, log) = replay_cache::get(k(5)).expect("newest entry resident");
        assert_eq!(hit.get_pixel(0, 0).0[0], 5);
        assert_eq!(log, vec![json!({ "i": 5 })]);
    }

    #[test]
    fn blur_and_sharpen_ops_are_revisable_filter_steps() {
        let image = RgbaImage::from_pixel(12, 12, Rgba([0, 0, 0, 255]));
        // A blurred block gains soft (intermediate) edge alpha.
        let doc = json!({ "version": 2, "ops": [
            { "type": "path", "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
              "points": [{ "x": 3, "y": 3 }, { "x": 9, "y": 3 }, { "x": 9, "y": 9 }, { "x": 3, "y": 9 }] },
            { "type": "blur", "amount": 2 }
        ]});
        let mut blurred = solid(12, 12, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut blurred, Some(&doc), 24, &mut operations);
        assert!(blurred.as_raw().iter().any(|&px| px > 0 && px < 255));
        assert!(operations
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("blur")));

        // Sharpening the blurred result re-steepens the edge (fewer mid greys).
        let doc = json!({ "version": 2, "ops": [
            { "type": "path", "id": "p1", "mode": "add", "tool": "lasso", "closed": true,
              "points": [{ "x": 3, "y": 3 }, { "x": 9, "y": 3 }, { "x": 9, "y": 9 }, { "x": 3, "y": 9 }] },
            { "type": "blur", "amount": 2 },
            { "type": "sharpen", "amount": 2 }
        ]});
        let mut sharpened = solid(12, 12, MASK_OFF);
        apply_edit_paths(&image, &mut sharpened, Some(&doc), 24, &mut Vec::new());
        let mids = |m: &GrayImage| m.as_raw().iter().filter(|&&v| v > 32 && v < 224).count();
        assert!(mids(&sharpened) < mids(&blurred));

        // Zero-amount filter steps are no-ops and stay unrecorded.
        let doc = json!({ "version": 2, "ops": [
            { "type": "invert" },
            { "type": "blur", "amount": 0 },
            { "type": "sharpen", "amount": 0 }
        ]});
        let mut mask = solid(12, 12, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
        assert_eq!(operations.len(), 1);
    }

    #[test]
    fn hidden_layers_are_skipped_by_the_compositor() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let doc = json!({ "version": 3, "layers": [
            { "ops": [] },
            { "ops": [{ "type": "invert" }], "visible": false }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_OFF));
        assert!(operations.is_empty());
    }

    #[test]
    fn empty_upper_layers_leave_the_composite_untouched() {
        // A duplicated / freshly added layer with no edits (PS: a fully
        // transparent layer) must not wipe the composite via a normal blend.
        let image = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let doc = json!({ "version": 3, "layers": [
            { "ops": [{ "type": "invert" }] },
            { "ops": [] }
        ]});
        let mut mask = solid(4, 4, MASK_OFF);
        let mut operations = Vec::new();
        apply_edit_paths(&image, &mut mask, Some(&doc), 24, &mut operations);
        assert!(mask.as_raw().iter().all(|&px| px == MASK_ON));
        assert_eq!(operations.len(), 1);
    }

    #[test]
    fn matte_strokes_paint_trimap_unknown_band() {
        // The Matting brush records `matte_strokes`; parsing them and stamping
        // onto the trimap must mark exactly the painted disc as the unknown
        // level (the matter then resolves soft alpha there), leaving the rest of
        // a fully-foreground trimap untouched.
        let value = json!({
            "matte_strokes": [
                { "mode": "add", "radius": 2, "points": [[5, 5]] },
                { "radius": 1, "points": [] }
            ]
        });
        let strokes = parse_matte_strokes(Some(&value));
        assert_eq!(strokes.len(), 1, "empty-point stroke is dropped");

        let mask = solid(11, 11, MASK_ON);
        let mut trimap = subject_matte::trimap_from_mask(&mask, 0);
        assert_eq!(trimap.get_pixel(5, 5).0[0], subject_matte::TRIMAP_FG);
        for (points, radius) in &strokes {
            stamp_stroke(&mut trimap, points, *radius, subject_matte::TRIMAP_UNKNOWN);
        }
        assert_eq!(trimap.get_pixel(5, 5).0[0], subject_matte::TRIMAP_UNKNOWN);
        assert_eq!(trimap.get_pixel(0, 0).0[0], subject_matte::TRIMAP_FG);
    }

    #[test]
    fn auto_mode_segments_base_and_reports_provider() {
        // A grey scene with a red block; auto_subject should segment the block
        // as the base matte, report the builtin provider, and list one subject.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_subject_auto_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(12, 12, Rgba([120, 120, 120, 255]));
        for y in 4..8 {
            for x in 4..8 {
                image.put_pixel(x, y, Rgba([220, 20, 20, 255]));
            }
        }
        image.save(&image_path).unwrap();

        let mut params = BTreeMap::new();
        params.insert("mode".to_string(), json!("auto_subject"));
        params.insert(
            "output_dir".to_string(),
            json!(root.to_string_lossy().to_string()),
        );
        params.insert("output_name".to_string(), json!("scene_mask"));
        let node = StudioGraphNode {
            id: "n1".to_string(),
            kind: "subjectMask".to_string(),
            params,
        };
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "image".to_string(),
            json!(image_path.to_string_lossy().to_string()),
        );

        let out = run(&node, &inputs);
        let report = out.get("matte_report").unwrap();
        // An auto mode reports the segmenter that produced the base matte: the
        // builtin fallback, or a model backend (u2netp / birefnet) when a weight
        // resolves. All are valid; the point is it is no longer manual
        // `rust-native`.
        let provider = report.get("provider").and_then(Value::as_str).unwrap();
        assert!(
            matches!(provider, "builtin-cpu" | "u2netp" | "birefnet"),
            "unexpected auto provider {provider}"
        );
        assert_eq!(
            report.get("mode").and_then(Value::as_str),
            Some("auto_subject")
        );
        let subjects = report
            .get("detected_subjects")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(subjects.len(), 1);
        let coverage = report.get("mask_coverage").and_then(Value::as_f64).unwrap();
        assert!(coverage > 0.0 && coverage <= 1.0, "coverage={coverage}");
        // An auto mode always carries engine telemetry (shared DeviceReport
        // vocabulary) with a visible reason when it did not accelerate.
        let engine = report.get("engine").and_then(Value::as_str).unwrap();
        assert!(
            matches!(engine, "cpu" | "onnxruntime"),
            "unexpected engine {engine}"
        );
        assert_eq!(report.get("device").and_then(Value::as_str), Some("cpu"));
        assert_eq!(
            report.get("device_requested").and_then(Value::as_str),
            Some("auto")
        );
        assert!(report
            .get("engine_fallback_reason")
            .and_then(Value::as_str)
            .is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manual_mode_keeps_rust_native_provider() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_subject_manual_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(6, 6, Rgba([100, 100, 100, 255]))
            .save(&image_path)
            .unwrap();

        let mut params = BTreeMap::new();
        params.insert("mode".to_string(), json!("manual_brush"));
        params.insert(
            "output_dir".to_string(),
            json!(root.to_string_lossy().to_string()),
        );
        params.insert("output_name".to_string(), json!("scene_mask"));
        let node = StudioGraphNode {
            id: "n1".to_string(),
            kind: "subjectMask".to_string(),
            params,
        };
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "image".to_string(),
            json!(image_path.to_string_lossy().to_string()),
        );

        let out = run(&node, &inputs);
        let report = out.get("matte_report").unwrap();
        assert_eq!(
            report.get("provider").and_then(Value::as_str),
            Some("rust-native")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn end_to_end_writes_triplet_and_report() {
        // A real round-trip through the executor against a temp image + output
        // dir, asserting the triplet is written and the report shape is intact.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_subject_mask_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::new(6, 6);
        for p in image.pixels_mut() {
            *p = Rgba([100, 100, 100, 255]);
        }
        image.save(&image_path).unwrap();

        let mut params = BTreeMap::new();
        params.insert(
            "output_dir".to_string(),
            json!(root.to_string_lossy().to_string()),
        );
        params.insert("output_name".to_string(), json!("scene_mask"));
        let node = StudioGraphNode {
            id: "n1".to_string(),
            kind: "subjectMask".to_string(),
            params,
        };

        let mut inputs = BTreeMap::new();
        inputs.insert(
            "image".to_string(),
            json!(image_path.to_string_lossy().to_string()),
        );
        inputs.insert(
            "edit_paths".to_string(),
            json!({
                "ops": [{ "type": "wand", "x": 0, "y": 0, "tolerance": 30 }]
            }),
        );

        let out = run(&node, &inputs);
        assert!(root.join("scene_mask.png").is_file());
        assert!(root.join("scene_mask_alpha.png").is_file());
        assert!(root.join("scene_mask_cutout.png").is_file());

        let report = out.get("matte_report").unwrap();
        assert_eq!(
            report.get("provider").and_then(Value::as_str),
            Some("rust-native")
        );
        assert_eq!(
            report
                .get("image_size")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        let triplet = report.get("triplet").unwrap();
        assert_eq!(triplet.get("mask").and_then(Value::as_bool), Some(true));
        // The whole image is one flat colour, so the wand selects everything.
        assert!(report.get("mask_coverage").and_then(Value::as_f64).unwrap() > 0.9);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn compute_only_outputs_skip_the_png_write_but_stay_available() {
        // The same flat scene, but with the mask / alpha / cutout ports marked
        // skippable (as when they feed only compute cards). No PNG is written,
        // yet every output resolves from the in-process buffer and the report
        // reports each as available rather than a bare `is_file` false.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hgripe_subject_skip_{}_{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(6, 6, Rgba([100, 100, 100, 255]))
            .save(&image_path)
            .unwrap();

        let mut params = BTreeMap::new();
        params.insert(
            "output_dir".to_string(),
            json!(root.to_string_lossy().to_string()),
        );
        params.insert("output_name".to_string(), json!("scene_mask"));
        let node = StudioGraphNode {
            id: "n1".to_string(),
            kind: "subjectMask".to_string(),
            params,
        };
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "image".to_string(),
            json!(image_path.to_string_lossy().to_string()),
        );

        let skip: HashSet<String> = ["mask", "alpha_image", "cutout_image"]
            .into_iter()
            .map(String::from)
            .collect();
        let out = execute_studio_subject_mask(&node, &inputs, &skip).unwrap();

        // No PNG on disk for the three skipped outputs, yet each emitted path
        // resolves from the buffer and the report calls it available.
        for (port, file) in [
            ("mask", "scene_mask.png"),
            ("alpha_image", "scene_mask_alpha.png"),
            ("cutout_image", "scene_mask_cutout.png"),
        ] {
            assert!(
                !root.join(file).exists(),
                "{port} PNG must not be written when the port is skippable"
            );
            let emitted = out.get(port).and_then(Value::as_str).unwrap();
            assert!(
                image_buffer::is_available(Path::new(emitted)),
                "{port} must resolve from the buffer after a write-skip"
            );
        }
        let triplet = out.get("matte_report").unwrap().get("triplet").unwrap();
        for port in ["mask", "alpha_image", "cutout_image"] {
            assert_eq!(
                triplet.get(port).and_then(Value::as_bool),
                Some(true),
                "{port} must report available"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn matting_emits_trimap_output_for_refine_handoff() {
        // With matting on, the node must persist the driving trimap and surface
        // its path on the `trimap` output so the Refine node can protect the
        // unknown band. Without matting the port is an empty string.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_subject_trimap_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let image_path = root.join("scene.png");
        let mut image = RgbaImage::from_pixel(16, 16, Rgba([120, 120, 120, 255]));
        for y in 5..11 {
            for x in 5..11 {
                image.put_pixel(x, y, Rgba([220, 20, 20, 255]));
            }
        }
        image.save(&image_path).unwrap();

        let make = |matting: bool| {
            let mut params = BTreeMap::new();
            params.insert("mode".to_string(), json!("auto_subject"));
            params.insert("alpha_matting".to_string(), json!(matting));
            params.insert(
                "output_dir".to_string(),
                json!(root.to_string_lossy().to_string()),
            );
            params.insert("output_name".to_string(), json!("scene_mask"));
            let node = StudioGraphNode {
                id: "n1".to_string(),
                kind: "subjectMask".to_string(),
                params,
            };
            let mut inputs = BTreeMap::new();
            inputs.insert(
                "image".to_string(),
                json!(image_path.to_string_lossy().to_string()),
            );
            run(&node, &inputs)
        };

        let off = make(false);
        assert_eq!(off.get("trimap").and_then(Value::as_str), Some(""));

        let on = make(true);
        let trimap = on.get("trimap").and_then(Value::as_str).unwrap();
        assert!(!trimap.is_empty(), "matting must emit a trimap path");
        assert!(Path::new(trimap).is_file(), "trimap PNG must be written");

        let _ = std::fs::remove_dir_all(&root);
    }
}
