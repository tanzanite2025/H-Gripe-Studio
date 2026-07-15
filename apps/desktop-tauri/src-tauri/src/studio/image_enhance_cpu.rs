//! Shared native Image Enhance pipeline. It owns source decoding, CMYK/ICC
//! ingress, target resolution, alpha, output metadata and the complete CPU
//! fallback. The opt-in `realesrgan` branch replaces only the colour-pixel
//! denoise/resample/sharpen stage through [`super::image_enhance_onnx`].
//!
//! The CPU algorithm is edge-preserving median denoise, Lanczos3 upscale or
//! triangle downscale, and unsharp-mask detail. Alpha stays on an independent
//! resize track. High-bit grey is peak-normalised; CMYK TIFF and CMYK-family
//! JPEG samples are colour-managed through the repository-owned colour path.

use std::borrow::Cow;
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::Path;
use std::time::Instant;

use image::imageops::{self, FilterType};
use image::{ExtendedColorType, GrayImage, ImageBuffer, Luma, Rgb, RgbImage, Rgba, RgbaImage};

use super::linear;
use super::studio_image::{self, DEFAULT_MAX_DECODE_PIXELS};
use crate::psd::{reject_unsafe_output_name, EnhanceImageResult, EnhanceReport};

/// Resolved node parameters for one native enhance run.
pub(crate) struct EnhanceParams {
    pub(crate) image_path: String,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) mode: Option<String>,
    pub(crate) target_bounds: Option<String>,
    pub(crate) target_width: i64,
    pub(crate) target_height: i64,
    pub(crate) target_dpi: i64,
    pub(crate) max_pixels: i64,
    pub(crate) scale: f64,
    pub(crate) denoise_strength: f64,
    pub(crate) texture_strength: f64,
    pub(crate) preserve_text_logo: bool,
    pub(crate) engine_requested: String,
    pub(crate) device_requested: String,
    pub(crate) precision_requested: String,
}

