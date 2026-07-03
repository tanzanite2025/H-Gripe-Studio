//! In-process CPU quality watchdog fast path: a native-Rust replica of
//! `detail_watchdog_cli.py`'s rule layer (`rules` engine), run inline in the
//! `detailWatchdog` executor instead of spawning the Python bridge.
//!
//! It reproduces the CLI's Phase-1 detect-and-report heuristics step by step —
//! global Laplacian-variance blur / below-placeholder size (`low_resolution`),
//! the per-tile sharpness grid merged into boxes (`face_blur`), the bright
//! alpha-rim fringe (`edge_halo`), the subject-vs-background mean colour drift
//! (`color_mismatch`), the strict/balanced/lenient threshold table, the
//! confidence mapping and the `passed | warning | failed` aggregation — and
//! emits identical [`QualityReport`] / `WatchdogReport` structures, so the
//! node's outputs and downstream consumers are unchanged. The red-box issue
//! overlay PNG is drawn the same way (3 px outline per flagged bbox).
//!
//! Loading goes through [`super::studio_image`], the shared hardened loader:
//! the decompression-bomb guard, EXIF normalisation and CMYK / high-bit /
//! wide-gamut colour management are the same ones every other native card
//! uses, mirroring the CLI's `_load_rgb_alpha` + `wide_gamut.managed_to_srgb`.
//!
//! A learned detector (`--engine` other than `rules`) still defers to the
//! Python bridge (`detector_backends`); so does any source the loader cannot
//! decode, in which case [`try_watch`] returns `Ok(None)` and the caller
//! falls back.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde_json::Value;

use super::studio_image::{self, DEFAULT_MAX_DECODE_PIXELS};
use crate::contracts::{QualityIssue, QualityReport};
use crate::psd::{reject_unsafe_output_name, DetectQualityResult, WatchdogReport};

const EPS: f64 = 1e-6;

const ALL_TARGETS: [&str; 5] = ["face", "hands", "text", "logo", "product_edges"];
/// Watch targets the CPU rule layer cannot honestly detect on its own; the
/// opt-in ML detector (Python path) graduates the ones it covers.
const UNSUPPORTED_TARGETS: [&str; 3] = ["hands", "text", "logo"];

/// Per-mode detection thresholds (mirrors the CLI's `_MODES` table).
struct Thresholds {
    blur_floor: f64,
    region_ratio: f64,
    region_floor: f64,
    halo_delta: f64,
    color_delta: f64,
}

fn thresholds_for(mode: &str) -> Option<Thresholds> {
    match mode {
        "strict" => Some(Thresholds {
            blur_floor: 120.0,
            region_ratio: 0.6,
            region_floor: 90.0,
            halo_delta: 0.10,
            color_delta: 28.0,
        }),
        "balanced" => Some(Thresholds {
            blur_floor: 80.0,
            region_ratio: 0.45,
            region_floor: 60.0,
            halo_delta: 0.16,
            color_delta: 40.0,
        }),
        "lenient" => Some(Thresholds {
            blur_floor: 50.0,
            region_ratio: 0.3,
            region_floor: 35.0,
            halo_delta: 0.24,
            color_delta: 55.0,
        }),
        _ => None,
    }
}

/// Resolved node parameters for one watchdog run, mirroring the CLI arguments.
pub(super) struct CpuDetailWatchdogParams {
    pub(super) image_path: String,
    pub(super) visual_context: Option<String>,
    pub(super) target_bounds: Option<String>,
    pub(super) watch_targets: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) output_dir: String,
    pub(super) output_name: Option<String>,
    pub(super) device_requested: String,
}

