//! In-process CPU mask-edge refinement fast path: a native-Rust replica of
//! `edge_refine_cli.py`'s heuristic (`cpu` engine) pipeline, run inline in the
//! `refineMaskEdge` executor instead of spawning the Python bridge.
//!
//! It reproduces the CLI's algorithm step by step — Min/Max 3x3 morphology,
//! a numpy-style box-filter guided filter that snaps the matte to the
//! subject's own luminance edges, Gaussian feather, trimap unknown-band
//! protection, edge-band colour decontamination and target-background blend —
//! and emits an identical [`EdgeReport`] (same field names / semantics), so
//! the node's outputs and downstream consumers are unchanged.
//!
//! Loading goes through [`super::studio_image`], the shared hardened loader:
//! the decompression-bomb guard, EXIF normalisation and CMYK / high-bit /
//! wide-gamut colour management are the same ones every other native card
//! uses (the colour pipeline's canonical ingress), mirroring the Python CLI's
//! `_load_rgb_alpha`.
//!
//! The optional `onnx_matting` engine reuses the native ViTMatte/ORT backend
//! from Subject Mask. It only replaces the protected trimap band; morphology,
//! colour decontamination, output and reporting stay in this one Rust path.

use std::path::{Path, PathBuf};

use image::imageops::{self, FilterType};
use image::{GrayImage, Luma, RgbaImage};

use super::image_buffer;
use super::studio_image::{self, LoadMeta, DEFAULT_MAX_DECODE_PIXELS};
use super::subject_matte::AlphaMatter;
use crate::psd::{reject_unsafe_output_name, EdgeReport, RefineEdgeResult};

const EPS: f32 = 1e-6;

/// Resolved node parameters for one refine run, mirroring the CLI arguments.
pub(crate) struct CpuEdgeRefineParams {
    pub(crate) image_path: String,
    pub(crate) mask_path: Option<String>,
    pub(crate) background_path: Option<String>,
    pub(crate) trimap_path: Option<String>,
    pub(crate) preset: Option<String>,
    pub(crate) erode_px: i64,
    pub(crate) dilate_px: i64,
    pub(crate) feather_px: f64,
    pub(crate) guided_radius: i64,
    pub(crate) edge_decontaminate: bool,
    pub(crate) background_blend_strength: f64,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) engine_requested: String,
    pub(crate) device_requested: String,
}

/// Resolved (erode, dilate, feather, guided radius, decontaminate, blend) for
/// a preset, matching `_PRESETS` in `edge_refine_cli.py`.
struct Resolved {
    erode_px: i64,
    dilate_px: i64,
    feather_px: f64,
    guided_radius: i64,
    decontaminate: bool,
    blend_strength: f64,
}

fn resolve_preset(p: &CpuEdgeRefineParams) -> Result<(String, Resolved), String> {
    let preset = p
        .preset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("natural")
        .to_string();
    let resolved = match preset.as_str() {
        "clean" => Resolved {
            erode_px: 1,
            dilate_px: 0,
            feather_px: 2.0,
            guided_radius: 4,
            decontaminate: true,
            blend_strength: 0.5,
        },
        "natural" => Resolved {
            erode_px: 1,
            dilate_px: 0,
            feather_px: 6.0,
            guided_radius: 8,
            decontaminate: true,
            blend_strength: 0.4,
        },
        "soft" => Resolved {
            erode_px: 0,
            dilate_px: 0,
            feather_px: 12.0,
            guided_radius: 12,
            decontaminate: false,
            blend_strength: 0.3,
        },
        "custom" => Resolved {
            erode_px: p.erode_px.max(0),
            dilate_px: p.dilate_px.max(0),
            feather_px: p.feather_px.max(0.0),
            guided_radius: p.guided_radius.max(0),
            decontaminate: p.edge_decontaminate,
            blend_strength: p.background_blend_strength.clamp(0.0, 1.0),
        },
        other => {
            return Err(format!(
                "unknown preset {other:?}; expected one of [\"clean\", \"custom\", \"natural\", \"soft\"]"
            ))
        }
    };
    Ok((preset, resolved))
}

