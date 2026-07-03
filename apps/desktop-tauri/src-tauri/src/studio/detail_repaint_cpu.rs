//! In-process pixel halves of the Detail Repaint node: native-Rust replicas
//! of `detail_repaint_cli.py`'s `prepare` and `composite` subcommands, run
//! inline in the `detailRepaint` executor instead of spawning the Python
//! bridge. The generative fix itself stays API-first: the orchestrator sends
//! each prepared crop + mask + prompt through the broker's `image.edit`
//! operation between the two halves, and the opt-in *local* inpaint backend
//! (`repaint` subcommand, torch/diffusers) remains on the Python path.
//!
//! `try_prepare` mirrors the CLI's `prepare`: select repaintable issues from
//! the QualityReport (action allow-list, min confidence, highest-confidence
//! first, region cap), crop a padded window per issue and write a same-size
//! inpaint mask whose un-padded core is the edit area (transparent by
//! default, opaque with `invert_mask`), emitting the same JSON manifest.
//!
//! `try_composite` mirrors the CLI's `composite`: paste each repainted crop
//! back within a feathered version of its issue core (Gaussian falloff seam
//! fusion) or a gradient-domain Poisson clone (`blend == "poisson"`, exact
//! DST-I solve, falling back to feather on a too-small core), **alpha
//! isolated** — only RGB is blended, the candidate's own alpha is preserved
//! so a cut-out matte gains no seam halo. Provider crops that come back a
//! different size are resized (area-average when shrinking, Lanczos when
//! growing, matching Pillow `BOX`/`LANCZOS`).
//!
//! Loading goes through [`super::studio_image`], the shared hardened loader
//! (decompression-bomb guard, EXIF normalisation, CMYK / high-bit /
//! wide-gamut colour management), mirroring the CLI's `_load_rgba` +
//! `wide_gamut.managed_to_srgb`. A candidate the loader cannot decode defers
//! to the Python bridge: both entry points return `Ok(None)` and the caller
//! falls back.

use std::f64::consts::PI;
use std::path::{Path, PathBuf};

use image::imageops::{self, FilterType};
use image::{GrayImage, Luma, RgbaImage};
use serde_json::{json, Value};

use super::studio_image::{self, DEFAULT_MAX_DECODE_PIXELS};
use crate::contracts::{RepaintRegionResult, RepaintReport};
use crate::psd::{
    reject_unsafe_output_name, CompositeRepaintResult, PrepareRepaintResult, PreparedRepaintRegion,
};

/// Quality-report `suggested_action` values a localized repaint can act on by
/// default. `image_enhance` / `color_match` are whole-image fixes handled by
/// other nodes.
const DEFAULT_REPAINT_ACTIONS: [&str; 1] = ["detail_redraw"];

/// Resolved parameters for one `prepare` run, mirroring the CLI arguments.
pub(super) struct CpuPrepareParams {
    pub(super) image_path: String,
    pub(super) quality_report: Option<String>,
    pub(super) repaint_actions: Option<String>,
    pub(super) min_confidence: f64,
    pub(super) padding: i64,
    pub(super) max_regions: i64,
    pub(super) invert_mask: bool,
    pub(super) output_dir: String,
    pub(super) output_name: Option<String>,
}

/// Resolved parameters for one `composite` run, mirroring the CLI arguments.
pub(super) struct CpuCompositeParams {
    pub(super) image_path: String,
    pub(super) manifest: String,
    pub(super) repainted: String,
    pub(super) feather_px: f64,
    pub(super) blend: Option<String>,
    pub(super) output_dir: String,
    pub(super) output_name: Option<String>,
}

/// A candidate image decoded to interleaved RGBA f32 planes plus its loader
/// provenance, shared by both pixel halves.
struct Candidate {
    rgba: Vec<f32>,
    width: usize,
    height: usize,
    source_mode: String,
    exif_transposed: bool,
}

/// Load the candidate through the shared hardened loader; `Ok(None)` defers
/// to the Python bridge (missing file or an undecodable source), which
/// surfaces the canonical error message.
fn load_candidate(image_path: &str) -> Result<Option<Candidate>, String> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_file() {
        return Ok(None);
    }
    let loaded = match studio_image::load_rgba(Path::new(trimmed), DEFAULT_MAX_DECODE_PIXELS) {
        Ok(loaded) => loaded,
        Err(_) => return Ok(None),
    };
    let (width, height) = loaded.image.dimensions();
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return Ok(None);
    }
    let rgba: Vec<f32> = loaded
        .image
        .as_raw()
        .iter()
        .map(|&v| f32::from(v))
        .collect();
    Ok(Some(Candidate {
        rgba,
        width: w,
        height: h,
        source_mode: loaded.meta.source_mode,
        exif_transposed: loaded.meta.exif_transposed,
    }))
}