/// Run the rule-layer watchdog in-process. Returns `Ok(Some(result))` on the
/// fast path, or `Ok(None)` when a source cannot be decoded here and the
/// caller should defer to the Python bridge, which surfaces the canonical
/// error message.
pub(super) fn try_watch(
    p: &CpuDetailWatchdogParams,
) -> Result<Option<DetectQualityResult>, String> {
    let image_path = p.image_path.trim();
    if image_path.is_empty() || !Path::new(image_path).is_file() {
        // Let the Python path surface the canonical "candidate image not found".
        return Ok(None);
    }
    let mode = p
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("balanced")
        .to_string();
    let Some(thresholds) = thresholds_for(&mode) else {
        return Err(format!(
            "unknown mode {mode:?}; expected one of [\"balanced\", \"lenient\", \"strict\"]"
        ));
    };
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;

    let raw_targets: Vec<String> = p
        .watch_targets
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let watch_set: BTreeSet<String> = if raw_targets.is_empty() {
        ALL_TARGETS.iter().map(|s| s.to_string()).collect()
    } else {
        raw_targets.into_iter().collect()
    };
    let unknown: Vec<&String> = watch_set
        .iter()
        .filter(|t| !ALL_TARGETS.contains(&t.as_str()))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "unknown watch target(s): {unknown:?}; expected {ALL_TARGETS:?}"
        ));
    }

    let visual_context = parse_json_arg(p.visual_context.as_deref(), "visual_context")?;
    let target_bounds = parse_json_arg(p.target_bounds.as_deref(), "target_bounds")?;
    let target = resolve_target(visual_context.as_ref(), target_bounds.as_ref());
    let background_mean = background_mean(visual_context.as_ref());

    let loaded = match studio_image::load_rgba(Path::new(image_path), DEFAULT_MAX_DECODE_PIXELS) {
        Ok(loaded) => loaded,
        Err(_) => return Ok(None),
    };
    let (width, height) = loaded.image.dimensions();
    let (w, h) = (width as usize, height as usize);
    let n = w * h;
    if n == 0 {
        return Ok(None);
    }
    let mut rgb = vec![0f32; n * 3];
    let mut alpha = vec![0f32; n];
    for (i, px) in loaded.image.pixels().enumerate() {
        rgb[i * 3] = f32::from(px.0[0]);
        rgb[i * 3 + 1] = f32::from(px.0[1]);
        rgb[i * 3 + 2] = f32::from(px.0[2]);
        alpha[i] = f32::from(px.0[3]) / 255.0;
    }

    // Rec.601 luminance and the 4-neighbour Laplacian high-pass response
    // (edge replicated), the base signals of every rule below.
    let lum: Vec<f32> = (0..n)
        .map(|i| rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114)
        .collect();
    let lap = laplacian(&lum, w, h);
    let global_sharpness = variance(&lap);

    let mut issues: Vec<QualityIssue> = Vec::new();
    if let Some(issue) =
        detect_low_resolution(global_sharpness, (width, height), target, &thresholds)
    {
        issues.push(issue);
    }
    issues.extend(detect_soft_regions(&lap, w, h, &watch_set, &thresholds));
    if watch_set.contains("product_edges") {
        if let Some(issue) = detect_edge_halo(&lum, &alpha, w, h, &thresholds) {
            issues.push(issue);
        }
    }
    if let Some(issue) =
        detect_color_mismatch(&rgb, &alpha, w, h, background_mean.as_ref(), &thresholds)
    {
        issues.push(issue);
    }

    let skipped: Vec<String> = watch_set
        .iter()
        .filter(|t| UNSUPPORTED_TARGETS.contains(&t.as_str()))
        .cloned()
        .collect();

    let status = if issues.is_empty() {
        "passed"
    } else if issues.len() >= 3 || issues.iter().any(|i| i.confidence >= 0.85) {
        "failed"
    } else {
        "warning"
    };

    let issue_masks = if issues.is_empty() {
        None
    } else {
        let directory = PathBuf::from(if p.output_dir.trim().is_empty() {
            "."
        } else {
            p.output_dir.trim()
        });
        std::fs::create_dir_all(&directory)
            .map_err(|err| format!("failed to create {}: {err}", directory.display()))?;
        let stem = p
            .output_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}_issues", safe_stem(image_path)));
        let overlay_path = directory.join(format!("{stem}.png"));
        write_issue_overlay(&rgb, w, h, &issues, &overlay_path)?;
        Some(overlay_path.to_string_lossy().to_string())
    };

    let device_requested = {
        let d = p.device_requested.trim().to_ascii_lowercase();
        if d.is_empty() {
            "auto".to_string()
        } else {
            d
        }
    };

    Ok(Some(DetectQualityResult {
        // Phase 1 is detect-only: the candidate is returned unchanged.
        fixed_image: image_path.to_string(),
        quality_report: QualityReport {
            status: status.to_string(),
            issues,
        },
        issue_masks,
        watchdog_report: WatchdogReport {
            mode,
            watch_targets: watch_set.into_iter().collect(),
            skipped_targets: skipped,
            image_size: Some([i64::from(width), i64::from(height)]),
            target_size: target.map(|(tw, th)| [i64::from(tw), i64::from(th)]),
            global_sharpness: (global_sharpness * 100.0).round() / 100.0,
            source_mode: loaded.meta.source_mode,
            exif_transposed: loaded.meta.exif_transposed,
            max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS as i64,
            // The optional mask is advisory in Phase 1; detection runs on the
            // image's own alpha rim, so the supplied matte is not consumed.
            mask_consumed: false,
            engine: "rules".to_string(),
            engine_requested: "rules".to_string(),
            engine_fallback_reason: None,
            detectors: Vec::new(),
            backend_model: None,
            device: None,
            device_requested,
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

/// Parse an inline JSON object argument, raising on malformed input (mirrors
/// `_load_json_arg`: a non-object parses to `None`).
fn parse_json_arg(raw: Option<&str>, label: &str) -> Result<Option<Value>, String> {
    let text = raw.map(str::trim).unwrap_or("");
    if text.is_empty() {
        return Ok(None);
    }
    let parsed: Value =
        serde_json::from_str(text).map_err(|err| format!("invalid {label} JSON: {err}"))?;
    Ok(parsed.is_object().then_some(parsed))
}

/// Target placeholder pixel size from explicit bounds or the visual context
/// (mirrors `_resolve_target`).
fn resolve_target(
    visual_context: Option<&Value>,
    target_bounds: Option<&Value>,
) -> Option<(u32, u32)> {
    let bounds = target_bounds
        .cloned()
        .or_else(|| visual_context?.get("placeholder")?.get("bounds").cloned())?;
    if !bounds.is_object() {
        return None;
    }
    let dim = |key: &str| -> i64 {
        match bounds.get(key) {
            Some(Value::Number(v)) => v.as_f64().unwrap_or(0.0) as i64,
            _ => 0,
        }
    };
    let (width, height) = (dim("width"), dim("height"));
    if width <= 0 || height <= 0 {
        return None;
    }
    Some((width as u32, height as u32))
}

/// The connected background mean RGB colour, when available (mirrors
/// `_background_mean`).
fn background_mean(visual_context: Option<&Value>) -> Option<[f32; 3]> {
    let mean = visual_context?.get("background")?.get("mean_color")?;
    let arr = mean.as_array()?;
    if arr.len() < 3 {
        return None;
    }
    let mut out = [0f32; 3];
    for (o, v) in out.iter_mut().zip(arr) {
        *o = v.as_f64()? as f32;
    }
    Some(out)
}

/// 4-neighbour Laplacian high-pass response with edge replication (mirrors
/// `_laplacian`).
fn laplacian(lum: &[f32], w: usize, h: usize) -> Vec<f32> {
    let at = |x: usize, y: usize| lum[y * w + x];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let up = at(x, y.saturating_sub(1));
            let down = at(x, (y + 1).min(h - 1));
            let left = at(x.saturating_sub(1), y);
            let right = at((x + 1).min(w - 1), y);
            out[y * w + x] = up + down + left + right - 4.0 * at(x, y);
        }
    }
    out
}

/// Population variance of a plane (numpy's `var()` default).
fn variance(values: &[f32]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let n = values.len() as f64;
    let mean = values.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    values
        .iter()
        .map(|&v| {
            let d = f64::from(v) - mean;
            d * d
        })
        .sum::<f64>()
        / n
}

/// Median of a plane (numpy's `median`: mean of the two middle values for an
/// even count).
fn median(values: &[f32]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f32> = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        f64::from(sorted[mid])
    } else {
        (f64::from(sorted[mid - 1]) + f64::from(sorted[mid])) / 2.0
    }
}

/// Map how far `value` crosses `threshold` to a 0.5..0.95 confidence
/// (mirrors `_confidence`).
fn confidence(value: f64, threshold: f64, span: f64) -> f64 {
    let over = (value - threshold) / span.max(EPS);
    let c = (0.5 + 0.45 * over).clamp(0.5, 0.95);
    (c * 100.0).round() / 100.0
}

/// Global blur (Laplacian variance) and/or below the target placeholder size
/// (mirrors `_detect_low_resolution`).
fn detect_low_resolution(
    sharpness: f64,
    size: (u32, u32),
    target: Option<(u32, u32)>,
    thresholds: &Thresholds,
) -> Option<QualityIssue> {
    let (width, height) = size;
    let floor = thresholds.blur_floor;
    let too_small = target.is_some_and(|(tw, th)| {
        f64::from(width) < f64::from(tw) * 0.9 || f64::from(height) < f64::from(th) * 0.9
    });
    if sharpness >= floor && !too_small {
        return None;
    }
    let confidence = if too_small {
        let (tw, th) = target.expect("too_small implies a target");
        let ratio = (f64::from(width) / f64::from(tw)).min(f64::from(height) / f64::from(th));
        let c = (0.5 + 0.45 * (1.0 - ratio)).clamp(0.5, 0.95);
        (c * 100.0).round() / 100.0
    } else {
        confidence(floor - sharpness, 0.0, floor)
    };
    Some(QualityIssue {
        issue_type: "low_resolution".to_string(),
        confidence,
        bbox: [0, 0, i64::from(width), i64::from(height)],
        suggested_action: "image_enhance".to_string(),
    })
}

/// Per-tile sharpness grid -> merged boxes for locally soft areas (mirrors
/// `_detect_soft_regions`).
fn detect_soft_regions(
    lap: &[f32],
    w: usize,
    h: usize,
    watch: &BTreeSet<String>,
    thresholds: &Thresholds,
) -> Vec<QualityIssue> {
    let cols = 8usize;
    let rows = ((cols as f64 * h as f64 / w.max(1) as f64).round() as usize).clamp(1, 8);
    // np.linspace(0, size, k+1, dtype=int): truncation of evenly spaced floats.
    let ys: Vec<usize> = (0..=rows).map(|r| h * r / rows).collect();
    let xs: Vec<usize> = (0..=cols).map(|c| w * c / cols).collect();

    let mut tile_sharp = vec![0f32; rows * cols];
    for r in 0..rows {
        for c in 0..cols {
            let mut tile: Vec<f32> = Vec::new();
            for y in ys[r]..ys[r + 1] {
                tile.extend_from_slice(&lap[y * w + xs[c]..y * w + xs[c + 1]]);
            }
            tile_sharp[r * cols + c] = if tile.is_empty() {
                0.0
            } else {
                variance(&tile) as f32
            };
        }
    }

    let median = median(&tile_sharp);
    if median <= EPS {
        return Vec::new();
    }
    let flagged: Vec<bool> = tile_sharp
        .iter()
        .map(|&s| {
            f64::from(s) < thresholds.region_ratio * median
                && f64::from(s) < thresholds.region_floor
        })
        .collect();
    if !flagged.iter().any(|&f| f) {
        return Vec::new();
    }

    let watching_face = watch.contains("face");
    let issue_type = if watching_face {
        "face_blur"
    } else {
        "low_resolution"
    };
    let mut issues = Vec::new();
    for cells in label_grid(&flagged, rows, cols) {
        let r1 = cells.iter().map(|&(r, _)| r).min().expect("non-empty");
        let r2 = cells.iter().map(|&(r, _)| r).max().expect("non-empty");
        let c1 = cells.iter().map(|&(_, c)| c).min().expect("non-empty");
        let c2 = cells.iter().map(|&(_, c)| c).max().expect("non-empty");
        // When watching faces, prefer regions overlapping the upper portion of
        // the frame (where faces usually sit); skip purely-bottom soft areas.
        if watching_face && r1 > rows / 2 {
            continue;
        }
        let mut region: Vec<f32> = Vec::new();
        for r in r1..=r2 {
            for c in c1..=c2 {
                region.push(tile_sharp[r * cols + c]);
            }
        }
        let sharp = region.iter().map(|&v| f64::from(v)).sum::<f64>() / region.len() as f64;
        issues.push(QualityIssue {
            issue_type: issue_type.to_string(),
            confidence: confidence(
                thresholds.region_floor - sharp,
                0.0,
                thresholds.region_floor,
            ),
            bbox: [
                xs[c1] as i64,
                ys[r1] as i64,
                xs[c2 + 1] as i64,
                ys[r2 + 1] as i64,
            ],
            suggested_action: "detail_redraw".to_string(),
        });
    }
    issues
}

/// 4-connected components over a small boolean tile grid (mirrors
/// `_label_grid`'s flood fill).
fn label_grid(flagged: &[bool], rows: usize, cols: usize) -> Vec<Vec<(usize, usize)>> {
    let mut seen = vec![false; rows * cols];
    let mut components = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            if !flagged[r * cols + c] || seen[r * cols + c] {
                continue;
            }
            let mut stack = vec![(r, c)];
            seen[r * cols + c] = true;
            let mut cells = Vec::new();
            while let Some((cr, cc)) = stack.pop() {
                cells.push((cr, cc));
                let neighbours = [
                    (cr.wrapping_add(1), cc),
                    (cr.wrapping_sub(1), cc),
                    (cr, cc.wrapping_add(1)),
                    (cr, cc.wrapping_sub(1)),
                ];
                for (nr, nc) in neighbours {
                    if nr < rows && nc < cols && flagged[nr * cols + nc] && !seen[nr * cols + nc] {
                        seen[nr * cols + nc] = true;
                        stack.push((nr, nc));
                    }
                }
            }
            components.push(cells);
        }
    }
    components
}

