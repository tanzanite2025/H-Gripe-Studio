//! In-process CPU light & colour matching for the deterministic `cpu` engine,
//! run inline in the `matchLightColor` executor.
//!
//! It reproduces the CLI's algorithm step by step — the correction region
//! (subject alpha, optionally narrowed by a mask), Reinhard mean/std transfer
//! in Lab, per-channel CDF histogram matching, the hybrid two-pass combination,
//! the shadow/highlight tone-protection weight and the high-chroma brand-colour
//! guard — and emits an identical [`MatchReport`] (same field names /
//! semantics), so the node's outputs and downstream consumers are unchanged.
//! Lab here is the CIE 1976 space computed analytically from sRGB (Pillow's
//! byte-scaled convention: `L*` over 0..255, `a`/`b` offset by 128), so the
//! statistics land on the report contract's canonical scale.
//!
//! Loading goes through [`super::studio_image`], the shared hardened loader:
//! the decompression-bomb guard, EXIF normalisation and high-bit /
//! wide-gamut colour management are the same ones every other native card uses
//! (the colour pipeline's canonical ingress), mirroring the CLI's
//! `_load_rgb_alpha` + `wide_gamut.managed_to_srgb`.
//!
use std::path::{Path, PathBuf};

use image::imageops::{self, FilterType};
use image::RgbaImage;
use serde_json::Value;

use super::image_buffer;
use super::studio_image::{self, LoadMeta, DEFAULT_MAX_DECODE_PIXELS};
use crate::psd::{reject_unsafe_output_name, ColorAppearance, ColorMatchResult, MatchReport};

const EPS: f64 = 1e-6;
const RATIO_MIN: f64 = 0.5;
const RATIO_MAX: f64 = 2.0;
const CHROMA_NORM: f64 = 110.0;

/// Resolved node parameters for one match run, mirroring the CLI arguments.
pub(crate) struct CpuColorMatchParams {
    pub(crate) image_path: String,
    pub(crate) background_path: Option<String>,
    pub(crate) mask_path: Option<String>,
    pub(crate) context: Option<String>,
    pub(crate) mode: Option<String>,
    pub(crate) strength: f64,
    pub(crate) shadow_strength: f64,
    pub(crate) highlight_strength: f64,
    pub(crate) protect_saturation: bool,
    pub(crate) protect_brand_color: bool,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) engine_requested: String,
    pub(crate) device_requested: String,
}

/// A loaded surface split into the pipeline's working planes.
struct Planes {
    width: u32,
    height: u32,
    /// Interleaved RGB, 0..255.
    rgb: Vec<f64>,
    /// 0..1.
    alpha: Vec<f64>,
    meta: LoadMeta,
}

fn load_planes(path: &Path) -> Result<Planes, String> {
    let loaded = studio_image::load_rgba(path, DEFAULT_MAX_DECODE_PIXELS)?;
    let (width, height) = loaded.image.dimensions();
    let n = (width as usize) * (height as usize);
    let mut rgb = vec![0f64; n * 3];
    let mut alpha = vec![0f64; n];
    for (i, px) in loaded.image.pixels().enumerate() {
        rgb[i * 3] = f64::from(px.0[0]);
        rgb[i * 3 + 1] = f64::from(px.0[1]);
        rgb[i * 3 + 2] = f64::from(px.0[2]);
        alpha[i] = f64::from(px.0[3]) / 255.0;
    }
    Ok(Planes {
        width,
        height,
        rgb,
        alpha,
        meta: loaded.meta,
    })
}