/// Run Image Enhance in-process. Returns `Ok(Some(result))` for supported
/// native sources, or `Ok(None)` when the source cannot be represented by the
/// card's 8-bit sRGB model/output boundary.
pub(crate) fn try_enhance(p: &EnhanceParams) -> Result<Option<EnhanceImageResult>, String> {
    let path = Path::new(&p.image_path);
    if !path.is_file() {
        return Err(format!("base image not found: {}", path.display()));
    }

    // Inspect the source colour space (header only). Float still defers, as do
    // the CMYK JPEGs `prepare_source` won't take (unmarked); everything else,
    // including CMYK TIFF and Adobe CMYK / YCCK JPEG, is processed in-process. An
    // embedded ICC profile is carried onto the output only when the colour model
    // is unchanged (RGB/RGBA/L/LA), mirroring the Python path -- a CMYK/high-bit
    // conversion produces sRGB the old profile no longer describes.
    let probe = match studio_image::probe_source(path) {
        Ok(probe) if can_handle_in_process(probe.color) => probe,
        _ => return Ok(None),
    };
    let source_mode = studio_image::source_mode_label(probe.color);
    // Our own ProPhoto manual products are colour-managed to sRGB by the
    // loader, so their profile no longer describes the output samples and must
    // not ride onto it (the Python bridge drops it the same way).
    let icc_profile = if matches!(source_mode.as_str(), "RGB" | "RGBA" | "L" | "LA") {
        probe
            .icc
            .clone()
            .filter(|icc| !super::working_image::is_prophoto_icc(icc))
    } else {
        None
    };

    let mode_str = p
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("conservative");
    let (denoise_strength, texture_pref, fallback_scale) = match mode_str {
        "conservative" => (0.3_f64, 0.25_f64, 2.0_f64),
        "texture_rebuild" => (0.15, 0.7, 2.0),
        "print_ready" => (0.2, 0.5, 2.0),
        "custom" => (
            clip01(p.denoise_strength),
            clip01(p.texture_strength),
            p.scale.max(0.01),
        ),
        _ => return Err(format!("unknown mode {mode_str:?}")),
    };
    let denoise_strength = clip01(denoise_strength);
    let mut texture_strength = clip01(texture_pref);
    if p.preserve_text_logo {
        texture_strength = texture_strength.min(0.4);
    }

    let mut target_w = p.target_width.max(0);
    let mut target_h = p.target_height.max(0);
    if target_w <= 0 && target_h <= 0 {
        let (bw, bh) = target_from_bounds(p.target_bounds.as_deref().unwrap_or(""));
        target_w = bw;
        target_h = bh;
    }
    let max_pixels = p.max_pixels.max(0);

    // Validate the output name before spending time decoding.
    reject_unsafe_output_name(p.output_name.as_deref().unwrap_or(""))?;

    let started = Instant::now();

    let (rgb, alpha) = match prepare_source(path, probe.color)? {
        Some(pair) => pair,
        // The native command turns unsupported decode surfaces into one clear
        // card-level error while preserving hard validation errors above.
        None => return Ok(None),
    };
    let (src_w, src_h) = rgb.dimensions();
    if src_w == 0 || src_h == 0 {
        return Ok(None);
    }

    let (scale, clamped) =
        resolve_scale(src_w, src_h, target_w, target_h, fallback_scale, max_pixels);
    let out_w = (f64::from(src_w) * scale).round().max(1.0) as u32;
    let out_h = (f64::from(src_h) * scale).round().max(1.0) as u32;
    let downscaling = out_w < src_w || out_h < src_h;

    let engine_requested = normalized_engine(&p.engine_requested);
    let mut engine = "cpu".to_string();
    let mut engine_fallback_reason = None;
    let mut backend_model = None;
    let mut device = None;
    let mut precision = None;

    let learned = match engine_requested.as_str() {
        "cpu" => None,
        "realesrgan" if out_w <= src_w && out_h <= src_h => {
            engine_fallback_reason = Some(
                "Real-ESRGAN only restores upscale requests; kept the complete CPU result"
                    .to_string(),
            );
            None
        }
        "realesrgan" => {
            let inference = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                super::image_enhance_onnx::upscale(&rgb, out_w, out_h, &p.device_requested)
            }));
            match inference {
                Ok(Ok(result)) => Some(result),
                Ok(Err(reason)) => {
                    engine_fallback_reason = Some(reason);
                    None
                }
                Err(_) => {
                    engine_fallback_reason = Some(
                        "native Real-ESRGAN inference panicked; kept the complete CPU result"
                            .to_string(),
                    );
                    None
                }
            }
        }
        "ccsr" | "supir" => {
            engine_fallback_reason = Some(format!(
                "Image Enhance engine `{engine_requested}` was removed with the Python/Torch runtime; use `realesrgan` or `cpu`"
            ));
            None
        }
        unknown => {
            engine_fallback_reason = Some(format!(
                "unknown Image Enhance engine {unknown:?}; kept the complete CPU result"
            ));
            None
        }
    };

    // A learned result replaces the CPU denoise/resample/sharpen chain. Any
    // model failure keeps that complete deterministic chain unchanged.
    let (processed_rgb, applied_denoise, applied_texture) = if let Some(result) = learned {
        engine = "realesrgan".to_string();
        backend_model = Some(result.backend_model);
        device = Some(result.device);
        precision = Some("fp32".to_string());
        engine_fallback_reason = combine_reasons(
            result.device_fallback_reason,
            precision_fallback_reason(&p.precision_requested),
        );
        (result.rgb, 0.0, 0.0)
    } else {
        let denoised = denoise(&rgb, denoise_strength as f32);
        let resized = resample_rgb(&denoised, out_w, out_h, downscaling);
        let applied_texture = if downscaling { 0.0 } else { texture_strength };
        (
            sharpen(&resized, applied_texture as f32),
            denoise_strength,
            applied_texture,
        )
    };

    // The alpha rides its own resize track so the matte edge never picks up a
    // denoise / sharpen halo.
    let alpha_resized = resample_gray(&alpha, out_w, out_h, downscaling);
    let out_img = combine_rgba(&processed_rgb, &alpha_resized);

    let directory = Path::new(&p.output_dir);
    fs::create_dir_all(directory)
        .map_err(|err| format!("failed to create output dir {}: {err}", directory.display()))?;
    let stem = output_stem(p.output_name.as_deref(), &p.image_path);
    let out_path = directory.join(format!("{stem}.png"));
    let target_dpi = p.target_dpi.max(1) as u32;
    write_output_png(&out_path, &out_img, icc_profile.as_deref(), target_dpi)?;

    let elapsed_ms = started.elapsed().as_millis() as i64;
    let scale_factor = round4(f64::from(out_w) / f64::from(src_w));

    let report = EnhanceReport {
        mode: mode_str.to_string(),
        scale_factor,
        source_size: Some([i64::from(src_w), i64::from(src_h)]),
        output_size: Some([i64::from(out_w), i64::from(out_h)]),
        target_size: if target_w > 0 || target_h > 0 {
            Some([target_w, target_h])
        } else {
            None
        },
        target_dpi,
        max_pixels,
        clamped,
        denoise_strength: round4(applied_denoise),
        texture_strength: round4(applied_texture),
        preserve_text_logo: p.preserve_text_logo,
        engine,
        engine_requested,
        engine_fallback_reason,
        backend_model,
        device,
        device_requested: p.device_requested.clone(),
        precision,
        precision_requested: p.precision_requested.clone(),
        processing_time_ms: elapsed_ms,
    };

    Ok(Some(EnhanceImageResult {
        enhanced_image: out_path.to_string_lossy().to_string(),
        scale_factor,
        enhance_report: report,
    }))
}

fn normalized_engine(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        "cpu".to_string()
    } else {
        value
    }
}

fn precision_fallback_reason(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "auto" | "fp32" => None,
        "fp16" => Some(
            "the native Real-ESRGAN weight is FP32; used fp32 instead of requested fp16"
                .to_string(),
        ),
        unknown => Some(format!(
            "unknown Real-ESRGAN precision request {unknown:?}; used fp32"
        )),
    }
}

fn combine_reasons(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first}; {second}")),
        (Some(reason), None) | (None, Some(reason)) => Some(reason),
        (None, None) => None,
    }
}

/// Whether the native card can represent this source at its 8-bit sRGB
/// model/output boundary. CMYK is handled through the raw-sample colour path;
/// float surfaces remain unsupported because they have no defined range map.
fn can_handle_in_process(color: ExtendedColorType) -> bool {
    use ExtendedColorType::*;
    // CMYK TIFF and CMYK-family JPEGs take the dedicated raw-sample path.
    !matches!(color, Rgb32F | Rgba32F)
}

/// A single-channel high-bit source (`image`'s `L16`, i.e. PIL's `I;16`) is
/// range-scaled to 8-bit by its own peak, matching Python's `_highbit_to_rgb`.
/// Multi-channel 16-bit (`Rgb16`/`Rgba16`) instead takes the high byte, which
/// is exactly what both PIL and `into_rgba8` do, so it rides the generic path.
fn is_single_channel_highbit(color: ExtendedColorType) -> bool {
    matches!(color, ExtendedColorType::L16)
}

