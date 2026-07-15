//! Native PCT-Net adapter for the opt-in `onnx_harmonize` engine.
//!
//! This is deliberately a concrete model integration, not a generic
//! first-input/first-output ONNX seam. The supported weight is the PCT-Net ViT
//! export documented in `resources/models/README.md`: four named float32 NCHW
//! inputs (`image_lr`, `image_fullres`, `mask_lr`, `mask_fullres`) and one
//! named full-resolution RGB output (`output`). PCT-Net's transformer has a
//! fixed 256x256 low-resolution branch even though those ONNX axes are marked
//! dynamic, so preprocessing always supplies that exact geometry.

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{GrayImage, Luma, Rgb, RgbImage, RgbaImage};
use ort::value::{Tensor, TensorElementType};

use super::onnx_pool::{cached_session, OnnxDeviceRequest, OnnxProviderResolution};

const MODEL_FILE: &str = "color_harmonize.onnx";
const MODEL_ENV: &str = "HGRIPE_COLOR_MODEL";
const MODEL_ENGINE: &str = "onnx_harmonize";
const LOW_RES_EDGE: u32 = 256;
const MAX_FULLRES_EDGE: u32 = 4096;
// CPU fallback uses f64 Lab planes while ORT owns four f32 inputs and a full
// RGB output. Keep learned inference below 4 MP so a normal Windows desktop
// does not cross the multi-gigabyte peak a 4K frame would otherwise require.
const MAX_FULLRES_PIXELS: u64 = 4_194_304;
const OUTPUT_RANGE_EPSILON: f32 = 1e-3;
const MIN_BACKGROUND_CONTEXT_FRACTION: f64 = 0.01;

pub(crate) struct OnnxHarmonizeResult {
    /// Interleaved RGB in the card's 0..255 working range.
    pub(crate) rgb: Vec<f64>,
    pub(crate) backend_model: String,
    pub(crate) device: String,
    pub(crate) device_fallback_reason: Option<String>,
}

#[derive(Debug)]
struct PreparedInputs {
    image_lr: Vec<f32>,
    image_fullres: Vec<f32>,
    mask_lr: Vec<f32>,
    mask_fullres: Vec<f32>,
    background_fullres: RgbImage,
    matte_fullres: GrayImage,
}