/// Run the CPU match pipeline in-process. Returns `Ok(Some(result))` on the
/// fast path, or `Ok(None)` when a source cannot be decoded by the native
/// loader. Both public callers surface that as an unsupported-source error.
pub(crate) fn try_match(p: &CpuColorMatchParams) -> Result<Option<ColorMatchResult>, String> {
    let image_path = p.image_path.trim();
    if image_path.is_empty() || !Path::new(image_path).is_file() {
        return Err(format!("subject image not found: {image_path}"));
    }
    let mode = p
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("color_transfer")
        .to_string();
    if !matches!(
        mode.as_str(),
        "prompt_only" | "color_transfer" | "histogram_match" | "hybrid"
    ) {
        return Err(format!(
            "unknown mode {mode:?}; expected one of [\"color_transfer\", \"histogram_match\", \"hybrid\", \"prompt_only\"]"
        ));
    }
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;

    let strength = p.strength.clamp(0.0, 1.0);
    let shadow_strength = p.shadow_strength.clamp(0.0, 1.0);
    let highlight_strength = p.highlight_strength.clamp(0.0, 1.0);
    let engine_requested = {
        let engine = p.engine_requested.trim().to_ascii_lowercase();
        if engine.is_empty() {
            "cpu".to_string()
        } else {
            engine
        }
    };
    if engine_requested != "cpu" {
        return Err(format!(
            "Match Light & Color local engine {engine_requested:?} is retired; use engine \"cpu\""
        ));
    }
    let device_requested = {
        let device = p.device_requested.trim().to_ascii_lowercase();
        if device.is_empty() {
            "auto".to_string()
        } else {
            device
        }
    };
    let subject = match load_planes(Path::new(image_path)) {
        Ok(planes) => planes,
        Err(_) => return Ok(None),
    };
    let (width, height) = (subject.width, subject.height);
    let n = (width as usize) * (height as usize);
    if n == 0 {
        return Ok(None);
    }

    // The correction region: inside the subject's alpha, optionally narrowed
    // by an explicit mask. Fall back to the whole frame when no coverage.
    let mut region: Vec<f64> = subject
        .alpha
        .iter()
        .map(|&a| if a > 0.0 { 1.0 } else { 0.0 })
        .collect();
    if let Some(mask_path) = p
        .mask_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mask = match studio_image::load_mask(Path::new(mask_path), DEFAULT_MAX_DECODE_PIXELS) {
            Ok(mask) => mask,
            Err(_) => return Ok(None),
        };
        let mask = if mask.dimensions() != (width, height) {
            imageops::resize(&mask, width, height, FilterType::Triangle)
        } else {
            mask
        };
        for (r, px) in region.iter_mut().zip(mask.pixels()) {
            *r *= f64::from(px.0[0]) / 255.0;
        }
    }
    if region.iter().sum::<f64>() < EPS {
        region = vec![1.0; n];
    }

    // The (optional) background reference: only its opaque pixels describe the
    // target lighting, so a cut-out plate cannot skew the statistics.
    let background = match p.background_path.as_deref().map(str::trim) {
        Some(bg) if !bg.is_empty() => {
            if !Path::new(bg).is_file() {
                return Err(format!("background image not found: {bg}"));
            }
            match load_planes(Path::new(bg)) {
                Ok(planes) => Some(planes),
                Err(_) => return Ok(None),
            }
        }
        _ => None,
    };
    let background_region = background.as_ref().map(|bg| {
        let mut region: Vec<f64> = bg
            .alpha
            .iter()
            .map(|&a| if a > 0.0 { 1.0 } else { 0.0 })
            .collect();
        if region.iter().sum::<f64>() < EPS {
            region = vec![1.0; region.len()];
        }
        region
    });

    let context = p
        .context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object);
    let prompt_suffix = prompt_suffix(
        context.as_ref(),
        background.as_ref().map(|bg| bg.rgb.as_slice()),
        background_region.as_deref(),
    );

    let before = appearance(&subject.rgb, &region);
    let pixels_change = mode != "prompt_only" && strength > 0.0;

    let mut report = MatchReport {
        mode: mode.clone(),
        strength: round4(strength),
        shadow_strength: round4(shadow_strength),
        highlight_strength: round4(highlight_strength),
        protect_saturation: p.protect_saturation,
        protect_brand_color: p.protect_brand_color,
        source_mode: subject.meta.source_mode.clone(),
        background_mode: background.as_ref().map(|bg| bg.meta.source_mode.clone()),
        exif_transposed: subject.meta.exif_transposed,
        max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS as i64,
        applied: false,
        before: before.clone(),
        after: before,
        engine: "cpu".to_string(),
        engine_requested: engine_requested.clone(),
        device_requested: device_requested.clone(),
        ..MatchReport::default()
    };

    let out_rgb: Vec<f64> = match (pixels_change, background.as_ref()) {
        (false, _) | (true, None) => {
            // prompt_only, zero strength, or nothing to match against: pass the
            // subject through untouched so the node is still wired-up correctly.
            if mode != "prompt_only" && background.is_none() {
                report.note = Some(
                    "no background image connected; passed subject through unchanged".to_string(),
                );
            }
            subject.rgb.clone()
        }
        (true, Some(bg)) => {
            let bg_region = background_region
                .as_deref()
                .expect("paired with background");
            let subj_lab = rgb_to_lab(&subject.rgb);
            let bg_lab = rgb_to_lab(&bg.rgb);
            let weight: Vec<f64> = tone_protection_weight(
                &subj_lab,
                strength,
                shadow_strength,
                highlight_strength,
                p.protect_brand_color,
            )
            .iter()
            .zip(&region)
            .map(|(&w, &r)| w * r)
            .collect();

            let mut result_lab = if mode == "color_transfer" || mode == "hybrid" {
                let (transferred, stats) =
                    color_transfer(&subj_lab, &bg_lab, &region, bg_region, p.protect_saturation);
                report.src_mean_lab = Some(stats.src_mean.to_vec());
                report.dst_mean_lab = Some(stats.dst_mean.to_vec());
                report.src_std_lab = Some(stats.src_std.to_vec());
                report.dst_std_lab = Some(stats.dst_std.to_vec());
                blend(&subj_lab, &transferred, &weight)
            } else {
                subj_lab.clone()
            };

            if mode == "histogram_match" || mode == "hybrid" {
                // Gentler second pass for hybrid so the transfer stays dominant.
                let hist_weight: Vec<f64> = weight
                    .iter()
                    .map(|&w| w * if mode == "hybrid" { 0.5 } else { 1.0 })
                    .collect();
                let base = if mode == "hybrid" {
                    result_lab.clone()
                } else {
                    subj_lab.clone()
                };
                let mut matched = base.clone();
                for ch in 0..3 {
                    if p.protect_saturation && ch > 0 {
                        continue;
                    }
                    let src: Vec<i64> = base
                        .iter()
                        .skip(ch)
                        .step_by(3)
                        .map(|&v| v.round() as i64)
                        .collect();
                    let reference: Vec<i64> = bg_lab
                        .iter()
                        .skip(ch)
                        .step_by(3)
                        .zip(bg_region)
                        .filter(|(_, &sel)| sel > 0.5)
                        .map(|(&v, _)| v.round() as i64)
                        .collect();
                    let mapped = histogram_match(&src, &reference);
                    for (i, v) in mapped.into_iter().enumerate() {
                        matched[i * 3 + ch] = v;
                    }
                }
                result_lab = blend(&base, &matched, &hist_weight);
            }

            let out = lab_to_rgb(&result_lab);
            report.applied = true;
            report.after = appearance(&out, &region);
            out
        }
    };

    // Recombine the (untouched) alpha and write the matched RGBA PNG.
    // prompt_only still writes a copy so downstream always gets a path.
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
        .unwrap_or_else(|| format!("{}_matched", safe_stem(image_path)));

    let mut rgba = RgbaImage::new(width, height);
    for (i, px) in rgba.pixels_mut().enumerate() {
        px.0 = [
            out_rgb[i * 3].round().clamp(0.0, 255.0) as u8,
            out_rgb[i * 3 + 1].round().clamp(0.0, 255.0) as u8,
            out_rgb[i * 3 + 2].round().clamp(0.0, 255.0) as u8,
            (subject.alpha[i] * 255.0).round().clamp(0.0, 255.0) as u8,
        ];
    }
    let matched_path = directory.join(format!("{stem}.png"));
    rgba.save(&matched_path)
        .map_err(|err| format!("failed to write {}: {err}", matched_path.display()))?;
    image_buffer::publish_rgba(
        &matched_path,
        &rgba,
        LoadMeta {
            source_mode: "RGBA".to_string(),
            exif_transposed: false,
        },
    );
    report.output_size = Some([i64::from(width), i64::from(height)]);

    Ok(Some(ColorMatchResult {
        matched_image: matched_path.to_string_lossy().to_string(),
        prompt_suffix,
        match_report: report,
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

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Rough correlated colour temperature from the red/blue balance (mirrors
/// `analyze_psd_cli._color_temperature`, same scale as PSD Context Analyze).
fn color_temperature(mean_rgb: &[f64; 3]) -> u32 {
    let red = mean_rgb[0] + 1.0;
    let blue = mean_rgb[2] + 1.0;
    let kelvin = (2000.0 + (blue / red) * 4500.0).clamp(2000.0, 12_000.0);
    ((kelvin / 100.0).round() * 100.0) as u32
}

fn warmth_label(kelvin: u32) -> &'static str {
    if kelvin < 4500 {
        "warm"
    } else if kelvin > 6500 {
        "cool"
    } else {
        "neutral"
    }
}

/// Weighted per-channel mean and std of interleaved (C-channel) values over a
/// per-pixel weight (mirrors `_region_stats`).
fn region_stats<const C: usize>(values: &[f64], weight: &[f64]) -> ([f64; C], [f64; C]) {
    let total = weight.iter().sum::<f64>() + EPS;
    let mut mean = [0f64; C];
    for (i, &w) in weight.iter().enumerate() {
        for c in 0..C {
            mean[c] += values[i * C + c] * w;
        }
    }
    for m in &mut mean {
        *m /= total;
    }
    let mut var = [0f64; C];
    for (i, &w) in weight.iter().enumerate() {
        for c in 0..C {
            let d = values[i * C + c] - mean[c];
            var[c] += d * d * w;
        }
    }
    let mut std = [0f64; C];
    for c in 0..C {
        std[c] = (var[c] / total).max(0.0).sqrt();
    }
    (mean, std)
}

/// mean_color / color_temperature / contrast over the weighted region
/// (mirrors `_appearance`).
fn appearance(rgb: &[f64], weight: &[f64]) -> ColorAppearance {
    let (mean_rgb, _) = region_stats::<3>(rgb, weight);
    let gray: Vec<f64> = (0..weight.len())
        .map(|i| rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114)
        .collect();
    let (_, gray_std) = region_stats::<1>(&gray, weight);
    ColorAppearance {
        mean_color: [
            mean_rgb[0].round().clamp(0.0, 255.0) as u8,
            mean_rgb[1].round().clamp(0.0, 255.0) as u8,
            mean_rgb[2].round().clamp(0.0, 255.0) as u8,
        ],
        color_temperature: color_temperature(&mean_rgb),
        contrast: round4((gray_std[0] / 128.0).min(1.0)),
    }
}

/// Reuse the upstream context's suffix when present, else synthesise one from
/// the background's colour temperature (mirrors `_prompt_suffix`).
fn prompt_suffix(
    context: Option<&Value>,
    background_rgb: Option<&[f64]>,
    background_region: Option<&[f64]>,
) -> String {
    let (quality, direction, kelvin) = if let Some(context) = context {
        let existing = context
            .get("prompt_suffix")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if !existing.is_empty() {
            return existing.to_string();
        }
        let lighting = context.get("lighting");
        let get_str = |key: &str, default: &str| {
            lighting
                .and_then(|l| l.get(key))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(default)
                .to_string()
        };
        let kelvin = lighting
            .and_then(|l| l.get("color_temperature"))
            .and_then(Value::as_i64)
            .filter(|&k| k != 0)
            .unwrap_or(5500) as u32;
        (
            get_str("quality", "soft"),
            get_str("direction", "center"),
            kelvin,
        )
    } else if let Some(bg) = background_rgb {
        let ones;
        let weight = match background_region {
            Some(region) => region,
            None => {
                ones = vec![1.0; bg.len() / 3];
                &ones
            }
        };
        let (mean_rgb, _) = region_stats::<3>(bg, weight);
        (
            "soft".to_string(),
            "center".to_string(),
            color_temperature(&mean_rgb),
        )
    } else {
        return String::new();
    };
    let warmth = warmth_label(kelvin);
    format!(
        "matched with the PSD background lighting: {quality} key light from {direction}, \
         {warmth} background, color temperature {kelvin}k, \
         realistic contact shadow, consistent highlight direction, no floating object"
    )
}

/// Per-pixel correction weight, emphasising shadows/highlights and sparing
/// high-chroma (brand) pixels (mirrors `_tone_protection_weight`).
fn tone_protection_weight(
    lab: &[f64],
    base: f64,
    shadow_strength: f64,
    highlight_strength: f64,
    protect_brand_color: bool,
) -> Vec<f64> {
    (0..lab.len() / 3)
        .map(|i| {
            let ln = lab[i * 3] / 255.0;
            let shadow = ((0.45 - ln) / 0.45).clamp(0.0, 1.0);
            let highlight = ((ln - 0.55) / 0.45).clamp(0.0, 1.0);
            let mut weight =
                base * (1.0 + shadow_strength * shadow + highlight_strength * highlight);
            if protect_brand_color {
                let chroma = (lab[i * 3 + 1] - 128.0).hypot(lab[i * 3 + 2] - 128.0);
                weight *= 1.0 - (chroma / CHROMA_NORM).clamp(0.0, 1.0);
            }
            weight.clamp(0.0, 1.0)
        })
        .collect()
}

struct TransferStats {
    src_mean: [f64; 3],
    dst_mean: [f64; 3],
    src_std: [f64; 3],
    dst_std: [f64; 3],
}

/// Reinhard mean/std transfer in Lab toward the background statistics
/// (mirrors `_apply_color_transfer`); ratios are clamped so a near-flat
/// subject channel cannot blow the transfer up.
fn color_transfer(
    subj_lab: &[f64],
    bg_lab: &[f64],
    region: &[f64],
    bg_region: &[f64],
    protect_saturation: bool,
) -> (Vec<f64>, TransferStats) {
    let (src_mean, src_std) = region_stats::<3>(subj_lab, region);
    let (dst_mean, dst_std) = region_stats::<3>(bg_lab, bg_region);
    let mut ratio = [0f64; 3];
    for c in 0..3 {
        ratio[c] = (dst_std[c] / (src_std[c] + EPS)).clamp(RATIO_MIN, RATIO_MAX);
    }
    let transferred: Vec<f64> = subj_lab
        .iter()
        .enumerate()
        .map(|(idx, &v)| {
            let c = idx % 3;
            if protect_saturation && c > 0 {
                // Match luminance only; keep the subject's own a/b (chroma).
                v
            } else {
                (v - src_mean[c]) * ratio[c] + dst_mean[c]
            }
        })
        .collect();
    let stats = TransferStats {
        src_mean: src_mean.map(round2),
        dst_mean: dst_mean.map(round2),
        src_std: src_std.map(round2),
        dst_std: dst_std.map(round2),
    };
    (transferred, stats)
}

/// Map `channel` values so their CDF matches `reference` (mirrors
/// `_histogram_match`: `np.interp` of the source CDF over the reference CDF).
fn histogram_match(channel: &[i64], reference: &[i64]) -> Vec<f64> {
    if channel.is_empty() || reference.is_empty() {
        return channel.iter().map(|&v| v as f64).collect();
    }
    let mut src_sorted: Vec<i64> = channel.to_vec();
    src_sorted.sort_unstable();
    src_sorted.dedup();
    let mut src_counts = vec![0u64; src_sorted.len()];
    for &v in channel {
        let idx = src_sorted.binary_search(&v).expect("value present");
        src_counts[idx] += 1;
    }
    let mut ref_sorted: Vec<i64> = reference.to_vec();
    ref_sorted.sort_unstable();
    ref_sorted.dedup();
    let mut ref_counts = vec![0u64; ref_sorted.len()];
    for &v in reference {
        let idx = ref_sorted.binary_search(&v).expect("value present");
        ref_counts[idx] += 1;
    }
    let src_total = channel.len() as f64;
    let ref_total = reference.len() as f64;
    let mut src_cdf = Vec::with_capacity(src_sorted.len());
    let mut acc = 0u64;
    for &c in &src_counts {
        acc += c;
        src_cdf.push(acc as f64 / src_total);
    }
    let mut ref_cdf = Vec::with_capacity(ref_sorted.len());
    acc = 0;
    for &c in &ref_counts {
        acc += c;
        ref_cdf.push(acc as f64 / ref_total);
    }
    // mapped[unique] = interp(src_cdf, ref_cdf, ref_vals)
    let mapped: Vec<f64> = src_cdf
        .iter()
        .map(
            |&q| match ref_cdf.binary_search_by(|probe| probe.partial_cmp(&q).expect("finite")) {
                Ok(idx) => ref_sorted[idx] as f64,
                Err(0) => ref_sorted[0] as f64,
                Err(idx) if idx >= ref_cdf.len() => ref_sorted[ref_sorted.len() - 1] as f64,
                Err(idx) => {
                    let (q0, q1) = (ref_cdf[idx - 1], ref_cdf[idx]);
                    let (v0, v1) = (ref_sorted[idx - 1] as f64, ref_sorted[idx] as f64);
                    if (q1 - q0).abs() < f64::EPSILON {
                        v1
                    } else {
                        v0 + (v1 - v0) * (q - q0) / (q1 - q0)
                    }
                }
            },
        )
        .collect();
    channel
        .iter()
        .map(|&v| {
            let idx = src_sorted.binary_search(&v).expect("value present");
            mapped[idx]
        })
        .collect()
}

/// Per-pixel lerp of two interleaved 3-channel planes by a per-pixel weight
/// (mirrors `_blend`).
fn blend(original: &[f64], corrected: &[f64], weight: &[f64]) -> Vec<f64> {
    original
        .iter()
        .enumerate()
        .map(|(idx, &o)| {
            let w = weight[idx / 3];
            o * (1.0 - w) + corrected[idx] * w
        })
        .collect()
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

// D65 reference white, matching the sRGB primaries used for the XYZ matrix.
const WHITE: [f64; 3] = [0.950_47, 1.0, 1.088_83];

fn lab_f(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    if t > DELTA * DELTA * DELTA {
        t.cbrt()
    } else {
        t / (3.0 * DELTA * DELTA) + 4.0 / 29.0
    }
}

fn lab_f_inv(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    if t > DELTA {
        t * t * t
    } else {
        3.0 * DELTA * DELTA * (t - 4.0 / 29.0)
    }
}

/// Interleaved RGB 0..255 -> CIE Lab in Pillow's byte-scaled convention
/// (`L*` scaled to 0..255, `a`/`b` offset by 128).
fn rgb_to_lab(rgb: &[f64]) -> Vec<f64> {
    let mut lab = vec![0f64; rgb.len()];
    for i in 0..rgb.len() / 3 {
        let r = srgb_to_linear(rgb[i * 3] / 255.0);
        let g = srgb_to_linear(rgb[i * 3 + 1] / 255.0);
        let b = srgb_to_linear(rgb[i * 3 + 2] / 255.0);
        let x = 0.412_456_4 * r + 0.357_576_1 * g + 0.180_437_5 * b;
        let y = 0.212_672_9 * r + 0.715_152_2 * g + 0.072_175_0 * b;
        let z = 0.019_333_9 * r + 0.119_192_0 * g + 0.950_304_1 * b;
        let fx = lab_f(x / WHITE[0]);
        let fy = lab_f(y / WHITE[1]);
        let fz = lab_f(z / WHITE[2]);
        let l = 116.0 * fy - 16.0;
        let a = 500.0 * (fx - fy);
        let bb = 200.0 * (fy - fz);
        lab[i * 3] = (l * 255.0 / 100.0).clamp(0.0, 255.0);
        lab[i * 3 + 1] = (a + 128.0).clamp(0.0, 255.0);
        lab[i * 3 + 2] = (bb + 128.0).clamp(0.0, 255.0);
    }
    lab
}

/// Byte-scaled Lab -> interleaved RGB 0..255, clamping back into gamut
/// (mirrors `_lab_to_rgb`'s clamp-then-convert).
fn lab_to_rgb(lab: &[f64]) -> Vec<f64> {
    let mut rgb = vec![0f64; lab.len()];
    for i in 0..lab.len() / 3 {
        let l = lab[i * 3].clamp(0.0, 255.0) * 100.0 / 255.0;
        let a = lab[i * 3 + 1].clamp(0.0, 255.0) - 128.0;
        let b = lab[i * 3 + 2].clamp(0.0, 255.0) - 128.0;
        let fy = (l + 16.0) / 116.0;
        let fx = fy + a / 500.0;
        let fz = fy - b / 200.0;
        let x = WHITE[0] * lab_f_inv(fx);
        let y = WHITE[1] * lab_f_inv(fy);
        let z = WHITE[2] * lab_f_inv(fz);
        let r = 3.240_454_2 * x - 1.537_138_5 * y - 0.498_531_4 * z;
        let g = -0.969_266_0 * x + 1.876_010_8 * y + 0.041_556_0 * z;
        let bl = 0.055_643_4 * x - 0.204_025_9 * y + 1.057_225_2 * z;
        rgb[i * 3] = (linear_to_srgb(r.clamp(0.0, 1.0)) * 255.0).clamp(0.0, 255.0);
        rgb[i * 3 + 1] = (linear_to_srgb(g.clamp(0.0, 1.0)) * 255.0).clamp(0.0, 255.0);
        rgb[i * 3 + 2] = (linear_to_srgb(bl.clamp(0.0, 1.0)) * 255.0).clamp(0.0, 255.0);
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn params(image: &str, out_dir: &str) -> CpuColorMatchParams {
        CpuColorMatchParams {
            image_path: image.to_string(),
            background_path: None,
            mask_path: None,
            context: None,
            mode: None,
            strength: 0.6,
            shadow_strength: 0.0,
            highlight_strength: 0.0,
            protect_saturation: false,
            protect_brand_color: true,
            output_dir: out_dir.to_string(),
            output_name: None,
            engine_requested: "cpu".to_string(),
            device_requested: "auto".to_string(),
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hgripe_color_match_cpu_{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn save_solid(path: &Path, color: [u8; 4], size: u32) {
        RgbaImage::from_pixel(size, size, Rgba(color))
            .save(path)
            .unwrap();
    }

    /// Lab round-trips: converting to Lab and back must reproduce sRGB bytes.
    #[test]
    fn lab_round_trip_is_stable() {
        let rgb: Vec<f64> = vec![
            10.0, 20.0, 30.0, 200.0, 60.0, 40.0, 255.0, 255.0, 255.0, 0.0, 0.0, 0.0, 128.0, 128.0,
            128.0,
        ];
        let back = lab_to_rgb(&rgb_to_lab(&rgb));
        for (a, b) in rgb.iter().zip(&back) {
            assert!((a - b).abs() < 1.0, "{a} vs {b}");
        }
    }

    /// A cool (blue) subject matched toward a warm (red) background must move
    /// its mean colour toward the background and mark the report applied.
    #[test]
    fn color_transfer_moves_toward_background() {
        let dir = temp_dir("transfer");
        let subj = dir.join("subject.png");
        let bg = dir.join("background.png");
        // A blue-ish subject with some variance (not flat, so the ratio and
        // brand-colour guard have something to work with).
        let mut img = RgbaImage::new(32, 32);
        for (i, px) in img.pixels_mut().enumerate() {
            let v = (i % 32) as u8;
            px.0 = [40 + v, 60, 180, 255];
        }
        img.save(&subj).unwrap();
        save_solid(&bg, [200, 120, 60, 255], 32);

        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some(bg.to_string_lossy().to_string());
        p.protect_brand_color = false;
        let result = try_match(&p).unwrap().expect("cpu fast path");
        let report = &result.match_report;
        assert!(report.applied);
        assert_eq!(report.engine, "cpu");
        assert!(report.src_mean_lab.is_some());
        assert!(Path::new(&result.matched_image).is_file());
        // Red should rise / blue should fall toward the warm background.
        assert!(
            report.after.mean_color[0] > report.before.mean_color[0],
            "{report:?}"
        );
        assert!(
            report.after.mean_color[2] < report.before.mean_color[2],
            "{report:?}"
        );
        assert!(!result.prompt_suffix.is_empty());
    }

    /// prompt_only must not touch pixels but still write an output copy and
    /// synthesise a prompt suffix from the background.
    #[test]
    fn prompt_only_passes_through() {
        let dir = temp_dir("prompt");
        let subj = dir.join("subject.png");
        let bg = dir.join("background.png");
        save_solid(&subj, [10, 200, 50, 255], 16);
        save_solid(&bg, [250, 240, 230, 255], 16);

        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some(bg.to_string_lossy().to_string());
        p.mode = Some("prompt_only".to_string());
        let result = try_match(&p).unwrap().expect("cpu fast path");
        assert!(!result.match_report.applied);
        assert_eq!(result.match_report.before.mean_color, [10, 200, 50]);
        assert_eq!(result.match_report.after.mean_color, [10, 200, 50]);
        assert!(result.prompt_suffix.contains("color temperature"));
        let rgba = image::open(&result.matched_image).unwrap().to_rgba8();
        assert_eq!(rgba.get_pixel(0, 0).0, [10, 200, 50, 255]);
    }

    /// Without a background the subject passes through and the report says so.
    #[test]
    fn no_background_notes_passthrough() {
        let dir = temp_dir("nobg");
        let subj = dir.join("subject.png");
        save_solid(&subj, [90, 90, 90, 255], 8);
        let result = try_match(&params(subj.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("cpu fast path");
        assert!(!result.match_report.applied);
        assert!(result
            .match_report
            .note
            .as_deref()
            .unwrap()
            .contains("no background"));
        assert!(result.prompt_suffix.is_empty());
    }

    /// An upstream visual context's prompt_suffix is reused verbatim.
    #[test]
    fn context_prompt_suffix_wins() {
        let dir = temp_dir("context");
        let subj = dir.join("subject.png");
        save_solid(&subj, [90, 90, 90, 255], 8);
        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.context = Some(r#"{"prompt_suffix": "studio softbox, warm dusk"}"#.to_string());
        let result = try_match(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.prompt_suffix, "studio softbox, warm dusk");
    }

    /// protect_saturation keeps chroma: only luminance may move.
    #[test]
    fn protect_saturation_keeps_chroma() {
        let dir = temp_dir("protect");
        let subj = dir.join("subject.png");
        let bg = dir.join("background.png");
        let mut img = RgbaImage::new(16, 16);
        for (i, px) in img.pixels_mut().enumerate() {
            let v = (i % 16) as u8;
            px.0 = [200, 30 + v, 30, 255];
        }
        img.save(&subj).unwrap();
        save_solid(&bg, [40, 40, 200, 255], 16);

        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some(bg.to_string_lossy().to_string());
        p.protect_saturation = true;
        p.protect_brand_color = false;
        let result = try_match(&p).unwrap().expect("cpu fast path");
        let report = &result.match_report;
        assert!(report.applied);
        // The subject must stay red-dominant (chroma protected) even though
        // the background is blue.
        assert!(
            report.after.mean_color[0] > report.after.mean_color[2],
            "{report:?}"
        );
    }

    /// An unknown mode is a user error surfaced directly.
    #[test]
    fn unknown_mode_errors() {
        let dir = temp_dir("mode");
        let subj = dir.join("subject.png");
        save_solid(&subj, [1, 2, 3, 255], 4);
        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.mode = Some("psychedelic".to_string());
        let err = try_match(&p).unwrap_err();
        assert!(err.contains("unknown mode"), "{err}");
    }

    /// A missing background is the canonical FileNotFoundError, surfaced with
    /// the same message as the CLI.
    #[test]
    fn missing_background_errors() {
        let dir = temp_dir("missingbg");
        let subj = dir.join("subject.png");
        save_solid(&subj, [1, 2, 3, 255], 4);
        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some("definitely_not_here_zzx.png".to_string());
        let err = try_match(&p).unwrap_err();
        assert!(err.contains("background image not found"), "{err}");
    }

    /// A missing subject is a canonical input error, not an unsupported-codec
    /// fallback.
    #[test]
    fn missing_image_errors() {
        let dir = temp_dir("missing");
        let p = params("definitely_not_here_zzx.png", dir.to_str().unwrap());
        let error = try_match(&p).unwrap_err();
        assert!(error.contains("subject image not found"), "{error}");
    }

    #[test]
    fn retired_engine_returns_explicit_error() {
        let dir = temp_dir("unknown_engine");
        let subj = dir.join("subject.png");
        let bg = dir.join("background.png");
        save_solid(&subj, [40, 70, 180, 255], 16);
        save_solid(&bg, [200, 130, 60, 255], 16);
        let mut p = params(subj.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some(bg.to_string_lossy().to_string());
        p.engine_requested = "mystery_matcher".to_string();

        let err = try_match(&p).unwrap_err();
        assert!(err.contains("retired"), "{err}");
        assert!(err.contains("cpu"), "{err}");
    }

    /// Histogram matching maps a channel's CDF onto the reference exactly for
    /// a simple two-level distribution.
    #[test]
    fn histogram_match_maps_levels() {
        let channel = vec![0i64, 0, 100, 100];
        let reference = vec![50i64, 50, 200, 200];
        let mapped = histogram_match(&channel, &reference);
        assert_eq!(mapped, vec![50.0, 50.0, 200.0, 200.0]);
    }
}