/// Bright fringe on the semi-transparent rim of a cut-out subject (mirrors
/// `_detect_edge_halo`).
fn detect_edge_halo(
    lum: &[f32],
    alpha: &[f32],
    w: usize,
    h: usize,
    thresholds: &Thresholds,
) -> Option<QualityIssue> {
    let mut rim_sum = 0f64;
    let mut rim_count = 0usize;
    let mut interior_sum = 0f64;
    let mut interior_count = 0usize;
    for i in 0..alpha.len() {
        let a = alpha[i];
        if a > 0.05 && a < 0.95 {
            rim_sum += f64::from(lum[i]) / 255.0;
            rim_count += 1;
        } else if a >= 0.95 {
            interior_sum += f64::from(lum[i]) / 255.0;
            interior_count += 1;
        }
    }
    if rim_count < 16 || interior_count < 16 {
        return None;
    }
    let delta = rim_sum / rim_count as f64 - interior_sum / interior_count as f64;
    if delta < thresholds.halo_delta {
        return None;
    }
    let bbox = bbox_from_mask(&alpha.iter().map(|&a| a > 0.05).collect::<Vec<_>>(), w, h)?;
    Some(QualityIssue {
        issue_type: "edge_halo".to_string(),
        confidence: confidence(delta, thresholds.halo_delta, 0.4),
        bbox,
        suggested_action: "edge_refine".to_string(),
    })
}