/// Run the `prepare` half in-process. Returns `Ok(Some(manifest))` on the
/// fast path, or `Ok(None)` to defer to the Python bridge.
pub(super) fn try_prepare(p: &CpuPrepareParams) -> Result<Option<PrepareRepaintResult>, String> {
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;
    let Some(candidate) = load_candidate(&p.image_path)? else {
        return Ok(None);
    };
    let (width, height) = (candidate.width, candidate.height);

    let report = parse_json_arg(p.quality_report.as_deref(), "quality_report")?;
    let issues: Vec<Value> = report
        .as_ref()
        .and_then(|r| r.get("issues"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let actions: Vec<String> = {
        let configured: Vec<String> = p
            .repaint_actions
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if configured.is_empty() {
            DEFAULT_REPAINT_ACTIONS
                .iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            configured
        }
    };
    let min_confidence = p.min_confidence.clamp(0.0, 1.0);
    let padding = p.padding.max(0);
    let max_regions = p.max_regions.max(1) as usize;

    // Split issues into (selected, skipped-with-reason), mirroring
    // `_select_issues`; then highest-confidence first and cap the count.
    let mut selected: Vec<(usize, Value)> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for (index, issue) in issues.iter().enumerate() {
        if !issue.is_object() {
            continue;
        }
        let issue_type = issue.get("type").cloned().unwrap_or(Value::Null);
        let action = issue
            .get("suggested_action")
            .and_then(Value::as_str)
            .unwrap_or("");
        let confidence = issue
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let bbox_ok = issue
            .get("bbox")
            .and_then(Value::as_array)
            .is_some_and(|b| b.len() == 4);
        if !bbox_ok {
            skipped.push(json!({"index": index, "type": issue_type, "reason": "no_bbox"}));
            continue;
        }
        if !actions.iter().any(|a| a == action) {
            skipped.push(
                json!({"index": index, "type": issue_type, "reason": "action_not_repaintable"}),
            );
            continue;
        }
        if confidence < min_confidence {
            skipped.push(
                json!({"index": index, "type": issue_type, "reason": "below_min_confidence"}),
            );
            continue;
        }
        selected.push((index, issue.clone()));
    }
    selected.sort_by(|a, b| {
        let ca = a.1.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
        let cb = b.1.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
        cb.partial_cmp(&ca).expect("finite confidence")
    });
    for (index, issue) in selected.split_off(max_regions.min(selected.len())) {
        let issue_type = issue.get("type").cloned().unwrap_or(Value::Null);
        skipped.push(json!({"index": index, "type": issue_type, "reason": "over_max_regions"}));
    }

    let directory = output_directory(&p.output_dir)?;
    let stem = p
        .output_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_repaint", safe_stem(&p.image_path)));

    let mut regions: Vec<PreparedRepaintRegion> = Vec::new();
    for (index, issue) in selected {
        let raw_bbox: Vec<i64> = issue
            .get("bbox")
            .and_then(Value::as_array)
            .expect("bbox validated above")
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as i64)
            .collect();
        let bbox = clamp_box(
            [raw_bbox[0], raw_bbox[1], raw_bbox[2], raw_bbox[3]],
            width,
            height,
        );
        let crop_box = pad_box(bbox, padding, width, height);
        let [cx1, cy1, cx2, cy2] = crop_box;
        let inner = [bbox[0] - cx1, bbox[1] - cy1, bbox[2] - cx1, bbox[3] - cy1];
        let (crop_w, crop_h) = ((cx2 - cx1) as usize, (cy2 - cy1) as usize);

        let mut crop = RgbaImage::new(crop_w as u32, crop_h as u32);
        for (x, y, px) in crop.enumerate_pixels_mut() {
            let src = ((cy1 as usize + y as usize) * width + cx1 as usize + x as usize) * 4;
            px.0 = [
                candidate.rgba[src] as u8,
                candidate.rgba[src + 1] as u8,
                candidate.rgba[src + 2] as u8,
                candidate.rgba[src + 3] as u8,
            ];
        }
        let crop_path = directory.join(format!("{stem}_region{index}.png"));
        crop.save(&crop_path)
            .map_err(|err| format!("failed to write {}: {err}", crop_path.display()))?;

        // Inpaint mask, crop-sized. OpenAI-style `image.edit` reads the
        // *transparent* (alpha 0) pixels as the area to regenerate, so the
        // issue core is punched transparent and the padding kept opaque;
        // `invert_mask` flips this for opaque/white-edit providers.
        let (edit_alpha, keep_alpha) = if p.invert_mask {
            (255u8, 0u8)
        } else {
            (0u8, 255u8)
        };
        let mut mask = RgbaImage::from_pixel(
            crop_w as u32,
            crop_h as u32,
            image::Rgba([255, 255, 255, keep_alpha]),
        );
        for y in inner[1].max(0)..inner[3].min(crop_h as i64) {
            for x in inner[0].max(0)..inner[2].min(crop_w as i64) {
                mask.put_pixel(x as u32, y as u32, image::Rgba([255, 255, 255, edit_alpha]));
            }
        }
        let mask_path = directory.join(format!("{stem}_region{index}_mask.png"));
        mask.save(&mask_path)
            .map_err(|err| format!("failed to write {}: {err}", mask_path.display()))?;

        let confidence = issue
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        regions.push(PreparedRepaintRegion {
            index: index as u32,
            issue_type: issue
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string),
            confidence: (confidence * 10_000.0).round() / 10_000.0,
            suggested_action: issue
                .get("suggested_action")
                .and_then(Value::as_str)
                .map(str::to_string),
            bbox,
            crop_box,
            inner_box: inner,
            size: [crop_w as i64, crop_h as i64],
            crop_path: crop_path.to_string_lossy().to_string(),
            mask_path: mask_path.to_string_lossy().to_string(),
        });
    }

    let selected_count = regions.len() as u32;
    Ok(Some(PrepareRepaintResult {
        regions,
        skipped,
        image_size: [width as i64, height as i64],
        selected_count,
        mask_edit_is_transparent: !p.invert_mask,
        source_mode: candidate.source_mode,
        exif_transposed: candidate.exif_transposed,
        max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS as i64,
    }))
}