/// Decode the source into an 8-bit working RGB image plus its alpha track,
/// applying the colour-space-specific conversion. Returns `Ok(None)` when the
/// decoder cannot produce the card's native boundary surface.
fn prepare_source(
    path: &Path,
    color: ExtendedColorType,
) -> Result<Option<(RgbImage, GrayImage)>, String> {
    if matches!(color, ExtendedColorType::Cmyk8) {
        // CMYK TIFF and marked/unmarked CMYK/YCCK JPEG are decoded from raw ink
        // samples so the generic image decoder cannot discard their profile.
        let raw = match super::cmyk_decode::decode_cmyk(path, DEFAULT_MAX_DECODE_PIXELS) {
            Ok(Some(raw)) => raw,
            _ => return Ok(None),
        };
        if raw.width == 0 || raw.height == 0 {
            return Ok(None);
        }
        let rgb_bytes = super::cmyk_transform::cmyk_to_rgb8(&raw);
        let rgb = match RgbImage::from_raw(raw.width, raw.height, rgb_bytes) {
            Some(img) => img,
            None => return Ok(None),
        };
        // CMYK carries no alpha channel; ride a fully-opaque track.
        let alpha = GrayImage::from_pixel(raw.width, raw.height, Luma([255]));
        return Ok(Some((rgb, alpha)));
    }

    if is_single_channel_highbit(color) {
        let (dynimg, _meta, _icc) =
            match studio_image::load_dynamic(path, DEFAULT_MAX_DECODE_PIXELS) {
                Ok(loaded) => loaded,
                Err(_) => return Ok(None),
            };
        let gray16 = dynimg.into_luma16();
        let (w, h) = gray16.dimensions();
        if w == 0 || h == 0 {
            return Ok(None);
        }
        let rgb = highbit_gray_to_rgb(&gray16);
        // No alpha channel in a high-bit grey source; ride a fully-opaque track.
        let alpha = GrayImage::from_pixel(w, h, Luma([255]));
        return Ok(Some((rgb, alpha)));
    }

    let loaded = match studio_image::load_rgba(path, DEFAULT_MAX_DECODE_PIXELS) {
        Ok(loaded) => loaded,
        Err(_) => return Ok(None),
    };
    let rgba = loaded.image;
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Ok(None);
    }
    Ok(Some(split_rgba(&rgba)))
}

/// Normalise a high-bit single-channel image down to 8-bit grey replicated to
/// RGB. Mirrors Python's `_highbit_to_rgb`: scale by the actual peak (so a
/// low-key 16-bit scan keeps its tonal range instead of being crushed by a
/// naive `>> 8`), then truncate to 8-bit exactly as `numpy.astype(uint8)` does.
fn highbit_gray_to_rgb(gray: &ImageBuffer<Luma<u16>, Vec<u16>>) -> RgbImage {
    let (w, h) = gray.dimensions();
    let peak = gray.pixels().map(|p| p.0[0]).max().unwrap_or(0) as f64;
    let scale = if peak > 255.0 { 255.0 / peak } else { 1.0 };
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in gray.enumerate_pixels() {
        let v = (f64::from(px.0[0]) * scale).clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, Rgb([v, v, v]));
    }
    out
}

/// Write the output PNG, embedding the preserved ICC profile (when present) and
/// the target DPI as a `pHYs` chunk, matching the Python bridge's `save`.
fn write_output_png(
    path: &Path,
    img: &RgbaImage,
    icc: Option<&[u8]>,
    dpi: u32,
) -> Result<(), String> {
    let file =
        File::create(path).map_err(|err| format!("failed to create {}: {err}", path.display()))?;
    let writer = BufWriter::new(file);
    let (width, height) = img.dimensions();
    // png has no `Encoder::set_icc_profile`; the ICC profile is carried on the
    // `Info` and embedded (`iCCP`) by `Encoder::with_info`.
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    if let Some(icc) = icc {
        info.icc_profile = Some(Cow::Owned(icc.to_vec()));
    }
    let mut encoder = png::Encoder::with_info(writer, info)
        .map_err(|err| format!("failed to init PNG encoder {}: {err}", path.display()))?;
    // PNG stores physical resolution in pixels-per-metre; 1 inch = 0.0254 m.
    let ppu = (f64::from(dpi.max(1)) / 0.0254).round().max(1.0) as u32;
    encoder.set_pixel_dims(Some(png::PixelDimensions {
        xppu: ppu,
        yppu: ppu,
        unit: png::Unit::Meter,
    }));
    let mut png_writer = encoder
        .write_header()
        .map_err(|err| format!("failed to write PNG header {}: {err}", path.display()))?;
    png_writer
        .write_image_data(img.as_raw())
        .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
    Ok(())
}

fn clip01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// Parse `{x, y, width, height}` placeholder bounds; `(0, 0)` when absent or
/// unparseable so the caller falls back to the preset scale.
fn target_from_bounds(bounds_json: &str) -> (i64, i64) {
    let text = bounds_json.trim();
    if text.is_empty() {
        return (0, 0);
    }
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return (0, 0),
    };
    if !value.is_object() {
        return (0, 0);
    }
    let read = |key: &str| -> i64 {
        value
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
            .round()
            .max(0.0) as i64
    };
    (read("width"), read("height"))
}