/// Subject mean colour drifting from the connected background colour (mirrors
/// `_detect_color_mismatch`).
fn detect_color_mismatch(
    rgb: &[f32],
    alpha: &[f32],
    w: usize,
    h: usize,
    background_mean: Option<&[f32; 3]>,
    thresholds: &Thresholds,
) -> Option<QualityIssue> {
    let bg = background_mean?;
    let subject: Vec<bool> = alpha.iter().map(|&a| a >= 0.5).collect();
    let any_subject = subject.iter().any(|&s| s);
    let mut sum = [0f64; 3];
    let mut count = 0usize;
    for i in 0..alpha.len() {
        if any_subject && !subject[i] {
            continue;
        }
        for c in 0..3 {
            sum[c] += f64::from(rgb[i * 3 + c]);
        }
        count += 1;
    }
    if count == 0 {
        return None;
    }
    let mut delta_sq = 0f64;
    for c in 0..3 {
        let d = sum[c] / count as f64 - f64::from(bg[c]);
        delta_sq += d * d;
    }
    let delta = delta_sq.sqrt();
    if delta < thresholds.color_delta {
        return None;
    }
    let bbox = if any_subject {
        bbox_from_mask(&subject, w, h)
    } else {
        None
    }
    .unwrap_or([0, 0, w as i64, h as i64]);
    Some(QualityIssue {
        issue_type: "color_mismatch".to_string(),
        confidence: confidence(delta, thresholds.color_delta, 80.0),
        bbox,
        suggested_action: "color_match".to_string(),
    })
}