/// Run the CPU refine pipeline in-process. Returns `Ok(Some(result))` on the
/// fast path, or `Ok(None)` when the source (or an auxiliary mask/trimap)
/// cannot be decoded by the native loader. The caller maps that to the card's
/// stable unsupported-source error.
pub(crate) fn try_refine(p: &CpuEdgeRefineParams) -> Result<Option<RefineEdgeResult>, String> {
    let path = Path::new(&p.image_path);
    if !path.is_file() {
        return Ok(None);
    }
    let (preset, r) = resolve_preset(p)?;
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;

    let loaded = match studio_image::load_rgba(path, DEFAULT_MAX_DECODE_PIXELS) {
        Ok(loaded) => loaded,
        Err(_) => return Ok(None),
    };
    let (width, height) = loaded.image.dimensions();
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let (w, h) = (width as usize, height as usize);
    let n = w * h;

    // Split the decoded surface into an RGB plane and a 0..1 alpha plane, the
    // working shape of the whole pipeline (mirrors `_load_rgb_alpha`).
    let mut rgb = vec![0f32; n * 3];
    let mut alpha = vec![0f32; n];
    for (i, px) in loaded.image.pixels().enumerate() {
        rgb[i * 3] = f32::from(px.0[0]);
        rgb[i * 3 + 1] = f32::from(px.0[1]);
        rgb[i * 3 + 2] = f32::from(px.0[2]);
        alpha[i] = f32::from(px.0[3]) / 255.0;
    }

    // Prefer an explicit matte; otherwise refine the subject's own alpha.
    let explicit = match load_gray_plane(p.mask_path.as_deref(), width, height, false) {
        Ok(mask) => mask,
        Err(_) => return Ok(None),
    };
    let source_mask = if explicit.is_some() {
        "explicit"
    } else {
        "alpha"
    };
    let mask = explicit.unwrap_or(alpha);

    // Optional target background for edge colour blending.
    let background_rgb = match p.background_path.as_deref().map(str::trim) {
        Some(bg) if !bg.is_empty() => {
            if !Path::new(bg).is_file() {
                return Err(format!("background image not found: {bg}"));
            }
            let bg_loaded = match studio_image::load_rgba(Path::new(bg), DEFAULT_MAX_DECODE_PIXELS)
            {
                Ok(loaded) => loaded,
                Err(_) => return Ok(None),
            };
            let resized = if bg_loaded.image.dimensions() != (width, height) {
                imageops::resize(&bg_loaded.image, width, height, FilterType::Triangle)
            } else {
                bg_loaded.image
            };
            let mut plane = vec![0f32; n * 3];
            for (i, px) in resized.pixels().enumerate() {
                plane[i * 3] = f32::from(px.0[0]);
                plane[i * 3 + 1] = f32::from(px.0[1]);
                plane[i * 3 + 2] = f32::from(px.0[2]);
            }
            Some(plane)
        }
        _ => None,
    };

    // An upstream matting trimap (FG=255 / unknown=128 / BG=0) marks where the
    // matte is genuine continuous alpha, not a fringe to bite off. Loaded
    // nearest so the three levels survive any resize.
    let trimap = match load_gray_plane(p.trimap_path.as_deref(), width, height, true) {
        Ok(trimap) => trimap,
        Err(_) => return Ok(None),
    };
    let protect = trimap
        .as_ref()
        .map(|trimap| protected_band_weights(trimap, w, h));

    let engine_requested = {
        let engine = p.engine_requested.trim().to_ascii_lowercase();
        if engine.is_empty() {
            "cpu".to_string()
        } else {
            engine
        }
    };
    let device_request =
        super::onnx_pool::OnnxDeviceRequest::from_param(p.device_requested.as_str());
    let device_requested = device_request.as_str().to_string();
    let mut engine = "cpu".to_string();
    let mut engine_fallback_reason = None;
    let mut backend_model = None;
    let mut device = None;
    let mut band_source = mask.clone();

    match engine_requested.as_str() {
        "cpu" => {}
        "onnx_matting" => match trimap.as_ref() {
            None => {
                engine_fallback_reason =
                    Some("no trimap reference (learned matting needs an unknown band)".to_string());
            }
            Some(trimap) if !trimap.iter().any(|&value| value > 0.25 && value < 0.75) => {
                engine_fallback_reason =
                    Some("trimap has no unknown band for learned matting".to_string());
            }
            Some(trimap) => match super::subject_matte::load_vitmatte(device_request) {
                Ok(matter) => match learned_band_source(
                    &matter,
                    &loaded.image,
                    &gray_from_plane(trimap, width, height),
                ) {
                    Ok(alpha) => {
                        band_source = alpha;
                        engine = "onnx_matting".to_string();
                        backend_model = matter
                            .model_path()
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string());
                        let resolution = matter.onnx_resolution();
                        device = Some(resolution.device.to_string());
                        engine_fallback_reason = resolution.fallback_reason.clone();
                    }
                    Err(err) => {
                        engine_fallback_reason = Some(err);
                    }
                },
                Err(err) => {
                    engine_fallback_reason = Some(err);
                }
            },
        },
        other => {
            engine_fallback_reason = Some(format!("unknown engine {other:?}"));
        }
    }

    let coverage_before = coverage(&mask);

    // 1) Morphology: bite the fringe in (erode), optionally grow back (dilate).
    let mut refined = morphology(&mask, w, h, r.erode_px, r.dilate_px);
    // 2) Guided filter: snap the matte to the subject's own luminance edges.
    if r.guided_radius > 0 {
        let guide: Vec<f32> = (0..n)
            .map(|i| (rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114) / 255.0)
            .collect();
        refined = guided_filter(&guide, &refined, w, h, r.guided_radius as usize, 1e-3);
    }
    // 3) Feather: soft transition so the composite has no stair-stepping.
    if r.feather_px > 0.0 {
        refined = feather(&refined, w, h, r.feather_px as f32);
    }
    for v in &mut refined {
        *v = v.clamp(0.0, 1.0);
    }

    // 4) Trimap protection: inside the unknown band keep the upstream soft
    // alpha instead of the eroded/feathered edge, so fine hair detail is
    // refined as continuous alpha rather than flattened to an edge.
    let mut protected_band_px = 0i64;
    if let Some(protect) = &protect {
        merge_protected_band(&mut refined, &band_source, protect);
        protected_band_px = protect.iter().filter(|&&v| v > 0.05).count() as i64;
    }

    // The edge band: pixels that are neither solidly in nor solidly out — this
    // is where fringe lives and where decontamination / background blend act.
    let band: Vec<f32> = refined.iter().map(|&v| v.min(1.0 - v) * 2.0).collect();

    let mut out_rgb = rgb;
    if r.decontaminate {
        let opaque: Vec<f32> = refined
            .iter()
            .map(|&v| if v > 0.9 { 1.0 } else { 0.0 })
            .collect();
        if opaque.iter().sum::<f32>() > EPS {
            decontaminate(&mut out_rgb, &opaque, &band, w, h);
        }
    }
    if let Some(bg) = &background_rgb {
        if r.blend_strength > 0.0 {
            // Replace lingering old-background colour in the band with the
            // target background's colour, so the seam matches once composited.
            for i in 0..n {
                let weight = band[i] * r.blend_strength as f32;
                for c in 0..3 {
                    out_rgb[i * 3 + c] =
                        out_rgb[i * 3 + c] * (1.0 - weight) + bg[i * 3 + c] * weight;
                }
            }
        }
    }

    // Write the refined RGBA + matte PNGs and publish them to the in-process
    // buffer cache so a downstream native card re-reads them without a decode.
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
        .unwrap_or_else(|| format!("{}_refined", safe_stem(&p.image_path)));

    let refined_u8: Vec<u8> = refined
        .iter()
        .map(|&v| (v * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();
    let mut rgba_out = RgbaImage::new(width, height);
    for (i, px) in rgba_out.pixels_mut().enumerate() {
        px.0 = [
            out_rgb[i * 3].round().clamp(0.0, 255.0) as u8,
            out_rgb[i * 3 + 1].round().clamp(0.0, 255.0) as u8,
            out_rgb[i * 3 + 2].round().clamp(0.0, 255.0) as u8,
            refined_u8[i],
        ];
    }
    let mask_out_img = GrayImage::from_raw(width, height, refined_u8)
        .ok_or_else(|| "refined mask buffer did not match dimensions".to_string())?;

    let image_out = directory.join(format!("{stem}.png"));
    let mask_out = directory.join(format!("{stem}_mask.png"));
    rgba_out
        .save(&image_out)
        .map_err(|err| format!("failed to write {}: {err}", image_out.display()))?;
    mask_out_img
        .save(&mask_out)
        .map_err(|err| format!("failed to write {}: {err}", mask_out.display()))?;
    image_buffer::publish_rgba(
        &image_out,
        &rgba_out,
        LoadMeta {
            source_mode: "RGBA".to_string(),
            exif_transposed: false,
        },
    );
    image_buffer::publish_gray(&mask_out, &mask_out_img);

    // Surface the "nothing to refine" case, like the CLI.
    let edge_band_px = band.iter().filter(|&&v| v > 0.05).count() as i64;
    let note = (edge_band_px == 0).then(|| {
        "no transitional edge found (matte is fully opaque or empty); refinement was a no-op"
            .to_string()
    });

    let edge_report = EdgeReport {
        preset,
        source_mask: source_mask.to_string(),
        source_mode: loaded.meta.source_mode.clone(),
        exif_transposed: loaded.meta.exif_transposed,
        max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS as i64,
        erode_px: r.erode_px,
        dilate_px: r.dilate_px,
        feather_px: (r.feather_px * 100.0).round() / 100.0,
        guided_radius: r.guided_radius,
        edge_decontaminate: r.decontaminate,
        background_blend_strength: (r.blend_strength * 10_000.0).round() / 10_000.0,
        background_applied: background_rgb.is_some() && r.blend_strength > 0.0,
        trimap_applied: protect.is_some(),
        protected_band_px,
        edge_band_px,
        coverage_before,
        coverage_after: coverage(&refined),
        output_size: Some([i64::from(width), i64::from(height)]),
        engine,
        engine_requested,
        engine_fallback_reason,
        backend_model,
        device,
        device_requested,
        note,
    };

    Ok(Some(RefineEdgeResult {
        refined_image: image_out.to_string_lossy().to_string(),
        refined_mask: mask_out.to_string_lossy().to_string(),
        edge_report,
    }))
}

fn gray_from_plane(plane: &[f32], width: u32, height: u32) -> GrayImage {
    GrayImage::from_raw(width, height, to_u8_plane(plane))
        .expect("trimap plane matches image dimensions")
}

fn learned_band_source(
    matter: &dyn AlphaMatter,
    image: &RgbaImage,
    trimap: &GrayImage,
) -> Result<Vec<f32>, String> {
    let alpha = matter.matte(image, trimap)?;
    if alpha.dimensions() != image.dimensions() {
        return Err(format!(
            "learned matte dimensions {:?} do not match source {:?}",
            alpha.dimensions(),
            image.dimensions()
        ));
    }
    Ok(alpha
        .pixels()
        .map(|pixel| f32::from(pixel.0[0]) / 255.0)
        .collect())
}

fn merge_protected_band(refined: &mut [f32], band_source: &[f32], protect: &[f32]) {
    debug_assert_eq!(refined.len(), band_source.len());
    debug_assert_eq!(refined.len(), protect.len());
    for ((value, source), weight) in refined.iter_mut().zip(band_source).zip(protect) {
        *value = (*value * (1.0 - *weight) + *source * *weight).clamp(0.0, 1.0);
    }
}

fn protected_band_weights(trimap: &[f32], width: usize, height: usize) -> Vec<f32> {
    let unknown: Vec<f32> = trimap
        .iter()
        .map(|&value| {
            if value > 0.25 && value < 0.75 {
                1.0
            } else {
                0.0
            }
        })
        .collect();
    if unknown.iter().sum::<f32>() <= EPS {
        return unknown;
    }

    let mut weights = feather(&unknown, width, height, 1.5);
    for (weight, gate) in weights.iter_mut().zip(&unknown) {
        *weight *= *gate;
    }
    weights
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

/// Load an optional matte/trimap as a 0..1 plane matched to `width x height`.
/// `nearest` keeps a trimap's discrete FG / unknown / BG levels intact on
/// resize; a continuous matte uses bilinear.
fn load_gray_plane(
    path: Option<&str>,
    width: u32,
    height: u32,
    nearest: bool,
) -> Result<Option<Vec<f32>>, String> {
    let Some(path) = path.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let mask = studio_image::load_mask(Path::new(path), DEFAULT_MAX_DECODE_PIXELS)?;
    let mask = if mask.dimensions() != (width, height) {
        let filter = if nearest {
            FilterType::Nearest
        } else {
            FilterType::Triangle
        };
        imageops::resize(&mask, width, height, filter)
    } else {
        mask
    };
    Ok(Some(
        mask.pixels().map(|px| f32::from(px.0[0]) / 255.0).collect(),
    ))
}

/// Mean matte coverage 0..1, rounded to 4 decimals like the CLI's `_coverage`.
fn coverage(mask: &[f32]) -> f64 {
    if mask.is_empty() {
        return 0.0;
    }
    let mean = mask
        .iter()
        .map(|&v| f64::from(v.clamp(0.0, 1.0)))
        .sum::<f64>()
        / (mask.len() as f64);
    (mean * 10_000.0).round() / 10_000.0
}

/// Quantise a 0..1 plane to 8-bit, mirroring the CLI's Pillow round-trips.
fn to_u8_plane(mask: &[f32]) -> Vec<u8> {
    mask.iter()
        .map(|&v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

/// Erode then dilate a 0..1 matte by N pixels of 3x3 min/max passes (the
/// CLI's Pillow `MinFilter(3)` / `MaxFilter(3)`, which replicate edges).
fn morphology(mask: &[f32], w: usize, h: usize, erode_px: i64, dilate_px: i64) -> Vec<f32> {
    let mut plane = to_u8_plane(mask);
    for _ in 0..erode_px.max(0) {
        plane = filter3x3(&plane, w, h, true);
    }
    for _ in 0..dilate_px.max(0) {
        plane = filter3x3(&plane, w, h, false);
    }
    plane.iter().map(|&v| f32::from(v) / 255.0).collect()
}

/// One 3x3 min (`min = true`) or max filter pass with replicated edges.
fn filter3x3(src: &[u8], w: usize, h: usize, min: bool) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut best = if min { u8::MAX } else { u8::MIN };
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let sy = (y as i64 + dy).clamp(0, h as i64 - 1) as usize;
                    let sx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
                    let v = src[sy * w + sx];
                    best = if min { best.min(v) } else { best.max(v) };
                }
            }
            out[y * w + x] = best;
        }
    }
    out
}