/// Pick a uniform upscale factor and whether it was clamped by `max_pixels`.
fn resolve_scale(
    src_w: u32,
    src_h: u32,
    target_w: i64,
    target_h: i64,
    fallback_scale: f64,
    max_pixels: i64,
) -> (f64, bool) {
    let mut scale = if target_w > 0 || target_h > 0 {
        let mut best = f64::MIN;
        if target_w > 0 {
            best = best.max(target_w as f64 / f64::from(src_w));
        }
        if target_h > 0 {
            best = best.max(target_h as f64 / f64::from(src_h));
        }
        best
    } else {
        fallback_scale.max(0.01)
    };

    let mut clamped = false;
    if max_pixels > 0 {
        let out_pixels = (f64::from(src_w) * scale) * (f64::from(src_h) * scale);
        if out_pixels > max_pixels as f64 {
            scale *= (max_pixels as f64 / out_pixels).sqrt();
            clamped = true;
        }
    }
    (scale, clamped)
}

fn split_rgba(img: &RgbaImage) -> (RgbImage, GrayImage) {
    let (w, h) = img.dimensions();
    let mut rgb = RgbImage::new(w, h);
    let mut alpha = GrayImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        rgb.put_pixel(x, y, Rgb([r, g, b]));
        alpha.put_pixel(x, y, Luma([a]));
    }
    (rgb, alpha)
}

fn combine_rgba(rgb: &RgbImage, alpha: &GrayImage) -> RgbaImage {
    let (w, h) = rgb.dimensions();
    let mut out = RgbaImage::new(w, h);
    for (x, y, px) in rgb.enumerate_pixels() {
        let [r, g, b] = px.0;
        let a = alpha.get_pixel(x, y).0[0];
        out.put_pixel(x, y, Rgba([r, g, b, a]));
    }
    out
}

/// Edge-preserving denoise: blend a 3x3 median-filtered copy back in by
/// `strength`.
fn denoise(img: &RgbImage, strength: f32) -> RgbImage {
    if strength <= 0.0 {
        return img.clone();
    }
    let cleaned = median3x3(img);
    blend(img, &cleaned, strength.clamp(0.0, 1.0))
}

fn median3x3(img: &RgbImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut out = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut rs = [0u8; 9];
            let mut gs = [0u8; 9];
            let mut bs = [0u8; 9];
            let mut i = 0;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = (x as i32 + dx).clamp(0, w as i32 - 1) as u32;
                    let ny = (y as i32 + dy).clamp(0, h as i32 - 1) as u32;
                    let p = img.get_pixel(nx, ny).0;
                    rs[i] = p[0];
                    gs[i] = p[1];
                    bs[i] = p[2];
                    i += 1;
                }
            }
            rs.sort_unstable();
            gs.sort_unstable();
            bs.sort_unstable();
            out.put_pixel(x, y, Rgb([rs[4], gs[4], bs[4]]));
        }
    }
    out
}

fn blend(a: &RgbImage, b: &RgbImage, s: f32) -> RgbImage {
    let (w, h) = a.dimensions();
    let mut out = RgbImage::new(w, h);
    for (x, y, pa) in a.enumerate_pixels() {
        let pb = b.get_pixel(x, y).0;
        let mut v = [0u8; 3];
        for c in 0..3 {
            let val = f32::from(pa.0[c]) * (1.0 - s) + f32::from(pb[c]) * s;
            v[c] = val.round().clamp(0.0, 255.0) as u8;
        }
        out.put_pixel(x, y, Rgb(v));
    }
    out
}

/// Resample colour in **linear light**: averaging gamma-encoded samples
/// under-weights bright pixels (a black/white edge lands on sRGB 128 instead
/// of the photometric 188), which reads as dark fringing on contrast edges.
/// Decode via the sRGB TRC, filter in `f32`, re-encode. The Python engine
/// mirrors this in `_resample` (`linear_light.py`); alpha stays on its own
/// track — coverage is already linear.
pub(super) fn resample_rgb(img: &RgbImage, out_w: u32, out_h: u32, downscaling: bool) -> RgbImage {
    if (out_w, out_h) == img.dimensions() {
        return img.clone();
    }
    let filter = if downscaling {
        FilterType::Triangle
    } else {
        FilterType::Lanczos3
    };
    let (w, h) = img.dimensions();
    let linear_buf: Vec<f32> = img
        .as_raw()
        .iter()
        .map(|&v| linear::srgb_u8_to_linear(v))
        .collect();
    let linear_img = image::Rgb32FImage::from_raw(w, h, linear_buf)
        .expect("linear buffer matches source dimensions");
    let resized = imageops::resize(&linear_img, out_w, out_h, filter);
    let out_buf: Vec<u8> = resized
        .as_raw()
        .iter()
        .map(|&l| linear::linear_to_srgb_u8(l))
        .collect();
    RgbImage::from_raw(out_w, out_h, out_buf).expect("encoded buffer matches output dimensions")
}

fn resample_gray(img: &GrayImage, out_w: u32, out_h: u32, downscaling: bool) -> GrayImage {
    if (out_w, out_h) == img.dimensions() {
        return img.clone();
    }
    let filter = if downscaling {
        FilterType::Triangle
    } else {
        FilterType::Lanczos3
    };
    imageops::resize(img, out_w, out_h, filter)
}

/// Restore high-frequency detail via an unsharp mask (PIL `UnsharpMask`,
/// radius 2.0, percent = strength*150, threshold 2).
fn sharpen(img: &RgbImage, strength: f32) -> RgbImage {
    if strength <= 0.0 {
        return img.clone();
    }
    let percent = (strength.clamp(0.0, 1.0) * 150.0).round();
    let amount = percent / 100.0;
    unsharp(img, 2.0, amount, 2)
}