/// Tight `[x1, y1, x2, y2]` around the true pixels, or None when empty
/// (mirrors `_bbox_from_mask`).
fn bbox_from_mask(mask: &[bool], w: usize, h: usize) -> Option<[i64; 4]> {
    let mut x1 = w;
    let mut y1 = h;
    let mut x2 = 0usize;
    let mut y2 = 0usize;
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if mask[y * w + x] {
                any = true;
                x1 = x1.min(x);
                y1 = y1.min(y);
                x2 = x2.max(x);
                y2 = y2.max(y);
            }
        }
    }
    any.then(|| [x1 as i64, y1 as i64, x2 as i64 + 1, y2 as i64 + 1])
}

/// Draw red boxes around each flagged region for UI / PSD review (mirrors
/// `_write_issue_overlay`: a 3 px outline per bbox on an RGBA copy).
fn write_issue_overlay(
    rgb: &[f32],
    w: usize,
    h: usize,
    issues: &[QualityIssue],
    path: &Path,
) -> Result<(), String> {
    let mut img = RgbaImage::new(w as u32, h as u32);
    for (i, px) in img.pixels_mut().enumerate() {
        px.0 = [
            rgb[i * 3].round().clamp(0.0, 255.0) as u8,
            rgb[i * 3 + 1].round().clamp(0.0, 255.0) as u8,
            rgb[i * 3 + 2].round().clamp(0.0, 255.0) as u8,
            255,
        ];
    }
    let red = image::Rgba([255u8, 64, 64, 255]);
    for issue in issues {
        let [bx1, by1, bx2, by2] = issue.bbox;
        // Pillow's draw.rectangle([x1, y1, x2-1, y2-1], width=3): an inclusive
        // rectangle whose 3 px outline grows inward.
        let x1 = bx1.clamp(0, w as i64 - 1) as u32;
        let y1 = by1.clamp(0, h as i64 - 1) as u32;
        let x2 = (bx2 - 1).max(bx1).clamp(0, w as i64 - 1) as u32;
        let y2 = (by2 - 1).max(by1).clamp(0, h as i64 - 1) as u32;
        for ring in 0..3u32 {
            let (rx1, ry1) = (x1 + ring, y1 + ring);
            let (rx2, ry2) = (x2.saturating_sub(ring), y2.saturating_sub(ring));
            if rx1 > rx2 || ry1 > ry2 {
                break;
            }
            for x in rx1..=rx2 {
                img.put_pixel(x, ry1, red);
                img.put_pixel(x, ry2, red);
            }
            for y in ry1..=ry2 {
                img.put_pixel(rx1, y, red);
                img.put_pixel(rx2, y, red);
            }
        }
    }
    img.save(path)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn params(image: &str, out_dir: &str) -> CpuDetailWatchdogParams {
        CpuDetailWatchdogParams {
            image_path: image.to_string(),
            visual_context: None,
            target_bounds: None,
            watch_targets: None,
            mode: None,
            output_dir: out_dir.to_string(),
            output_name: None,
            device_requested: "auto".to_string(),
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hgripe_detail_watchdog_cpu_{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A high-frequency checkerboard is sharp: no issues, report passes, no
    /// overlay is written, and the rule-layer telemetry is filled in.
    #[test]
    fn sharp_image_passes() {
        let dir = temp_dir("sharp");
        let path = dir.join("sharp.png");
        let mut img = RgbaImage::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 255 } else { 0 };
            px.0 = [v, v, v, 255];
        }
        img.save(&path).unwrap();

        let result = try_watch(&params(path.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("cpu fast path");
        assert_eq!(result.quality_report.status, "passed");
        assert!(result.quality_report.issues.is_empty());
        assert!(result.issue_masks.is_none());
        assert_eq!(result.fixed_image, path.to_str().unwrap());
        let report = &result.watchdog_report;
        assert_eq!(report.mode, "balanced");
        assert_eq!(report.engine, "rules");
        assert_eq!(report.skipped_targets, vec!["hands", "logo", "text"]);
        assert!(report.global_sharpness > 80.0);
        assert_eq!(report.image_size, Some([64, 64]));
        assert!(!report.mask_consumed);
    }

    /// A flat image is globally blurry: low_resolution flagged and the red-box
    /// overlay written.
    #[test]
    fn flat_image_flags_low_resolution() {
        let dir = temp_dir("flat");
        let path = dir.join("flat.png");
        RgbaImage::from_pixel(64, 64, Rgba([128, 128, 128, 255]))
            .save(&path)
            .unwrap();

        let result = try_watch(&params(path.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("cpu fast path");
        let issues = &result.quality_report.issues;
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].issue_type, "low_resolution");
        assert_eq!(issues[0].suggested_action, "image_enhance");
        assert_eq!(issues[0].bbox, [0, 0, 64, 64]);
        assert!((issues[0].confidence - 0.95).abs() < 1e-9);
        assert_eq!(result.quality_report.status, "failed");
        let overlay = result.issue_masks.expect("overlay written");
        assert!(Path::new(&overlay).is_file());
    }

    /// An image smaller than the placeholder bounds flags low_resolution even
    /// when sharp.
    #[test]
    fn below_target_size_flags_low_resolution() {
        let dir = temp_dir("target");
        let path = dir.join("small.png");
        let mut img = RgbaImage::new(32, 32);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 255 } else { 0 };
            px.0 = [v, v, v, 255];
        }
        img.save(&path).unwrap();

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.target_bounds = Some(r#"{"x":0,"y":0,"width":100,"height":100}"#.to_string());
        let result = try_watch(&p).unwrap().expect("cpu fast path");
        let issues = &result.quality_report.issues;
        assert!(
            issues.iter().any(|i| i.issue_type == "low_resolution"),
            "{issues:?}"
        );
        assert_eq!(result.watchdog_report.target_size, Some([100, 100]));
    }

    /// A bright rim around an opaque dark subject flags edge_halo (only when
    /// product_edges is watched).
    #[test]
    fn bright_rim_flags_edge_halo() {
        let dir = temp_dir("halo");
        let path = dir.join("halo.png");
        let mut img = RgbaImage::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let dx = (f64::from(x) - 32.0).abs();
            let dy = (f64::from(y) - 32.0).abs();
            let d = dx.max(dy);
            if d < 20.0 {
                // Dark interior with a little texture so it is not "blurry".
                let v = if (x + y) % 2 == 0 { 40 } else { 90 };
                px.0 = [v, v, v, 255];
            } else if d < 26.0 {
                px.0 = [255, 255, 255, 128]; // bright semi-transparent rim
            } else {
                px.0 = [0, 0, 0, 0];
            }
        }
        img.save(&path).unwrap();

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.watch_targets = Some("product_edges".to_string());
        p.mode = Some("lenient".to_string());
        let result = try_watch(&p).unwrap().expect("cpu fast path");
        let issues = &result.quality_report.issues;
        let halo = issues
            .iter()
            .find(|i| i.issue_type == "edge_halo")
            .unwrap_or_else(|| panic!("{issues:?}"));
        assert_eq!(halo.suggested_action, "edge_refine");
        // watching only product_edges: hands/text/logo are not skipped targets.
        assert!(result.watchdog_report.skipped_targets.is_empty());
    }

    /// A subject far from the context's background mean colour flags
    /// color_mismatch.
    #[test]
    fn color_drift_flags_color_mismatch() {
        let dir = temp_dir("mismatch");
        let path = dir.join("red.png");
        let mut img = RgbaImage::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 255 } else { 200 };
            px.0 = [v, 0, 0, 255];
        }
        img.save(&path).unwrap();

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.visual_context = Some(r#"{"background": {"mean_color": [0, 0, 255]}}"#.to_string());
        let result = try_watch(&p).unwrap().expect("cpu fast path");
        let issues = &result.quality_report.issues;
        let mismatch = issues
            .iter()
            .find(|i| i.issue_type == "color_mismatch")
            .unwrap_or_else(|| panic!("{issues:?}"));
        assert_eq!(mismatch.suggested_action, "color_match");
    }

    /// Unknown mode / watch target are user errors, surfaced directly (the
    /// Python CLI raises the same).
    #[test]
    fn unknown_mode_and_target_error() {
        let dir = temp_dir("bad");
        let path = dir.join("img.png");
        RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.mode = Some("paranoid".to_string());
        let err = try_watch(&p).unwrap_err();
        assert!(err.contains("unknown mode"), "{err}");

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.watch_targets = Some("face,dragons".to_string());
        let err = try_watch(&p).unwrap_err();
        assert!(err.contains("unknown watch target"), "{err}");
    }

    /// Malformed inline JSON is a user error, same as the CLI's ValueError.
    #[test]
    fn invalid_context_json_errors() {
        let dir = temp_dir("json");
        let path = dir.join("img.png");
        RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();

        let mut p = params(path.to_str().unwrap(), dir.to_str().unwrap());
        p.visual_context = Some("{not json".to_string());
        let err = try_watch(&p).unwrap_err();
        assert!(err.contains("invalid visual_context JSON"), "{err}");
    }

    /// A missing candidate image defers to the Python bridge, which surfaces
    /// the canonical error message.
    #[test]
    fn missing_image_defers_to_python() {
        let dir = temp_dir("missing");
        let p = params("definitely_not_here_zzx.png", dir.to_str().unwrap());
        assert!(try_watch(&p).unwrap().is_none());
    }
}