/// Soften a 0..1 plane with a Gaussian falloff (the CLI's Pillow
/// `GaussianBlur(radius)`), round-tripping through 8-bit like the CLI does.
fn feather(mask: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    if radius <= 0.0 {
        return mask.to_vec();
    }
    let plane = to_u8_plane(mask);
    let image =
        GrayImage::from_raw(w as u32, h as u32, plane).expect("plane length matches dimensions");
    let blurred = imageops::blur(&image, radius);
    blurred
        .pixels()
        .map(|Luma([v])| f32::from(*v) / 255.0)
        .collect()
}

/// Mean over a (2r+1) square with replicated edges via an integral image —
/// the box filter the guided filter and decontamination are built on
/// (mirrors the CLI's `_box_filter`).
fn box_mean(values: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 {
        return values.to_vec();
    }
    let pw = w + 2 * radius;
    let ph = h + 2 * radius;
    // integral[(y+1)][(x+1)] = sum of the padded plane over [0..=y][0..=x].
    let stride = pw + 1;
    let mut integral = vec![0f64; stride * (ph + 1)];
    for y in 0..ph {
        let sy = (y as i64 - radius as i64).clamp(0, h as i64 - 1) as usize;
        let mut row = 0f64;
        for x in 0..pw {
            let sx = (x as i64 - radius as i64).clamp(0, w as i64 - 1) as usize;
            row += f64::from(values[sy * w + sx]);
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
        }
    }
    let size = 2 * radius + 1;
    let area = (size * size) as f64;
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (y1, x1) = (y + size, x + size);
            let sum =
                integral[y1 * stride + x1] - integral[y * stride + x1] - integral[y1 * stride + x]
                    + integral[y * stride + x];
            out[y * w + x] = (sum / area) as f32;
        }
    }
    out
}