/// Resolve the trained PCT-Net weight through the same managed-model order as
/// the other native ONNX cards: process env, persisted override, shared cache,
/// then packaged/development resources.
pub(crate) fn resolve_color_model_path() -> Option<PathBuf> {
    if let Some(path) = env_file(MODEL_ENV) {
        return Some(path);
    }

    let config = crate::psd::load_model_paths_config();
    if let Some(path) = config
        .weights
        .get(MODEL_ENGINE)
        .and_then(|raw| existing_file(raw))
    {
        return Some(path);
    }

    let env_cache = std::env::var("HGRIPE_MODEL_CACHE")
        .ok()
        .filter(|raw| !raw.trim().is_empty());
    for cache in [env_cache.as_deref(), config.model_cache_dir.as_deref()]
        .into_iter()
        .flatten()
    {
        let candidate = Path::new(cache.trim()).join(MODEL_FILE);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    super::subject_model::resolve_model_file(MODEL_ENV, MODEL_FILE)
}

/// Run the trained PCT-Net harmonizer and return its raw RGB candidate. Region
/// narrowing, strength, tone protection, brand-colour protection and alpha
/// recombination remain owned by `color_match_cpu`, so learned success and CPU
/// fallback share the exact same card contract.
pub(crate) fn harmonize(
    subject: &RgbaImage,
    background: &RgbaImage,
    model_matte: &[f64],
    device_requested: &str,
) -> Result<OnnxHarmonizeResult, String> {
    let (width, height) = subject.dimensions();
    validate_surface_size(width, height, "subject")?;
    validate_surface_size(background.width(), background.height(), "background")?;

    let path = resolve_color_model_path().ok_or_else(|| {
        format!(
            "PCT-Net harmonization model not found; configure {MODEL_ENGINE}, set {MODEL_ENV}, or install resources/models/{MODEL_FILE}"
        )
    })?;
    let normalized_device = device_requested.trim().to_ascii_lowercase();
    let device_request = OnnxDeviceRequest::from_param(&normalized_device);
    let shared = cached_session(&path, device_request)?;
    {
        let session = shared
            .lock()
            .map_err(|_| "PCT-Net ONNX session poisoned".to_string())?;
        validate_model_contract(&session, width, height)?;
    }

    let PreparedInputs {
        image_lr,
        image_fullres,
        mask_lr,
        mask_fullres,
        background_fullres,
        matte_fullres,
    } = prepare_inputs(subject, background, model_matte)?;
    let image_lr = Tensor::from_array((
        vec![1_i64, 3, i64::from(LOW_RES_EDGE), i64::from(LOW_RES_EDGE)],
        image_lr,
    ))
    .map_err(|err| format!("failed to build PCT-Net `image_lr` input: {err}"))?;
    let image_fullres = Tensor::from_array((
        vec![1_i64, 3, i64::from(height), i64::from(width)],
        image_fullres,
    ))
    .map_err(|err| format!("failed to build PCT-Net `image_fullres` input: {err}"))?;
    let mask_lr = Tensor::from_array((
        vec![1_i64, 1, i64::from(LOW_RES_EDGE), i64::from(LOW_RES_EDGE)],
        mask_lr,
    ))
    .map_err(|err| format!("failed to build PCT-Net `mask_lr` input: {err}"))?;
    let mask_fullres = Tensor::from_array((
        vec![1_i64, 1, i64::from(height), i64::from(width)],
        mask_fullres,
    ))
    .map_err(|err| format!("failed to build PCT-Net `mask_fullres` input: {err}"))?;

    let mut session = shared
        .lock()
        .map_err(|_| "PCT-Net ONNX session poisoned".to_string())?;
    let outputs = session
        .run(ort::inputs![
            "image_lr" => image_lr,
            "image_fullres" => image_fullres,
            "mask_lr" => mask_lr,
            "mask_fullres" => mask_fullres,
        ])
        .map_err(|err| format!("PCT-Net harmonization inference failed: {err}"))?;
    let output = outputs.get("output").ok_or_else(|| {
        let names: Vec<_> = outputs.keys().collect();
        format!("PCT-Net model returned no `output` tensor (found {names:?})")
    })?;
    let (shape, values) = output
        .try_extract_tensor::<f32>()
        .map_err(|err| format!("failed to read PCT-Net `output`: {err}"))?;
    let rgb = decode_output(values, shape, subject, &background_fullres, &matte_fullres)?;
    drop(outputs);
    drop(session);

    let resolution = annotate_unknown_device(shared.resolution().clone(), &normalized_device);
    let backend_model = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    Ok(OnnxHarmonizeResult {
        rgb,
        backend_model,
        device: resolution.device.to_string(),
        device_fallback_reason: resolution.fallback_reason,
    })
}

fn annotate_unknown_device(
    mut resolution: OnnxProviderResolution,
    normalized_device: &str,
) -> OnnxProviderResolution {
    if !normalized_device.is_empty()
        && !matches!(
            normalized_device,
            "auto" | "cpu" | "cuda" | "directml" | "gpu"
        )
    {
        let unknown = format!("unknown ONNX device request {normalized_device:?}; treated as auto");
        resolution.fallback_reason = Some(match resolution.fallback_reason.take() {
            Some(reason) => format!("{unknown}; {reason}"),
            None => unknown,
        });
    }
    resolution
}

fn env_file(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn existing_file(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw.trim());
    path.is_file().then_some(path)
}

pub(crate) fn validate_surface_size(width: u32, height: u32, surface: &str) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!("PCT-Net {surface} cannot be empty"));
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| format!("PCT-Net {surface} tensor size overflowed"))?;
    if width > MAX_FULLRES_EDGE || height > MAX_FULLRES_EDGE || pixels > MAX_FULLRES_PIXELS {
        return Err(format!(
            "PCT-Net {surface} {width}x{height} exceeds the native inference limit ({MAX_FULLRES_EDGE}px edge, {MAX_FULLRES_PIXELS} pixels); kept the CPU result"
        ));
    }
    Ok(())
}