fn unsharp(img: &RgbImage, sigma: f32, amount: f32, threshold: i32) -> RgbImage {
    let blurred = imageops::blur(img, sigma);
    let (w, h) = img.dimensions();
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        let bp = blurred.get_pixel(x, y).0;
        let mut v = [0u8; 3];
        for c in 0..3 {
            let orig = i32::from(px.0[c]);
            let diff = orig - i32::from(bp[c]);
            let nv = if diff.abs() > threshold {
                orig as f32 + amount * diff as f32
            } else {
                orig as f32
            };
            v[c] = nv.round().clamp(0.0, 255.0) as u8;
        }
        out.put_pixel(x, y, Rgb(v));
    }
    out
}

/// The output PNG base name: an explicit (already-validated) `output_name`, or
/// a sanitised `<image-stem>_enhanced`.
fn output_stem(output_name: Option<&str>, image_path: &str) -> String {
    if let Some(name) = output_name.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let stem = Path::new(image_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = if cleaned.is_empty() {
        "image".to_string()
    } else {
        cleaned
    };
    format!("{base}_enhanced")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_tmp(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hgripe_enhance_cpu_{nanos}_{name}"))
    }

    fn params(image: &str, out_dir: &str) -> EnhanceParams {
        EnhanceParams {
            image_path: image.to_string(),
            output_dir: out_dir.to_string(),
            output_name: None,
            mode: Some("conservative".to_string()),
            target_bounds: None,
            target_width: 0,
            target_height: 0,
            target_dpi: 300,
            max_pixels: 48_000_000,
            scale: 2.0,
            denoise_strength: 0.3,
            texture_strength: 0.25,
            preserve_text_logo: true,
            engine_requested: "cpu".to_string(),
            device_requested: "auto".to_string(),
            precision_requested: "auto".to_string(),
        }
    }

    #[test]
    fn missing_file_returns_the_native_card_error() {
        let p = params("does-not-exist.png", ".");
        let err = try_enhance(&p).unwrap_err();
        assert!(err.contains("base image not found"), "{err}");
    }

    #[test]
    fn unknown_mode_returns_the_native_card_error() {
        let dir = unique_tmp("unknown_mode");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]))
            .save(&src)
            .unwrap();
        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.mode = Some("mystery".to_string());
        let err = try_enhance(&p).unwrap_err();
        assert!(err.contains("unknown mode"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preset_scale_doubles_and_reports_parity() {
        let dir = unique_tmp("preset");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(10, 8, Rgba([120, 60, 30, 255]))
            .save(&src)
            .unwrap();

        let p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        let result = try_enhance(&p).unwrap().expect("cpu fast path");

        let report = &result.enhance_report;
        assert_eq!(report.source_size, Some([10, 8]));
        assert_eq!(report.output_size, Some([20, 16]));
        assert_eq!(report.scale_factor, 2.0);
        assert_eq!(report.mode, "conservative");
        assert_eq!(report.engine, "cpu");
        assert!(report.target_size.is_none());
        assert!(!report.clamped);
        // preserve_text_logo caps the conservative 0.25 texture below its cap.
        assert_eq!(report.texture_strength, 0.25);
        assert!(Path::new(&result.enhanced_image).is_file());

        let out = image::open(&result.enhanced_image).unwrap().to_rgba8();
        assert_eq!(out.dimensions(), (20, 16));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_bounds_drive_scale_and_size() {
        let dir = unique_tmp("bounds");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(20, 20, Rgba([200, 200, 200, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.target_bounds = Some(r#"{"x":0,"y":0,"width":60,"height":40}"#.to_string());
        let result = try_enhance(&p).unwrap().expect("cpu fast path");

        // Covers the target: max(60/20, 40/20) = 3.0 -> 60x60.
        assert_eq!(result.enhance_report.output_size, Some([60, 60]));
        assert_eq!(result.enhance_report.target_size, Some([60, 40]));
        assert_eq!(result.scale_factor, 3.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_pixels_clamps_scale() {
        let dir = unique_tmp("clamp");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(100, 100, Rgba([10, 20, 30, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.mode = Some("custom".to_string());
        p.scale = 4.0; // 400x400 = 160k px
        p.max_pixels = 40_000; // caps to 200x200
        let result = try_enhance(&p).unwrap().expect("cpu fast path");

        assert!(result.enhance_report.clamped);
        assert_eq!(result.enhance_report.output_size, Some([200, 200]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preserve_text_logo_caps_texture() {
        let dir = unique_tmp("cap");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(8, 8, Rgba([90, 90, 90, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.mode = Some("texture_rebuild".to_string()); // texture 0.7
        p.preserve_text_logo = true;
        let capped = try_enhance(&p).unwrap().unwrap();
        assert_eq!(capped.enhance_report.texture_strength, 0.4);

        p.preserve_text_logo = false;
        let uncapped = try_enhance(&p).unwrap().unwrap();
        assert_eq!(uncapped.enhance_report.texture_strength, 0.7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removed_and_unknown_engines_keep_a_complete_cpu_result() {
        let dir = unique_tmp("engine_fallbacks");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(8, 8, Rgba([90, 120, 150, 255]))
            .save(&src)
            .unwrap();

        for engine in ["ccsr", "supir", "mystery_sr"] {
            let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
            p.engine_requested = engine.to_string();
            p.output_name = Some(format!("fallback_{engine}"));
            let result = try_enhance(&p).unwrap().expect("complete CPU fallback");
            assert_eq!(result.enhance_report.engine, "cpu");
            assert_eq!(result.enhance_report.engine_requested, engine);
            assert!(result
                .enhance_report
                .engine_fallback_reason
                .as_deref()
                .is_some_and(|reason| reason.contains(engine)));
            assert!(Path::new(&result.enhanced_image).is_file());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn realesrgan_non_enlarging_request_skips_model_and_keeps_cpu_output() {
        let dir = unique_tmp("realesrgan_downscale");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(12, 8, Rgba([90, 120, 150, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.engine_requested = "realesrgan".to_string();
        p.target_width = 6;
        p.target_height = 4;
        let result = try_enhance(&p).unwrap().expect("complete CPU fallback");
        assert_eq!(result.enhance_report.engine, "cpu");
        assert_eq!(result.enhance_report.engine_requested, "realesrgan");
        assert!(result
            .enhance_report
            .engine_fallback_reason
            .as_deref()
            .unwrap()
            .contains("only restores upscale"));
        assert_eq!(result.enhance_report.output_size, Some([6, 4]));

        p.target_width = 0;
        p.target_height = 0;
        p.mode = Some("custom".to_string());
        p.scale = 1.001;
        p.output_name = Some("rounded_same_size".to_string());
        let rounded = try_enhance(&p)
            .unwrap()
            .expect("rounded same-size request keeps CPU output");
        assert_eq!(rounded.enhance_report.output_size, Some([12, 8]));
        assert!(rounded
            .enhance_report
            .engine_fallback_reason
            .as_deref()
            .unwrap()
            .contains("only restores upscale"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn realesrgan_missing_weight_keeps_cpu_output() {
        if super::super::resolve_realesrgan_model_path().is_some() {
            eprintln!("skipping missing-weight fallback test: realesrgan_x4v3.onnx is installed");
            return;
        }
        let dir = unique_tmp("realesrgan_missing");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        RgbaImage::from_pixel(8, 8, Rgba([90, 120, 150, 255]))
            .save(&src)
            .unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.engine_requested = "realesrgan".to_string();
        let result = try_enhance(&p).unwrap().expect("complete CPU fallback");
        assert_eq!(result.enhance_report.engine, "cpu");
        assert_eq!(result.enhance_report.engine_requested, "realesrgan");
        assert!(result
            .enhance_report
            .engine_fallback_reason
            .as_deref()
            .unwrap()
            .contains("model not found"));
        assert!(Path::new(&result.enhanced_image).is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn realesrgan_inference_when_weight_present() {
        if super::super::resolve_realesrgan_model_path().is_none() {
            eprintln!("skipping Real-ESRGAN inference test: realesrgan_x4v3.onnx not installed");
            return;
        }
        let dir = unique_tmp("realesrgan_real");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        // Width crosses the native 128px tile boundary, so this gated test
        // covers both real session execution and padded tile assembly.
        let mut input = RgbaImage::new(132, 8);
        for (x, y, pixel) in input.enumerate_pixels_mut() {
            let alpha = if x < 2 && y < 2 { 0 } else { 255 };
            *pixel = Rgba([
                ((x * 3) % 256) as u8,
                (y * 29) as u8,
                (((x + y) * 5) % 256) as u8,
                alpha,
            ]);
        }
        input.save(&src).unwrap();

        let mut p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        p.engine_requested = "realesrgan".to_string();
        p.device_requested = "cpu".to_string();
        p.target_width = 396;
        p.target_height = 24;
        let result = try_enhance(&p).unwrap().expect("native Real-ESRGAN result");
        let report = &result.enhance_report;
        assert_eq!(report.engine, "realesrgan", "{report:?}");
        assert_eq!(report.engine_requested, "realesrgan");
        assert_eq!(
            report.backend_model.as_deref(),
            Some("realesrgan_x4v3.onnx")
        );
        assert_eq!(report.device.as_deref(), Some("cpu"));
        assert_eq!(report.precision.as_deref(), Some("fp32"));
        assert!(report.engine_fallback_reason.is_none(), "{report:?}");
        assert_eq!(report.output_size, Some([396, 24]));
        assert_eq!(report.denoise_strength, 0.0);
        assert_eq!(report.texture_strength, 0.0);

        let output = image::open(&result.enhanced_image).unwrap().to_rgba8();
        assert_eq!(output.dimensions(), (396, 24));
        let expected_alpha = resample_gray(&split_rgba(&input).1, 396, 24, false);
        assert!(output
            .pixels()
            .zip(expected_alpha.pixels())
            .all(|(actual, expected)| actual.0[3] == expected.0[0]));
        assert!(output
            .pixels()
            .any(|pixel| pixel.0[..3] != output.get_pixel(0, 0).0[..3]));

        p.device_requested = "gpu".to_string();
        p.precision_requested = "fp16".to_string();
        p.output_name = Some("realesrgan_gpu_request".to_string());
        let degraded = try_enhance(&p)
            .unwrap()
            .expect("CPU-provider Real-ESRGAN result");
        assert_eq!(degraded.enhance_report.engine, "realesrgan");
        assert_eq!(degraded.enhance_report.device.as_deref(), Some("cpu"));
        let reason = degraded
            .enhance_report
            .engine_fallback_reason
            .as_deref()
            .unwrap();
        assert!(
            reason.contains("GPU execution provider not built in"),
            "{reason}"
        );
        assert!(reason.contains("used fp32"), "{reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resample_averages_in_linear_light() {
        // A 2x2 black/white checker downscaled to 1x1: gamma-space averaging
        // gives ~128; the photometric (linear-light) average encodes to 188.
        // The Python engine pins the same golden (`test_linear_light.py`).
        let mut img = RgbImage::new(2, 2);
        img.put_pixel(0, 0, Rgb([255, 255, 255]));
        img.put_pixel(1, 1, Rgb([255, 255, 255]));
        let out = resample_rgb(&img, 1, 1, true);
        for c in out.get_pixel(0, 0).0 {
            assert!(
                (i32::from(c) - 188).abs() <= 1,
                "got {:?}",
                out.get_pixel(0, 0)
            );
        }
    }

    #[test]
    fn resample_keeps_flat_colours_exact() {
        // The TRC round-trip must be lossless on flat surfaces so plain scales
        // of solid colours stay byte-stable.
        let img = RgbImage::from_pixel(3, 3, Rgb([120, 60, 30]));
        let up = resample_rgb(&img, 6, 6, false);
        for px in up.pixels() {
            assert_eq!(px.0, [120, 60, 30]);
        }
    }

    #[test]
    fn prophoto_manual_product_egresses_srgb_without_stale_profile() {
        use crate::studio::working_image::{prophoto_icc, WorkingImage, WorkingSpace};

        let dir = unique_tmp("prophoto");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.png");
        // An 8x8 ProPhoto mid-grey surface, written exactly like a manual-path
        // product (16-bit PNG with the ProPhoto profile embedded).
        let pixels: Vec<u16> = (0..8 * 8)
            .flat_map(|_| [32768u16, 32768, 32768, 65535])
            .collect();
        let img = WorkingImage {
            width: 8,
            height: 8,
            pixels,
            space: WorkingSpace::ProPhoto,
            icc: Some(prophoto_icc().to_vec()),
        };
        studio_image::write_working_png(&src, &img).unwrap();

        let p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        let result = try_enhance(&p).unwrap().expect("cpu fast path");

        // The loader colour-manages ProPhoto to sRGB, so the stale profile
        // must not be embedded on the output.
        let probe = studio_image::probe_source(Path::new(&result.enhanced_image)).unwrap();
        assert!(
            probe.icc.is_none(),
            "stale ProPhoto profile must not ride onto the sRGB output"
        );
        // ProPhoto mid-grey (32768) colour-manages to ~146 in sRGB; a naive
        // (unmanaged) read would leave it at 128.
        let out = image::open(&result.enhanced_image).unwrap().to_rgba8();
        let px = out.get_pixel(4, 4).0;
        for c in &px[..3] {
            assert!((i32::from(*c) - 146).abs() <= 4, "got {px:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn colour_space_gating() {
        use ExtendedColorType::*;
        // CMYK is admitted here now (CMYK TIFF and Adobe CMYK / YCCK JPEG are
        // processed in-process; unmarked CMYK JPEGs defer inside `prepare_source`).
        // Only float still defers at the gate.
        assert!(can_handle_in_process(Cmyk8));
        assert!(!can_handle_in_process(Rgb32F));
        assert!(!can_handle_in_process(Rgba32F));
        // 8-bit and 16-bit RGB/RGBA/L/LA (ICC-tagged or not) are handled now.
        assert!(can_handle_in_process(Rgb8));
        assert!(can_handle_in_process(Rgba8));
        assert!(can_handle_in_process(L16));
        assert!(can_handle_in_process(Rgb16));
        assert!(can_handle_in_process(Rgba16));
        // Only the single-channel 16-bit source is range-scaled; multi-channel
        // 16-bit rides the generic high-byte path.
        assert!(is_single_channel_highbit(L16));
        assert!(!is_single_channel_highbit(Rgb16));
        assert!(!is_single_channel_highbit(La16));
    }

    #[test]
    fn cmyk_tiff_enhances_in_process() {
        use std::io::Cursor;
        use tiff::encoder::{colortype, TiffEncoder};

        let dir = unique_tmp("cmyk");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.tiff");
        // A flat 4x4 CMYK field, no embedded profile -> PIL's naive formula:
        // (128,64,32,16) -> (119,179,209). A flat field survives denoise /
        // Lanczos / unsharp unchanged, so the enhanced output must land on it.
        let (w, h) = (4u32, 4u32);
        let samples: Vec<u8> = (0..w * h).flat_map(|_| [128u8, 64, 32, 16]).collect();
        let mut buf = Cursor::new(Vec::new());
        {
            let mut enc = TiffEncoder::new(&mut buf).unwrap();
            enc.write_image::<colortype::CMYK8>(w, h, &samples).unwrap();
        }
        std::fs::write(&src, buf.into_inner()).unwrap();

        let result = try_enhance(&params(src.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("CMYK TIFF should take the in-process path");
        let report = &result.enhance_report;
        assert_eq!(report.engine, "cpu");
        assert_eq!(report.source_size, Some([4, 4]));
        assert_eq!(report.output_size, Some([8, 8])); // conservative 2x
        assert!(Path::new(&result.enhanced_image).is_file());

        let out = image::open(&result.enhanced_image).unwrap().to_rgb8();
        let px = out.get_pixel(4, 4).0;
        assert!((i32::from(px[0]) - 119).abs() <= 12, "R {} vs 119", px[0]);
        assert!((i32::from(px[1]) - 179).abs() <= 12, "G {} vs 179", px[1]);
        assert!((i32::from(px[2]) - 209).abs() <= 12, "B {} vs 209", px[2]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cmyk_jpeg_enhances_in_process() {
        // The same PIL-generated Adobe CMYK JPEG fixture the decode tests use:
        // routing it in-process (instead of deferring to Python) is the point of
        // this change. Decode/transform fidelity is asserted in `cmyk_decode`;
        // here we only prove the JPEG now takes the Rust path and inverts the
        // Adobe ink correctly (the no-ink corner reads near-white, not near-black).
        let jpeg: &[u8] = include_bytes!("../../tests/fixtures/cmyk_adobe_app14.jpg");

        let dir = unique_tmp("cmyk_jpeg");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.jpg");
        std::fs::write(&src, jpeg).unwrap();

        let result = try_enhance(&params(src.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("an Adobe CMYK JPEG should take the in-process path");
        let report = &result.enhance_report;
        assert_eq!(report.engine, "cpu");
        assert_eq!(report.source_size, Some([32, 32]));
        assert_eq!(report.output_size, Some([64, 64])); // conservative 2x

        // Deep inside the no-ink (white) top-left tile after the 2x upscale.
        let out = image::open(&result.enhanced_image).unwrap().to_rgb8();
        let px = out.get_pixel(8, 8).0;
        assert!(
            px.iter().all(|&v| v >= 240),
            "no-ink corner must stay near-white, got {px:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ycck_jpeg_enhances_in_process() {
        // The Adobe YCCK JPEG fixture (APP14 transform 2). `image` decodes YCCK
        // to RGB and reports it as `Rgb8`, so without the probe's CMYK
        // reclassification this would silently take the generic path; here we
        // prove it reaches the Rust CMYK path and reconstructs the ink correctly
        // (no-ink corner near-white, full-cyan corner cyan). Reconstruction and
        // ICC-preservation fidelity are asserted in `cmyk_decode`.
        let jpeg: &[u8] = include_bytes!("../../tests/fixtures/cmyk_ycck_app14.jpg");

        let dir = unique_tmp("ycck_jpeg");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.jpg");
        std::fs::write(&src, jpeg).unwrap();

        let result = try_enhance(&params(src.to_str().unwrap(), dir.to_str().unwrap()))
            .unwrap()
            .expect("an Adobe YCCK JPEG should take the in-process path");
        let report = &result.enhance_report;
        assert_eq!(report.engine, "cpu");
        assert_eq!(report.source_size, Some([32, 32]));
        assert_eq!(report.output_size, Some([64, 64])); // conservative 2x

        let out = image::open(&result.enhanced_image).unwrap().to_rgb8();
        // No-ink top-left tile stays near-white after the 2x upscale.
        let white = out.get_pixel(8, 8).0;
        assert!(
            white.iter().all(|&v| v >= 240),
            "no-ink corner must stay near-white, got {white:?}"
        );
        // Full-cyan top-right tile: low red, high green/blue (a wrong YCCK
        // reconstruction or inversion collapses this).
        let cyan = out.get_pixel(48, 16).0;
        assert!(
            cyan[0] <= 40 && cyan[1] >= 200 && cyan[2] >= 200,
            "full-cyan corner must read cyan, got {cyan:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn highbit_gray_scales_by_peak() {
        // A low-key 16-bit scan (peak 60000) must keep its tonal range, not be
        // crushed by a naive >> 8; matches Python's numpy peak scaling + trunc.
        let mut gray = ImageBuffer::<Luma<u16>, Vec<u16>>::new(2, 2);
        gray.put_pixel(0, 0, Luma([0]));
        gray.put_pixel(1, 0, Luma([30_000]));
        gray.put_pixel(0, 1, Luma([60_000]));
        gray.put_pixel(1, 1, Luma([15_000]));
        let rgb = highbit_gray_to_rgb(&gray);
        // scale = 255/60000; values truncate toward zero like astype(uint8).
        assert_eq!(rgb.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(rgb.get_pixel(1, 0).0, [127, 127, 127]); // 30000*255/60000=127.5
        assert_eq!(rgb.get_pixel(0, 1).0, [255, 255, 255]);
        assert_eq!(rgb.get_pixel(1, 1).0, [63, 63, 63]); // 15000*255/60000=63.75
    }

    #[test]
    fn highbit_gray_below_255_peak_is_unscaled() {
        let mut gray = ImageBuffer::<Luma<u16>, Vec<u16>>::new(2, 1);
        gray.put_pixel(0, 0, Luma([200]));
        gray.put_pixel(1, 0, Luma([100]));
        let rgb = highbit_gray_to_rgb(&gray);
        assert_eq!(rgb.get_pixel(0, 0).0, [200, 200, 200]);
        assert_eq!(rgb.get_pixel(1, 0).0, [100, 100, 100]);
    }

    #[test]
    fn output_png_embeds_icc_and_dpi() {
        let dir = unique_tmp("icc");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("o.png");
        let icc = vec![9u8, 8, 7, 6, 5, 4, 3, 2, 1];
        let img = RgbaImage::from_pixel(3, 2, Rgba([10, 20, 30, 255]));
        write_output_png(&out, &img, Some(&icc), 300).unwrap();

        let decoder = png::Decoder::new(std::fs::File::open(&out).unwrap());
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(
            info.icc_profile.as_deref().map(<[u8]>::to_vec),
            Some(icc.clone())
        );
        let dims = info.pixel_dims.expect("pHYs written");
        assert_eq!(dims.unit, png::Unit::Meter);
        // 300 dpi / 0.0254 m ~= 11811 ppu.
        assert!((11_810..=11_812).contains(&dims.xppu));
        assert_eq!(dims.xppu, dims.yppu);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn highbit_source_takes_fast_path() {
        let dir = unique_tmp("i16");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("scan.png");
        let mut gray = ImageBuffer::<Luma<u16>, Vec<u16>>::new(6, 4);
        for (i, px) in gray.pixels_mut().enumerate() {
            *px = Luma([(i as u16) * 2_000]);
        }
        image::DynamicImage::ImageLuma16(gray).save(&src).unwrap();

        let p = params(src.to_str().unwrap(), dir.to_str().unwrap());
        let result = try_enhance(&p).unwrap().expect("cpu fast path");
        assert_eq!(result.enhance_report.source_size, Some([6, 4]));
        assert_eq!(result.enhance_report.output_size, Some([12, 8]));
        assert!(Path::new(&result.enhanced_image).is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