/// Run the `composite` half in-process. Returns `Ok(Some(result))` on the
/// fast path, or `Ok(None)` to defer to the Python bridge.
pub(super) fn try_composite(
    p: &CpuCompositeParams,
) -> Result<Option<CompositeRepaintResult>, String> {
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;
    let blend = {
        let b = p
            .blend
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("feather")
            .to_ascii_lowercase();
        if b != "feather" && b != "poisson" {
            return Err(format!(
                "unknown blend mode '{b}' (expected feather | poisson)"
            ));
        }
        b
    };

    let manifest = parse_json_arg(Some(&p.manifest), "manifest")?;
    let regions: Vec<Value> = manifest
        .as_ref()
        .and_then(|m| m.get("regions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Map region index -> repainted crop path (entries with a blank path mean
    // the provider returned nothing for that region: it stays unrepainted).
    let repainted_raw = parse_json_arg(Some(&p.repainted), "repainted")?;
    let mut repainted_paths: std::collections::BTreeMap<i64, String> =
        std::collections::BTreeMap::new();
    if let Some(Value::Array(entries)) = repainted_raw {
        for entry in entries {
            let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
            if !path.is_empty() {
                let index = entry.get("index").and_then(Value::as_i64).unwrap_or(0);
                repainted_paths.insert(index, path.to_string());
            }
        }
    }

    let Some(mut candidate) = load_candidate(&p.image_path)? else {
        return Ok(None);
    };
    let (width, height) = (candidate.width, candidate.height);

    let mut region_results: Vec<RepaintRegionResult> = Vec::new();
    let mut repainted_count = 0u32;
    for region in &regions {
        if !region.is_object() {
            continue;
        }
        let index = region.get("index").and_then(Value::as_i64).unwrap_or(0);
        let mut result = RepaintRegionResult {
            index: index.max(0) as u32,
            issue_type: region
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string),
            bbox: box_from_value(region.get("bbox")),
            status: "skipped".to_string(),
            feather_px: None,
            blend: None,
        };
        let patch_path = repainted_paths.get(&index).cloned().unwrap_or_default();
        let crop_box = box_from_value(region.get("crop_box"));
        let inner = box_from_value(region.get("inner_box"));
        if patch_path.is_empty() || !Path::new(&patch_path).is_file() {
            result.status = "no_repaint".to_string();
            region_results.push(result);
            continue;
        }
        let (Some(crop_box), Some(inner)) = (crop_box, inner) else {
            result.status = "bad_geometry".to_string();
            region_results.push(result);
            continue;
        };

        let [cx1, cy1, cx2, cy2] = crop_box;
        let (crop_w, crop_h) = ((cx2 - cx1) as usize, (cy2 - cy1) as usize);
        if crop_w == 0
            || crop_h == 0
            || cx1 < 0
            || cy1 < 0
            || cx2 as usize > width
            || cy2 as usize > height
        {
            result.status = "bad_geometry".to_string();
            region_results.push(result);
            continue;
        }
        let patch = image::open(&patch_path)
            .map_err(|err| format!("failed to read {patch_path}: {err}"))?
            .to_rgba8();
        let patch = resize_patch(patch, crop_w as u32, crop_h as u32);
        let patch_rgb: Vec<f32> = patch
            .pixels()
            .flat_map(|px| [f32::from(px.0[0]), f32::from(px.0[1]), f32::from(px.0[2])])
            .collect();

        // Alpha isolation (Method A): blend only RGB; keep the candidate's own
        // alpha so a cut-out subject's matte is never softened or haloed.
        let mut blended_poisson = false;
        if blend == "poisson" {
            blended_poisson = poisson_blend_rgb(
                &mut candidate.rgba,
                width,
                (cx1 as usize, cy1 as usize, crop_w, crop_h),
                &patch_rgb,
                inner,
            );
        }
        if blended_poisson {
            result.blend = Some("poisson".to_string());
        } else {
            let feather = if p.feather_px > 0.0 {
                p.feather_px
            } else {
                auto_feather(inner)
            };
            let alpha = feather_mask(crop_w, crop_h, inner, feather as f32);
            for y in 0..crop_h {
                for x in 0..crop_w {
                    let a = alpha[y * crop_w + x];
                    let dst = ((cy1 as usize + y) * width + cx1 as usize + x) * 4;
                    let src = (y * crop_w + x) * 3;
                    for c in 0..3 {
                        candidate.rgba[dst + c] =
                            candidate.rgba[dst + c] * (1.0 - a) + patch_rgb[src + c] * a;
                    }
                }
            }
            result.blend = Some("feather".to_string());
            result.feather_px = Some((feather * 100.0).round() / 100.0);
        }
        repainted_count += 1;
        result.status = "repainted".to_string();
        region_results.push(result);
    }

    let handled = region_results
        .iter()
        .filter(|r| r.status != "skipped")
        .count() as u32;
    let status = if repainted_count == 0 {
        "unchanged"
    } else if repainted_count == handled {
        "repainted"
    } else {
        "partial"
    };

    let directory = output_directory(&p.output_dir)?;
    let stem = p
        .output_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_repainted", safe_stem(&p.image_path)));
    let out_path = directory.join(format!("{stem}.png"));
    let mut out = RgbaImage::new(width as u32, height as u32);
    for (i, px) in out.pixels_mut().enumerate() {
        for c in 0..4 {
            px.0[c] = candidate.rgba[i * 4 + c].round().clamp(0.0, 255.0) as u8;
        }
    }
    out.save(&out_path)
        .map_err(|err| format!("failed to write {}: {err}", out_path.display()))?;

    Ok(Some(CompositeRepaintResult {
        fixed_image: out_path.to_string_lossy().to_string(),
        repaint_report: RepaintReport {
            status: status.to_string(),
            regions: region_results,
            repainted_count,
            requested_count: regions.len() as u32,
            image_size: [width as i64, height as i64],
            blend,
            source_mode: candidate.source_mode,
            exif_transposed: candidate.exif_transposed,
            max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS as i64,
        },
    }))
}

/// A filesystem-safe base name derived from the image file stem (mirrors the
/// CLI's `_safe_stem`).
fn safe_stem(image_path: &str) -> String {
    let stem = Path::new(image_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "image".to_string()
    } else {
        cleaned
    }
}

/// Parse an inline JSON argument, raising a clean error on malformed input
/// (mirrors `_load_json_arg`).
fn parse_json_arg(raw: Option<&str>, label: &str) -> Result<Option<Value>, String> {
    let text = raw.map(str::trim).unwrap_or("");
    if text.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(text)
        .map(Some)
        .map_err(|err| format!("invalid {label} JSON: {err}"))
}

fn output_directory(configured: &str) -> Result<PathBuf, String> {
    let directory = PathBuf::from(if configured.trim().is_empty() {
        "."
    } else {
        configured.trim()
    });
    std::fs::create_dir_all(&directory)
        .map_err(|err| format!("failed to create {}: {err}", directory.display()))?;
    Ok(directory)
}

/// Clamp `[x1, y1, x2, y2]` to the image and guarantee a non-empty box
/// (mirrors `_clamp_box`).
fn clamp_box(bbox: [i64; 4], width: usize, height: usize) -> [i64; 4] {
    let (w, h) = (width as i64, height as i64);
    let x1 = bbox[0].clamp(0, w - 1);
    let y1 = bbox[1].clamp(0, h - 1);
    let x2 = bbox[2].min(w).max(x1 + 1);
    let y2 = bbox[3].min(h).max(y1 + 1);
    [x1, y1, x2, y2]
}

/// Grow a box outward by `padding` px, clamped to the image (mirrors
/// `_pad_box`).
fn pad_box(bbox: [i64; 4], padding: i64, width: usize, height: usize) -> [i64; 4] {
    clamp_box(
        [
            bbox[0] - padding,
            bbox[1] - padding,
            bbox[2] + padding,
            bbox[3] + padding,
        ],
        width,
        height,
    )
}

fn box_from_value(value: Option<&Value>) -> Option<[i64; 4]> {
    let arr = value?.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let mut out = [0i64; 4];
    for (o, v) in out.iter_mut().zip(arr) {
        *o = v.as_f64()? as i64;
    }
    Some(out)
}

/// A feather radius scaled to the issue core (~6% of its short side, clamped
/// 2..24; mirrors `_auto_feather`).
fn auto_feather(inner: [i64; 4]) -> f64 {
    let short = (inner[2] - inner[0]).min(inner[3] - inner[1]).max(1);
    ((short as f64 * 0.06).round()).clamp(2.0, 24.0)
}

/// Build a 0..1 crop-sized alpha that is 1 inside `inner` and falls off with
/// a Gaussian at the rectangle edge — the "secondary edge fusion" hiding the
/// patch seam (mirrors `_feather_mask`, Pillow `GaussianBlur` semantics via
/// the same 8-bit round-trip the edge_refine fast path uses).
fn feather_mask(w: usize, h: usize, inner: [i64; 4], feather_px: f32) -> Vec<f32> {
    let mut hard = GrayImage::new(w as u32, h as u32);
    for y in inner[1].max(0)..inner[3].min(h as i64) {
        for x in inner[0].max(0)..inner[2].min(w as i64) {
            hard.put_pixel(x as u32, y as u32, Luma([255u8]));
        }
    }
    let plane = if feather_px > 0.0 {
        imageops::blur(&hard, feather_px)
    } else {
        hard
    };
    plane
        .pixels()
        .map(|Luma([v])| f32::from(*v) / 255.0)
        .collect()
}

/// Resize a provider crop to the expected geometry: area-average when
/// shrinking (Pillow `BOX`, avoiding Lanczos ringing on downsample), Lanczos
/// when growing.
fn resize_patch(patch: RgbaImage, crop_w: u32, crop_h: u32) -> RgbaImage {
    let (pw, ph) = patch.dimensions();
    if (pw, ph) == (crop_w, crop_h) {
        return patch;
    }
    if crop_w < pw || crop_h < ph {
        return box_resize(&patch, crop_w, crop_h);
    }
    imageops::resize(&patch, crop_w, crop_h, FilterType::Lanczos3)
}

/// Area-average (box filter) resample, Pillow `Image.BOX` semantics: each
/// destination pixel averages the exact source rectangle it covers.
fn box_resize(src: &RgbaImage, dst_w: u32, dst_h: u32) -> RgbaImage {
    let (sw, sh) = src.dimensions();
    let scale_x = f64::from(sw) / f64::from(dst_w);
    let scale_y = f64::from(sh) / f64::from(dst_h);
    let mut out = RgbaImage::new(dst_w, dst_h);
    for (dx, dy, px) in out.enumerate_pixels_mut() {
        let x0 = f64::from(dx) * scale_x;
        let x1 = (f64::from(dx) + 1.0) * scale_x;
        let y0 = f64::from(dy) * scale_y;
        let y1 = (f64::from(dy) + 1.0) * scale_y;
        let mut acc = [0f64; 4];
        let mut area = 0f64;
        for sy in (y0.floor() as u32)..(y1.ceil() as u32).min(sh) {
            let cover_y = (f64::from(sy) + 1.0).min(y1) - f64::from(sy).max(y0);
            if cover_y <= 0.0 {
                continue;
            }
            for sx in (x0.floor() as u32)..(x1.ceil() as u32).min(sw) {
                let cover_x = (f64::from(sx) + 1.0).min(x1) - f64::from(sx).max(x0);
                if cover_x <= 0.0 {
                    continue;
                }
                let weight = cover_x * cover_y;
                let s = src.get_pixel(sx, sy);
                for c in 0..4 {
                    acc[c] += f64::from(s.0[c]) * weight;
                }
                area += weight;
            }
        }
        if area > 0.0 {
            for c in 0..4 {
                px.0[c] = (acc[c] / area).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// Type-I discrete sine transform of an `h x w` matrix along the given axis
/// (`0` = down columns, `1` = across rows): `X[k] = Σ x[j]·sin(π(j+1)(k+1)/(n+1))`.
/// DST-I diagonalises the Dirichlet discrete Laplacian, which is what lets
/// the Poisson blend solve the seam equation exactly (mirrors `_dst1`).
fn dst1(data: &[f64], h: usize, w: usize, axis: usize) -> Vec<f64> {
    let n = if axis == 0 { h } else { w };
    let mut table = vec![0f64; n * n];
    for j in 0..n {
        for k in 0..n {
            table[j * n + k] = (PI * ((j + 1) as f64) * ((k + 1) as f64) / ((n + 1) as f64)).sin();
        }
    }
    let mut out = vec![0f64; h * w];
    if axis == 0 {
        for x in 0..w {
            for k in 0..h {
                let mut acc = 0f64;
                for j in 0..h {
                    acc += data[j * w + x] * table[j * h + k];
                }
                out[k * w + x] = acc;
            }
        }
    } else {
        for y in 0..h {
            for k in 0..w {
                let mut acc = 0f64;
                for j in 0..w {
                    acc += data[y * w + j] * table[j * w + k];
                }
                out[y * w + k] = acc;
            }
        }
    }
    out
}

/// Solve `(4u - sum of 4-neighbours) = rhs` with zero Dirichlet boundary by a
/// 2-D DST-I eigen-decomposition — exact, no iterative solver (mirrors
/// `_poisson_solve`).
fn poisson_solve(rhs: &[f64], h: usize, w: usize) -> Vec<f64> {
    let mut transformed = dst1(&dst1(rhs, h, w, 0), h, w, 1);
    for i in 0..h {
        let lam_i = 2.0 - 2.0 * (PI * ((i + 1) as f64) / ((h + 1) as f64)).cos();
        for j in 0..w {
            let lam_j = 2.0 - 2.0 * (PI * ((j + 1) as f64) / ((w + 1) as f64)).cos();
            transformed[i * w + j] /= lam_i + lam_j;
        }
    }
    let back = dst1(&dst1(&transformed, h, w, 0), h, w, 1);
    let norm = 4.0 / (((h + 1) * (w + 1)) as f64);
    back.into_iter().map(|v| v * norm).collect()
}

/// Gradient-domain (Poisson) clone of the patch RGB into the candidate's crop
/// window: inside the issue core the result keeps the repainted patch's
/// *gradients* while its boundary is pinned to the surrounding candidate
/// pixels, so seam offsets diffuse away. Only RGB is written — the alpha
/// isolation contract is untouched. Returns `false` (caller falls back to the
/// feathered blend) when the core is too small to solve (mirrors
/// `_poisson_blend_rgb`).
fn poisson_blend_rgb(
    base: &mut [f32],
    image_width: usize,
    window: (usize, usize, usize, usize),
    patch_rgb: &[f32],
    inner: [i64; 4],
) -> bool {
    let (wx, wy, crop_w, crop_h) = window;
    let x1 = inner[0].clamp(0, crop_w as i64) as usize;
    let y1 = inner[1].clamp(0, crop_h as i64) as usize;
    let x2 = inner[2].clamp(x1 as i64, crop_w as i64) as usize;
    let y2 = inner[3].clamp(y1 as i64, crop_h as i64) as usize;
    let (core_h, core_w) = (y2 - y1, x2 - x1);
    if core_h < 3 || core_w < 3 {
        return false;
    }

    // Snapshot the crop window's RGB so the boundary reads see the original
    // candidate while the core is written below.
    let mut window_rgb = vec![0f32; crop_w * crop_h * 3];
    for cy in 0..crop_h {
        for cx in 0..crop_w {
            let src = ((wy + cy) * image_width + wx + cx) * 4;
            let dst = (cy * crop_w + cx) * 3;
            window_rgb[dst..dst + 3].copy_from_slice(&base[src..src + 3]);
        }
    }
    // Replicated-edge sampling so the boundary ring exists even when the core
    // touches the crop edge (the CLI's one-pixel `np.pad(..., mode="edge")`).
    let base_at = |x: i64, y: i64, c: usize| -> f64 {
        let cx = x.clamp(0, crop_w as i64 - 1) as usize;
        let cy = y.clamp(0, crop_h as i64 - 1) as usize;
        f64::from(window_rgb[(cy * crop_w + cx) * 3 + c])
    };
    let patch_at = |x: i64, y: i64, c: usize| -> f64 {
        let cx = x.clamp(0, crop_w as i64 - 1) as usize;
        let cy = y.clamp(0, crop_h as i64 - 1) as usize;
        f64::from(patch_rgb[(cy * crop_w + cx) * 3 + c])
    };

    for channel in 0..3 {
        // Discrete Laplacian of the patch over the core (the guidance field),
        // with the known Dirichlet boundary (candidate pixels) folded in.
        let mut rhs = vec![0f64; core_h * core_w];
        for iy in 0..core_h {
            for ix in 0..core_w {
                let gx = (x1 + ix) as i64;
                let gy = (y1 + iy) as i64;
                let mut v = 4.0 * patch_at(gx, gy, channel)
                    - patch_at(gx, gy - 1, channel)
                    - patch_at(gx, gy + 1, channel)
                    - patch_at(gx - 1, gy, channel)
                    - patch_at(gx + 1, gy, channel);
                if iy == 0 {
                    v += base_at(gx, gy - 1, channel);
                }
                if iy == core_h - 1 {
                    v += base_at(gx, gy + 1, channel);
                }
                if ix == 0 {
                    v += base_at(gx - 1, gy, channel);
                }
                if ix == core_w - 1 {
                    v += base_at(gx + 1, gy, channel);
                }
                rhs[iy * core_w + ix] = v;
            }
        }
        let solved = poisson_solve(&rhs, core_h, core_w);
        for iy in 0..core_h {
            for ix in 0..core_w {
                let dst = ((wy + y1 + iy) * image_width + wx + x1 + ix) * 4 + channel;
                base[dst] = solved[iy * core_w + ix].clamp(0.0, 255.0) as f32;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hgripe_detail_repaint_cpu_{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_candidate(dir: &Path, name: &str, w: u32, h: u32) -> String {
        let mut img = RgbaImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 200 } else { 60 };
            px.0 = [v, v, v, 255];
        }
        let path = dir.join(name);
        img.save(&path).unwrap();
        path.to_string_lossy().to_string()
    }

    fn prepare_params(image: &str, dir: &Path) -> CpuPrepareParams {
        CpuPrepareParams {
            image_path: image.to_string(),
            quality_report: None,
            repaint_actions: None,
            min_confidence: 0.0,
            padding: 24,
            max_regions: 8,
            invert_mask: false,
            output_dir: dir.to_string_lossy().to_string(),
            output_name: None,
        }
    }

    /// prepare crops the padded window, writes a transparent-core mask, and
    /// records the exact geometry the composite step needs.
    #[test]
    fn prepare_writes_crop_and_mask_with_geometry() {
        let dir = temp_dir("prep");
        let image = write_candidate(&dir, "cand.png", 128, 96);
        let mut p = prepare_params(&image, &dir);
        p.quality_report = Some(
            json!({"issues": [
                {"type": "face_blur", "confidence": 0.8, "bbox": [40, 30, 72, 60],
                 "suggested_action": "detail_redraw"},
                {"type": "low_resolution", "confidence": 0.9, "bbox": [0, 0, 128, 96],
                 "suggested_action": "image_enhance"}
            ]})
            .to_string(),
        );
        let result = try_prepare(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.selected_count, 1);
        assert_eq!(result.image_size, [128, 96]);
        assert!(result.mask_edit_is_transparent);
        // The whole-image enhance issue is skipped as not repaintable.
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0]["reason"], "action_not_repaintable");

        let region = &result.regions[0];
        assert_eq!(region.bbox, [40, 30, 72, 60]);
        assert_eq!(region.crop_box, [16, 6, 96, 84]); // padded by 24, clamped
        assert_eq!(region.inner_box, [24, 24, 56, 54]);
        assert_eq!(region.size, [80, 78]);
        let mask = image::open(&region.mask_path).unwrap().to_rgba8();
        assert_eq!(mask.dimensions(), (80, 78));
        assert_eq!(mask.get_pixel(30, 30).0[3], 0); // core: transparent (edit)
        assert_eq!(mask.get_pixel(2, 2).0[3], 255); // padding: opaque (keep)
        let crop = image::open(&region.crop_path).unwrap().to_rgba8();
        assert_eq!(crop.dimensions(), (80, 78));
    }

    /// Selection honours min_confidence and the region cap (highest
    /// confidence first), recording skip reasons.
    #[test]
    fn prepare_selection_filters_and_caps() {
        let dir = temp_dir("select");
        let image = write_candidate(&dir, "cand.png", 64, 64);
        let mut p = prepare_params(&image, &dir);
        p.min_confidence = 0.6;
        p.max_regions = 1;
        p.quality_report = Some(
            json!({"issues": [
                {"type": "a", "confidence": 0.7, "bbox": [0, 0, 8, 8], "suggested_action": "detail_redraw"},
                {"type": "b", "confidence": 0.9, "bbox": [8, 8, 16, 16], "suggested_action": "detail_redraw"},
                {"type": "c", "confidence": 0.5, "bbox": [16, 16, 24, 24], "suggested_action": "detail_redraw"},
                {"type": "d", "confidence": 0.9, "suggested_action": "detail_redraw"}
            ]})
            .to_string(),
        );
        let result = try_prepare(&p).unwrap().expect("cpu fast path");
        // Highest confidence (b) wins the single slot; a is over the cap,
        // c below min confidence, d has no bbox.
        assert_eq!(result.selected_count, 1);
        assert_eq!(result.regions[0].issue_type.as_deref(), Some("b"));
        let reasons: Vec<&str> = result
            .skipped
            .iter()
            .map(|s| s["reason"].as_str().unwrap())
            .collect();
        assert!(reasons.contains(&"over_max_regions"));
        assert!(reasons.contains(&"below_min_confidence"));
        assert!(reasons.contains(&"no_bbox"));
    }

    /// composite pastes a repainted crop's RGB back inside the feathered core,
    /// leaves the padding untouched, and preserves the candidate's alpha.
    #[test]
    fn composite_feather_blends_core_and_preserves_alpha() {
        let dir = temp_dir("comp");
        // Candidate: flat grey, semi-transparent alpha to verify isolation.
        let path = dir.join("cand.png");
        RgbaImage::from_pixel(64, 64, Rgba([100, 100, 100, 180]))
            .save(&path)
            .unwrap();
        // Repainted patch: solid red at crop size.
        let patch_path = dir.join("patch.png");
        RgbaImage::from_pixel(40, 40, Rgba([250, 10, 10, 255]))
            .save(&patch_path)
            .unwrap();

        let manifest = json!({"regions": [{
            "index": 0, "type": "face_blur", "bbox": [20, 20, 36, 36],
            "crop_box": [12, 12, 52, 52], "inner_box": [8, 8, 24, 24], "size": [40, 40],
            "crop_path": "", "mask_path": ""
        }]});
        let repainted = json!([{ "index": 0, "path": patch_path.to_string_lossy() }]);
        let p = CpuCompositeParams {
            image_path: path.to_string_lossy().to_string(),
            manifest: manifest.to_string(),
            repainted: repainted.to_string(),
            feather_px: 0.0,
            blend: None,
            output_dir: dir.to_string_lossy().to_string(),
            output_name: Some("fixed".to_string()),
        };
        let result = try_composite(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.repaint_report.status, "repainted");
        assert_eq!(result.repaint_report.repainted_count, 1);
        assert_eq!(result.repaint_report.blend, "feather");
        let region = &result.repaint_report.regions[0];
        assert_eq!(region.status, "repainted");
        assert_eq!(region.blend.as_deref(), Some("feather"));
        assert!(region.feather_px.unwrap() >= 2.0);

        let fixed = image::open(&result.fixed_image).unwrap().to_rgba8();
        // Core centre is red now; alpha untouched (Method A isolation).
        let core = fixed.get_pixel(28, 28);
        assert!(core.0[0] > 200 && core.0[1] < 60, "{:?}", core.0);
        assert_eq!(core.0[3], 180);
        // Far corner (outside the crop) is untouched.
        assert_eq!(fixed.get_pixel(2, 2).0, [100, 100, 100, 180]);
    }

    /// A region whose provider returned nothing stays unrepainted and the
    /// aggregate status reflects the partial outcome.
    #[test]
    fn composite_partial_and_no_repaint() {
        let dir = temp_dir("partial");
        let image = write_candidate(&dir, "cand.png", 64, 64);
        let patch_path = dir.join("patch.png");
        RgbaImage::from_pixel(16, 16, Rgba([250, 10, 10, 255]))
            .save(&patch_path)
            .unwrap();
        let manifest = json!({"regions": [
            {"index": 0, "type": "a", "bbox": [0, 0, 8, 8],
             "crop_box": [0, 0, 16, 16], "inner_box": [0, 0, 8, 8], "size": [16, 16]},
            {"index": 1, "type": "b", "bbox": [32, 32, 40, 40],
             "crop_box": [24, 24, 48, 48], "inner_box": [8, 8, 16, 16], "size": [24, 24]}
        ]});
        let repainted = json!([{ "index": 0, "path": patch_path.to_string_lossy() }]);
        let p = CpuCompositeParams {
            image_path: image,
            manifest: manifest.to_string(),
            repainted: repainted.to_string(),
            feather_px: 2.0,
            blend: Some("feather".to_string()),
            output_dir: dir.to_string_lossy().to_string(),
            output_name: None,
        };
        let result = try_composite(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.repaint_report.status, "partial");
        assert_eq!(result.repaint_report.repainted_count, 1);
        assert_eq!(result.repaint_report.requested_count, 2);
        assert_eq!(result.repaint_report.regions[1].status, "no_repaint");
    }

    /// The Poisson blend keeps the patch's gradients but pins the seam to the
    /// candidate: a uniformly offset patch comes back matching the base.
    #[test]
    fn composite_poisson_diffuses_offset() {
        let dir = temp_dir("poisson");
        let path = dir.join("cand.png");
        RgbaImage::from_pixel(32, 32, Rgba([100, 100, 100, 255]))
            .save(&path)
            .unwrap();
        // Patch is the same flat field but offset +80: Poisson should diffuse
        // the offset away (boundary pinned to 100, zero gradients inside).
        let patch_path = dir.join("patch.png");
        RgbaImage::from_pixel(20, 20, Rgba([180, 180, 180, 255]))
            .save(&patch_path)
            .unwrap();
        let manifest = json!({"regions": [{
            "index": 0, "type": "a", "bbox": [10, 10, 22, 22],
            "crop_box": [6, 6, 26, 26], "inner_box": [4, 4, 16, 16], "size": [20, 20]
        }]});
        let repainted = json!([{ "index": 0, "path": patch_path.to_string_lossy() }]);
        let p = CpuCompositeParams {
            image_path: path.to_string_lossy().to_string(),
            manifest: manifest.to_string(),
            repainted: repainted.to_string(),
            feather_px: 0.0,
            blend: Some("poisson".to_string()),
            output_dir: dir.to_string_lossy().to_string(),
            output_name: Some("poisson_fixed".to_string()),
        };
        let result = try_composite(&p).unwrap().expect("cpu fast path");
        assert_eq!(
            result.repaint_report.regions[0].blend.as_deref(),
            Some("poisson")
        );
        let fixed = image::open(&result.fixed_image).unwrap().to_rgba8();
        let centre = fixed.get_pixel(16, 16);
        assert!(
            (i32::from(centre.0[0]) - 100).abs() <= 2,
            "offset should diffuse away, got {:?}",
            centre.0
        );
    }

    /// A too-small core degrades poisson to the feathered blend, recorded
    /// truthfully per region.
    #[test]
    fn composite_poisson_small_core_falls_back_to_feather() {
        let dir = temp_dir("poisson_small");
        let image = write_candidate(&dir, "cand.png", 32, 32);
        let patch_path = dir.join("patch.png");
        RgbaImage::from_pixel(10, 10, Rgba([250, 10, 10, 255]))
            .save(&patch_path)
            .unwrap();
        let manifest = json!({"regions": [{
            "index": 0, "type": "a", "bbox": [12, 12, 14, 14],
            "crop_box": [8, 8, 18, 18], "inner_box": [4, 4, 6, 6], "size": [10, 10]
        }]});
        let repainted = json!([{ "index": 0, "path": patch_path.to_string_lossy() }]);
        let p = CpuCompositeParams {
            image_path: image,
            manifest: manifest.to_string(),
            repainted: repainted.to_string(),
            feather_px: 0.0,
            blend: Some("poisson".to_string()),
            output_dir: dir.to_string_lossy().to_string(),
            output_name: None,
        };
        let result = try_composite(&p).unwrap().expect("cpu fast path");
        let region = &result.repaint_report.regions[0];
        assert_eq!(region.blend.as_deref(), Some("feather"));
        assert_eq!(result.repaint_report.blend, "poisson");
    }

    /// An unknown blend mode is a user error, mirroring the CLI's ValueError.
    #[test]
    fn composite_unknown_blend_errors() {
        let dir = temp_dir("blend_err");
        let image = write_candidate(&dir, "cand.png", 16, 16);
        let p = CpuCompositeParams {
            image_path: image,
            manifest: "{}".to_string(),
            repainted: "[]".to_string(),
            feather_px: 0.0,
            blend: Some("smudge".to_string()),
            output_dir: dir.to_string_lossy().to_string(),
            output_name: None,
        };
        let err = try_composite(&p).unwrap_err();
        assert!(err.contains("unknown blend mode"), "{err}");
    }

    /// A missing candidate image defers to the Python bridge (both halves).
    #[test]
    fn missing_image_defers_to_python() {
        let dir = temp_dir("missing");
        let p = prepare_params("definitely_not_here_zzx.png", &dir);
        assert!(try_prepare(&p).unwrap().is_none());
        let c = CpuCompositeParams {
            image_path: "definitely_not_here_zzx.png".to_string(),
            manifest: "{}".to_string(),
            repainted: "[]".to_string(),
            feather_px: 0.0,
            blend: None,
            output_dir: dir.to_string_lossy().to_string(),
            output_name: None,
        };
        assert!(try_composite(&c).unwrap().is_none());
    }

    /// Malformed inline JSON is a user error (mirrors `_load_json_arg`).
    #[test]
    fn invalid_json_args_error() {
        let dir = temp_dir("json");
        let image = write_candidate(&dir, "cand.png", 16, 16);
        let mut p = prepare_params(&image, &dir);
        p.quality_report = Some("{not json".to_string());
        let err = try_prepare(&p).unwrap_err();
        assert!(err.contains("invalid quality_report JSON"), "{err}");
    }

    /// DST-based Poisson solve matches the analytic solution of a constant
    /// right-hand side well enough to be exact at machine precision scale.
    #[test]
    fn poisson_solve_inverts_laplacian() {
        // Build u on a 5x7 grid, apply the 5-point Laplacian with zero
        // boundary, and check the solver returns u.
        let (h, w) = (5usize, 7usize);
        let u: Vec<f64> = (0..h * w).map(|i| ((i * 37) % 11) as f64).collect();
        let at = |x: i64, y: i64| -> f64 {
            if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                0.0
            } else {
                u[y as usize * w + x as usize]
            }
        };
        let mut rhs = vec![0f64; h * w];
        for y in 0..h {
            for x in 0..w {
                rhs[y * w + x] = 4.0 * at(x as i64, y as i64)
                    - at(x as i64 - 1, y as i64)
                    - at(x as i64 + 1, y as i64)
                    - at(x as i64, y as i64 - 1)
                    - at(x as i64, y as i64 + 1);
            }
        }
        let solved = poisson_solve(&rhs, h, w);
        for (a, b) in solved.iter().zip(&u) {
            assert!((a - b).abs() < 1e-9, "{a} != {b}");
        }
    }
}