/// He et al.'s guided filter on a single 0..1 channel: edge-aware smoothing of
/// `src` following `guide`'s edges, so the refined matte hugs real contours
/// instead of being uniformly blurred (mirrors the CLI's `_guided_filter`).
fn guided_filter(
    guide: &[f32],
    src: &[f32],
    w: usize,
    h: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    if radius == 0 {
        return src.to_vec();
    }
    let n = w * h;
    let mean_i = box_mean(guide, w, h, radius);
    let mean_p = box_mean(src, w, h, radius);
    let ii: Vec<f32> = (0..n).map(|i| guide[i] * guide[i]).collect();
    let ip: Vec<f32> = (0..n).map(|i| guide[i] * src[i]).collect();
    let corr_i = box_mean(&ii, w, h, radius);
    let corr_ip = box_mean(&ip, w, h, radius);
    let mut a = vec![0f32; n];
    let mut b = vec![0f32; n];
    for i in 0..n {
        let var_i = corr_i[i] - mean_i[i] * mean_i[i];
        let cov_ip = corr_ip[i] - mean_i[i] * mean_p[i];
        a[i] = cov_ip / (var_i + eps);
        b[i] = mean_p[i] - a[i] * mean_i[i];
    }
    let mean_a = box_mean(&a, w, h, radius);
    let mean_b = box_mean(&b, w, h, radius);
    (0..n)
        .map(|i| (mean_a[i] * guide[i] + mean_b[i]).clamp(0.0, 1.0))
        .collect()
}