fn validate_model_contract(
    session: &ort::session::Session,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if session.inputs().len() != 4 {
        return Err(format!(
            "PCT-Net model must have exactly four inputs, found {}",
            session.inputs().len()
        ));
    }
    let expected_inputs = [
        (
            "image_lr",
            3_i64,
            i64::from(LOW_RES_EDGE),
            i64::from(LOW_RES_EDGE),
        ),
        ("image_fullres", 3_i64, i64::from(height), i64::from(width)),
        (
            "mask_lr",
            1_i64,
            i64::from(LOW_RES_EDGE),
            i64::from(LOW_RES_EDGE),
        ),
        ("mask_fullres", 1_i64, i64::from(height), i64::from(width)),
    ];
    for (name, channels, expected_h, expected_w) in expected_inputs {
        let input = session
            .inputs()
            .iter()
            .find(|input| input.name() == name)
            .ok_or_else(|| {
                let names: Vec<_> = session.inputs().iter().map(|input| input.name()).collect();
                format!("PCT-Net model has no `{name}` input (found {names:?})")
            })?;
        if input.dtype().tensor_type() != Some(TensorElementType::Float32) {
            return Err(format!(
                "PCT-Net `{name}` input must be float32, found {:?}",
                input.dtype().tensor_type()
            ));
        }
        let shape = input
            .dtype()
            .tensor_shape()
            .ok_or_else(|| format!("PCT-Net `{name}` input is not a tensor"))?;
        validate_nchw_shape(shape, channels, expected_h, expected_w, name)?;
    }

    if session.outputs().len() != 1 {
        return Err(format!(
            "PCT-Net model must have exactly one output, found {}",
            session.outputs().len()
        ));
    }
    let output = session
        .outputs()
        .iter()
        .find(|output| output.name() == "output")
        .ok_or_else(|| "PCT-Net model has no `output` tensor".to_string())?;
    if output.dtype().tensor_type() != Some(TensorElementType::Float32) {
        return Err(format!(
            "PCT-Net `output` must be float32, found {:?}",
            output.dtype().tensor_type()
        ));
    }
    let shape = output
        .dtype()
        .tensor_shape()
        .ok_or_else(|| "PCT-Net `output` is not a tensor".to_string())?;
    validate_nchw_shape(shape, 3, i64::from(height), i64::from(width), "output")
}

fn validate_nchw_shape(
    shape: &[i64],
    channels: i64,
    height: i64,
    width: i64,
    name: &str,
) -> Result<(), String> {
    let expected = [1_i64, channels, height, width];
    let compatible = shape.len() == expected.len()
        && shape
            .iter()
            .zip(expected)
            .all(|(&actual, expected)| actual == -1 || actual == expected);
    if compatible {
        Ok(())
    } else {
        Err(format!(
            "PCT-Net `{name}` shape {shape:?} is incompatible with {expected:?}"
        ))
    }
}