/// Pull opaque subject colour into the edge band to kill residual fringe: blur
/// the confidently-opaque pixels' colour, bleed it outward, and replace the
/// band's RGB with that estimate weighted by how transitional each pixel is
/// (mirrors the CLI's `_decontaminate`, box radius 6).
fn decontaminate(rgb: &mut [f32], opaque: &[f32], band: &[f32], w: usize, h: usize) {
    let n = w * h;
    let norm = box_mean(opaque, w, h, 6);
    for c in 0..3 {
        let weighted: Vec<f32> = (0..n).map(|i| rgb[i * 3 + c] * opaque[i]).collect();
        let blurred = box_mean(&weighted, w, h, 6);
        for i in 0..n {
            let foreground = blurred[i] / (norm[i] + EPS);
            rgb[i * 3 + c] = rgb[i * 3 + c] * (1.0 - band[i]) + foreground * band[i];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    struct ConstantMatter(u8);

    impl AlphaMatter for ConstantMatter {
        fn provider(&self) -> &str {
            "test-matter"
        }

        fn matte(&self, image: &RgbaImage, _trimap: &GrayImage) -> Result<GrayImage, String> {
            Ok(GrayImage::from_pixel(
                image.width(),
                image.height(),
                Luma([self.0]),
            ))
        }
    }

    fn params(image: &str, out_dir: &str) -> CpuEdgeRefineParams {
        CpuEdgeRefineParams {
            image_path: image.to_string(),
            mask_path: None,
            background_path: None,
            trimap_path: None,
            preset: None,
            erode_px: 1,
            dilate_px: 0,
            feather_px: 4.0,
            guided_radius: 8,
            edge_decontaminate: true,
            background_blend_strength: 0.4,
            output_dir: out_dir.to_string(),
            output_name: None,
            engine_requested: "cpu".to_string(),
            device_requested: "auto".to_string(),
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hgripe_edge_refine_cpu_{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A square subject with a hard alpha edge: the pass must produce both
    /// PNGs, soften the edge (a non-empty transitional band) and report the
    /// heuristic engine with the resolved `natural` preset.
    #[test]
    fn refines_a_hard_alpha_edge() {
        let dir = temp_dir("basic");
        let src = dir.join("subject.png");
        let mut img = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 0]));
        for y in 16..48 {
            for x in 16..48 {
                img.put_pixel(x, y, Rgba([200, 60, 40, 255]));
            }
        }
        img.save(&src).unwrap();

        let result = try_refine(&params(src.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("cpu fast path");
        assert!(Path::new(&result.refined_image).is_file());
        assert!(Path::new(&result.refined_mask).is_file());
        let report = &result.edge_report;
        assert_eq!(report.preset, "natural");
        assert_eq!(report.engine, "cpu");
        assert_eq!(report.source_mask, "alpha");
        assert_eq!(report.output_size, Some([64, 64]));
        assert!(report.edge_band_px > 0, "{report:?}");
        assert!(report.coverage_before > 0.0);
        assert!(report.coverage_after > 0.0);
        assert!(report.note.is_none());

        // The refined image's alpha must equal the refined mask exactly.
        let rgba = image::open(&result.refined_image).unwrap().to_rgba8();
        let mask = image::open(&result.refined_mask).unwrap().to_luma8();
        for (px, m) in rgba.pixels().zip(mask.pixels()) {
            assert_eq!(px.0[3], m.0[0]);
        }
    }

    /// A fully opaque image with no matte has no edge to refine: the pass is a
    /// no-op and says so in the report note.
    #[test]
    fn opaque_image_reports_noop_note() {
        let dir = temp_dir("noop");
        let src = dir.join("opaque.png");
        RgbaImage::from_pixel(24, 24, Rgba([120, 120, 120, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        // `soft` skips erode/decontaminate so the matte stays solid.
        p.preset = Some("soft".to_string());
        let result = try_refine(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.edge_report.edge_band_px, 0);
        assert!(
            result.edge_report.note.is_some(),
            "{:?}",
            result.edge_report
        );
    }

    /// An explicit matte wins over the image's own alpha and is recorded as
    /// the mask source.
    #[test]
    fn explicit_mask_is_preferred() {
        let dir = temp_dir("mask");
        let src = dir.join("subject.png");
        RgbaImage::from_pixel(32, 32, Rgba([80, 160, 240, 255]))
            .save(&src)
            .unwrap();
        let mask_path = dir.join("matte.png");
        let mut mask = GrayImage::from_pixel(32, 32, Luma([0]));
        for y in 8..24 {
            for x in 8..24 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        mask.save(&mask_path).unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.mask_path = Some(mask_path.to_string_lossy().to_string());
        let result = try_refine(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.edge_report.source_mask, "explicit");
        assert!(result.edge_report.edge_band_px > 0);
    }

    /// A trimap's unknown band protects the matte from erode/feather: the
    /// protected pixels keep the source alpha and the report records the band.
    #[test]
    fn trimap_protects_the_unknown_band() {
        let dir = temp_dir("trimap");
        let src = dir.join("subject.png");
        let mut img = RgbaImage::from_pixel(48, 48, Rgba([0, 0, 0, 0]));
        for y in 8..40 {
            for x in 8..40 {
                img.put_pixel(x, y, Rgba([90, 200, 90, 255]));
            }
        }
        img.save(&src).unwrap();
        let trimap_path = dir.join("trimap.png");
        let mut trimap = GrayImage::from_pixel(48, 48, Luma([0]));
        for y in 8..40 {
            for x in 8..40 {
                trimap.put_pixel(x, y, Luma([255]));
            }
        }
        // Mark the right edge column band as unknown.
        for y in 8..40 {
            for x in 36..44 {
                trimap.put_pixel(x, y, Luma([128]));
            }
        }
        trimap.save(&trimap_path).unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.trimap_path = Some(trimap_path.to_string_lossy().to_string());
        let result = try_refine(&p).unwrap().expect("cpu fast path");
        assert!(result.edge_report.trimap_applied);
        assert!(
            result.edge_report.protected_band_px > 0,
            "{:?}",
            result.edge_report
        );
    }

    #[test]
    fn learned_matte_only_replaces_the_protected_band() {
        let image = RgbaImage::from_pixel(3, 1, Rgba([120, 120, 120, 255]));
        let trimap = GrayImage::from_raw(3, 1, vec![0, 128, 255]).unwrap();
        let learned = learned_band_source(&ConstantMatter(64), &image, &trimap).unwrap();
        let mut refined = vec![0.0, 0.5, 1.0];
        merge_protected_band(&mut refined, &learned, &[0.0, 1.0, 0.0]);

        assert_eq!(refined[0], 0.0, "definite background must stay unchanged");
        assert!((refined[1] - 64.0 / 255.0).abs() < 1e-6);
        assert_eq!(refined[2], 1.0, "definite foreground must stay unchanged");
    }

    #[test]
    fn protected_band_feather_never_leaks_into_definite_trimap_regions() {
        let weights = protected_band_weights(&[0.0, 0.5, 1.0], 3, 1);
        assert_eq!(weights[0], 0.0);
        assert!(weights[1] > 0.0 && weights[1] <= 1.0);
        assert_eq!(weights[2], 0.0);
    }

    #[test]
    fn learned_engine_without_trimap_falls_back_and_reports_reason() {
        let dir = temp_dir("learned_without_trimap");
        let src = dir.join("subject.png");
        let mut image = RgbaImage::from_pixel(24, 24, Rgba([0, 0, 0, 0]));
        for y in 6..18 {
            for x in 6..18 {
                image.put_pixel(x, y, Rgba([200, 80, 40, 255]));
            }
        }
        image.save(&src).unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.engine_requested = "onnx_matting".to_string();
        let result = try_refine(&p).unwrap().expect("CPU fallback");
        assert_eq!(result.edge_report.engine, "cpu");
        assert_eq!(result.edge_report.engine_requested, "onnx_matting");
        assert!(result
            .edge_report
            .engine_fallback_reason
            .as_deref()
            .unwrap_or_default()
            .contains("trimap"));
        assert!(result.edge_report.backend_model.is_none());
        assert!(result.edge_report.device.is_none());
    }

    #[test]
    fn unknown_engine_falls_back_without_losing_outputs() {
        let dir = temp_dir("unknown_engine");
        let src = dir.join("subject.png");
        RgbaImage::from_pixel(16, 16, Rgba([100, 120, 140, 200]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.engine_requested = "removed_backend".to_string();
        let result = try_refine(&p).unwrap().expect("CPU fallback");
        assert!(Path::new(&result.refined_image).is_file());
        assert!(Path::new(&result.refined_mask).is_file());
        assert_eq!(result.edge_report.engine, "cpu");
        assert_eq!(result.edge_report.engine_requested, "removed_backend");
        assert!(result
            .edge_report
            .engine_fallback_reason
            .as_deref()
            .unwrap_or_default()
            .contains("unknown engine"));
    }

    #[test]
    fn onnx_matting_runs_when_weight_present() {
        let Some(model_path) = super::super::resolve_vitmatte_model_path() else {
            eprintln!("skipping Refine ViTMatte e2e: no weight resolvable");
            return;
        };
        let expected_model = model_path
            .file_name()
            .expect("resolved ViTMatte path has a file name")
            .to_string_lossy()
            .into_owned();

        let dir = temp_dir("onnx_matting_e2e");
        let src = dir.join("subject.png");
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([110, 110, 110, 255]));
        for y in 20..44 {
            for x in 20..44 {
                image.put_pixel(x, y, Rgba([230, 40, 40, 255]));
            }
        }
        image.save(&src).unwrap();

        let trimap_path = dir.join("trimap.png");
        let mut trimap = GrayImage::from_pixel(64, 64, Luma([0]));
        for y in 16..48 {
            for x in 16..48 {
                trimap.put_pixel(x, y, Luma([128]));
            }
        }
        for y in 26..38 {
            for x in 26..38 {
                trimap.put_pixel(x, y, Luma([255]));
            }
        }
        trimap.save(&trimap_path).unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.trimap_path = Some(trimap_path.to_string_lossy().to_string());
        p.engine_requested = "onnx_matting".to_string();
        p.device_requested = "cpu".to_string();
        let result = try_refine(&p).unwrap().expect("native ViTMatte refine");
        assert_eq!(result.edge_report.engine, "onnx_matting");
        assert_eq!(result.edge_report.engine_requested, "onnx_matting");
        assert_eq!(result.edge_report.device.as_deref(), Some("cpu"));
        assert!(result.edge_report.engine_fallback_reason.is_none());
        assert_eq!(
            result.edge_report.backend_model.as_deref(),
            Some(expected_model.as_str())
        );
        assert!(Path::new(&result.refined_image).is_file());
        assert!(Path::new(&result.refined_mask).is_file());

        p.device_requested = "gpu".to_string();
        p.output_name = Some("vitmatte_gpu_request".to_string());
        let gpu_request = try_refine(&p)
            .unwrap()
            .expect("CPU-provider ViTMatte refine");
        assert_eq!(gpu_request.edge_report.engine, "onnx_matting");
        assert_eq!(gpu_request.edge_report.device.as_deref(), Some("cpu"));
        assert!(gpu_request
            .edge_report
            .engine_fallback_reason
            .as_deref()
            .unwrap()
            .contains("GPU execution provider not built in"));
    }

    /// Background blending marks the report and shifts edge-band colour toward
    /// the target background.
    #[test]
    fn background_blend_is_applied_in_the_band() {
        let dir = temp_dir("background");
        let src = dir.join("subject.png");
        let mut img = RgbaImage::from_pixel(32, 32, Rgba([0, 0, 0, 0]));
        for y in 8..24 {
            for x in 8..24 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        img.save(&src).unwrap();
        let bg_path = dir.join("bg.png");
        RgbaImage::from_pixel(32, 32, Rgba([255, 0, 0, 255]))
            .save(&bg_path)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.background_path = Some(bg_path.to_string_lossy().to_string());
        let result = try_refine(&p).unwrap().expect("cpu fast path");
        assert!(result.edge_report.background_applied);
    }

    /// An unknown preset is a user error surfaced directly.
    #[test]
    fn unknown_preset_errors() {
        let dir = temp_dir("preset");
        let src = dir.join("subject.png");
        RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255]))
            .save(&src)
            .unwrap();
        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.preset = Some("fancy".to_string());
        let err = try_refine(&p).unwrap_err();
        assert!(err.contains("unknown preset"), "{err}");
    }

    /// A missing subject image returns `None` for the executor to map to its
    /// stable unsupported-source error.
    #[test]
    fn missing_image_returns_none() {
        let dir = temp_dir("missing");
        let p = params("definitely_not_here_zzx.png", dir.to_str().unwrap());
        assert!(try_refine(&p).unwrap().is_none());
    }
}