fn prepare_inputs(
    subject: &RgbaImage,
    background: &RgbaImage,
    model_matte: &[f64],
) -> Result<PreparedInputs, String> {
    let (width, height) = subject.dimensions();
    let expected_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "PCT-Net matte size overflowed".to_string())?;
    if model_matte.len() != expected_pixels {
        return Err(format!(
            "PCT-Net matte length {} does not match subject {width}x{height}",
            model_matte.len()
        ));
    }
    if let Some((index, value)) = model_matte
        .iter()
        .copied()
        .enumerate()
        .find(|(_, value)| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err(format!(
            "PCT-Net matte contains invalid value {value} at index {index}"
        ));
    }
    let background_context =
        model_matte.iter().map(|value| 1.0 - value).sum::<f64>() / expected_pixels as f64;
    if background_context < MIN_BACKGROUND_CONTEXT_FRACTION {
        return Err(
            "PCT-Net needs subject alpha or a connected mask that exposes background context; kept the complete CPU result"
                .to_string(),
        );
    }
    let mut alpha_sum = 0.0_f64;
    let mut mean = [0.0_f64; 3];
    for pixel in background.pixels() {
        let alpha = f64::from(pixel.0[3]) / 255.0;
        alpha_sum += alpha;
        for (channel, total) in mean.iter_mut().enumerate() {
            *total += (f64::from(pixel.0[channel]) / 255.0) * alpha;
        }
    }
    if alpha_sum <= f64::EPSILON {
        return Err(
            "PCT-Net background has no visible pixels; kept the complete CPU result".to_string(),
        );
    }
    for value in &mut mean {
        *value /= alpha_sum;
    }

    // Flatten onto the visible background mean before resize. Resizing
    // unassociated RGBA first could interpolate hidden RGB from transparent
    // pixels into a non-zero alpha edge and leak it into the model context.
    let mut sanitized = RgbImage::new(background.width(), background.height());
    for (source, target) in background.pixels().zip(sanitized.pixels_mut()) {
        let alpha = f64::from(source.0[3]) / 255.0;
        let mut rgb = [0_u8; 3];
        for (channel, target_channel) in rgb.iter_mut().enumerate() {
            let visible = f64::from(source.0[channel]) / 255.0;
            let value = visible * alpha + mean[channel] * (1.0 - alpha);
            *target_channel = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        *target = Rgb(rgb);
    }
    let background = image::imageops::resize(&sanitized, width, height, FilterType::Triangle);

    let mut composite = RgbImage::new(width, height);
    let mut mask = GrayImage::new(width, height);
    for ((((subject_pixel, background_pixel), composite_pixel), mask_pixel), &matte) in subject
        .pixels()
        .zip(background.pixels())
        .zip(composite.pixels_mut())
        .zip(mask.pixels_mut())
        .zip(model_matte)
    {
        let matte_byte = (matte * 255.0).round() as u8;
        let matte = f64::from(matte_byte) / 255.0;
        let mut rgb = [0_u8; 3];
        for (channel, target_channel) in rgb.iter_mut().enumerate() {
            let background_rgb = f64::from(background_pixel.0[channel]) / 255.0;
            let subject_rgb = f64::from(subject_pixel.0[channel]) / 255.0;
            let value = subject_rgb * matte + background_rgb * (1.0 - matte);
            *target_channel = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        *composite_pixel = Rgb(rgb);
        *mask_pixel = Luma([matte_byte]);
    }

    let composite_lr =
        image::imageops::resize(&composite, LOW_RES_EDGE, LOW_RES_EDGE, FilterType::Triangle);
    let mask_lr = image::imageops::resize(&mask, LOW_RES_EDGE, LOW_RES_EDGE, FilterType::Triangle);
    Ok(PreparedInputs {
        image_lr: pack_rgb_nchw(&composite_lr),
        image_fullres: pack_rgb_nchw(&composite),
        mask_lr: pack_mask_nchw(&mask_lr),
        mask_fullres: pack_mask_nchw(&mask),
        background_fullres: background,
        matte_fullres: mask,
    })
}

fn pack_rgb_nchw(image: &RgbImage) -> Vec<f32> {
    // The fixed ViT_pct configuration uses mean=[0,0,0], std=[1,1,1]. Its
    // predictor contract is therefore RGB/255; ImageNet normalization belongs
    // to the separate CNN_pct configuration and must not be applied here.
    let plane = (image.width() as usize) * (image.height() as usize);
    let mut output = vec![0.0_f32; plane * 3];
    for (index, pixel) in image.pixels().enumerate() {
        for channel in 0..3 {
            output[channel * plane + index] = f32::from(pixel.0[channel]) / 255.0;
        }
    }
    output
}

fn pack_mask_nchw(mask: &GrayImage) -> Vec<f32> {
    mask.pixels()
        .map(|pixel| f32::from(pixel.0[0]) / 255.0)
        .collect()
}

fn decode_output(
    values: &[f32],
    shape: &[i64],
    subject: &RgbaImage,
    background: &RgbImage,
    matte: &GrayImage,
) -> Result<Vec<f64>, String> {
    let (width, height) = subject.dimensions();
    if background.dimensions() != (width, height) || matte.dimensions() != (width, height) {
        return Err("PCT-Net postprocess surfaces do not share the subject geometry".to_string());
    }
    let expected_shape = [1_i64, 3, i64::from(height), i64::from(width)];
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "PCT-Net output size overflowed".to_string())?;
    if shape != expected_shape || values.len() != expected_len {
        return Err(format!(
            "PCT-Net `output` shape {shape:?} / length {} does not match {expected_shape:?}",
            values.len()
        ));
    }
    if let Some((index, value)) = values.iter().copied().enumerate().find(|(_, value)| {
        !value.is_finite() || *value < -OUTPUT_RANGE_EPSILON || *value > 1.0 + OUTPUT_RANGE_EPSILON
    }) {
        return Err(format!(
            "PCT-Net `output` contains invalid value {value} at index {index}"
        ));
    }

    let plane = (width as usize) * (height as usize);
    let mut rgb = vec![0.0_f64; expected_len];
    for pixel in 0..plane {
        let alpha = f64::from(matte.as_raw()[pixel]) / 255.0;
        for channel in 0..3 {
            let straight = if alpha <= f64::EPSILON {
                f64::from(subject.as_raw()[pixel * 4 + channel]) / 255.0
            } else {
                let composite = f64::from(values[channel * plane + pixel].clamp(0.0, 1.0));
                let background = f64::from(background.as_raw()[pixel * 3 + channel]) / 255.0;
                (composite - background * (1.0 - alpha)) / alpha
            };
            rgb[pixel * 3 + channel] = straight.clamp(0.0, 1.0) * 255.0;
        }
    }
    Ok(rgb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn unknown_device_is_treated_as_auto_without_claiming_cpu_use() {
        let resolution = crate::studio::onnx_pool::resolve_provider(OnnxDeviceRequest::Auto);
        let annotated = annotate_unknown_device(resolution, "metal");
        let reason = annotated.fallback_reason.unwrap();
        assert!(reason.contains("treated as auto"), "reason={reason}");
        assert!(reason.contains("no CUDA/DirectML"), "reason={reason}");
        assert!(!reason.contains("used the CPU"), "reason={reason}");

        let known = annotate_unknown_device(
            crate::studio::onnx_pool::resolve_provider(OnnxDeviceRequest::Gpu),
            "gpu",
        );
        assert!(!known
            .fallback_reason
            .as_deref()
            .unwrap()
            .contains("unknown ONNX device"));
    }

    #[test]
    fn preprocessing_fixes_the_low_resolution_branch_and_sanitizes_hidden_rgb() {
        let subject = RgbaImage::from_pixel(4, 1, Rgba([20, 30, 40, 0]));
        let mut background = RgbaImage::new(2, 1);
        background.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        background.put_pixel(1, 0, Rgba([0, 0, 255, 0]));

        let prepared = prepare_inputs(&subject, &background, &[0.0; 4]).unwrap();
        assert_eq!(prepared.image_lr.len(), 3 * 256 * 256);
        assert_eq!(prepared.mask_lr.len(), 256 * 256);
        assert_eq!(
            prepared.image_fullres,
            [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        );
        assert_eq!(prepared.mask_fullres, [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn fully_transparent_background_is_not_fed_to_the_model() {
        let subject = RgbaImage::from_pixel(2, 2, Rgba([20, 30, 40, 255]));
        let background = RgbaImage::from_pixel(2, 2, Rgba([200, 10, 240, 0]));
        let error = prepare_inputs(&subject, &background, &[0.0; 4]).unwrap_err();
        assert!(error.contains("no visible pixels"), "{error}");
    }

    #[test]
    fn opaque_subject_without_a_mask_falls_back_before_inference() {
        let subject = RgbaImage::from_pixel(16, 16, Rgba([20, 30, 40, 255]));
        let background = RgbaImage::from_pixel(16, 16, Rgba([200, 100, 50, 255]));
        let error = prepare_inputs(&subject, &background, &[1.0; 16 * 16]).unwrap_err();
        assert!(error.contains("exposes background context"), "{error}");
    }

    #[test]
    fn nchw_shape_validation_accepts_only_matching_or_dynamic_axes() {
        assert!(validate_nchw_shape(&[1, 3, -1, -1], 3, 256, 256, "image_lr").is_ok());
        assert!(validate_nchw_shape(&[1, 3, 256, 256], 3, 256, 256, "image_lr").is_ok());
        assert!(validate_nchw_shape(&[1, 256, 256, 3], 3, 256, 256, "image_lr").is_err());
        assert!(validate_nchw_shape(&[1, 1, 256, 256], 3, 256, 256, "image_lr").is_err());
    }

    #[test]
    fn output_decoder_converts_chw_and_rejects_non_finite_values() {
        let subject = RgbaImage::from_pixel(2, 1, Rgba([7, 8, 9, 255]));
        let background = RgbImage::from_pixel(2, 1, Rgb([0, 0, 0]));
        let matte = GrayImage::from_pixel(2, 1, Luma([255]));
        let values = [0.0_f32, 1.0, 0.25, 0.75, 0.5, 0.1];
        let decoded = decode_output(&values, &[1, 3, 1, 2], &subject, &background, &matte).unwrap();
        let expected = [0.0, 63.75, 127.5, 255.0, 191.25, 25.5];
        assert!(decoded
            .iter()
            .zip(expected)
            .all(|(&actual, expected)| (actual - expected).abs() < 1e-5));

        let one_subject = RgbaImage::from_pixel(1, 1, Rgba([1, 2, 3, 255]));
        let one_background = RgbImage::from_pixel(1, 1, Rgb([0, 0, 0]));
        let one_matte = GrayImage::from_pixel(1, 1, Luma([255]));
        let error = decode_output(
            &[f32::NAN; 3],
            &[1, 3, 1, 1],
            &one_subject,
            &one_background,
            &one_matte,
        )
        .unwrap_err();
        assert!(error.contains("invalid value"), "{error}");
        let error = decode_output(
            &[1.01; 3],
            &[1, 3, 1, 1],
            &one_subject,
            &one_background,
            &one_matte,
        )
        .unwrap_err();
        assert!(error.contains("invalid value"), "{error}");
    }

    #[test]
    fn output_decoder_recovers_straight_rgb_at_a_soft_matte_edge() {
        let subject = RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 128]));
        let background = RgbImage::from_pixel(1, 1, Rgb([204, 51, 102]));
        let matte = GrayImage::from_pixel(1, 1, Luma([128]));
        let alpha = 128.0_f32 / 255.0;
        let desired = [0.2_f32, 0.4, 0.6];
        let bg = [0.8_f32, 0.2, 0.4];
        let composite = [
            desired[0] * alpha + bg[0] * (1.0 - alpha),
            desired[1] * alpha + bg[1] * (1.0 - alpha),
            desired[2] * alpha + bg[2] * (1.0 - alpha),
        ];
        let decoded =
            decode_output(&composite, &[1, 3, 1, 1], &subject, &background, &matte).unwrap();
        assert!(decoded
            .iter()
            .zip([51.0, 102.0, 153.0])
            .all(|(&actual, expected)| (actual - expected).abs() < 1e-3));

        let transparent = GrayImage::from_pixel(1, 1, Luma([0]));
        let decoded =
            decode_output(&bg, &[1, 3, 1, 1], &subject, &background, &transparent).unwrap();
        assert_eq!(decoded, [10.0, 20.0, 30.0]);
    }

    #[test]
    fn full_resolution_resource_limit_is_explicit() {
        assert!(validate_surface_size(2560, 1440, "subject").is_ok());
        assert!(validate_surface_size(2048, 2048, "subject").is_ok());
        assert!(validate_surface_size(3840, 2160, "subject").is_err());
        assert!(validate_surface_size(4097, 1, "background").is_err());
        assert!(validate_surface_size(0, 1, "subject").is_err());
    }
}
