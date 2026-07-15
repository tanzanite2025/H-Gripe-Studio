//! Native Real-ESRGAN adapter for the opt-in `realesrgan` Image Enhance engine.
//!
//! The supported weight is the FP32 `realesr-general-x4v3` ONNX export
//! documented in `resources/models/README.md`: one named float32 NCHW RGB input
//! (`input`) in `[0, 1]` and one named 4x RGB output (`output`). Large sources
//! are split into padded tiles so model activation memory stays bounded. The
//! padded halo is discarded in output space; the assembled native 4x result is
//! then resampled once to the card's exact requested geometry.

use std::path::{Path, PathBuf};

use image::{Rgb, RgbImage};
use ort::value::{Tensor, TensorElementType};

use super::onnx_pool::{cached_session, OnnxDeviceRequest, OnnxProviderResolution};

pub(crate) const MODEL_FILE: &str = "realesrgan_x4v3.onnx";
const MODEL_ENV: &str = "HGRIPE_REALESRGAN_MODEL";
const MODEL_ENGINE: &str = "realesrgan";
const MODEL_SCALE: u32 = 4;
const TILE_EDGE: u32 = 128;
const TILE_PAD: u32 = 16;
// The model always materialises a native 4x RGB surface before the exact-size
// resample. Keep that allocation no larger than the card's default output
// budget; larger sources retain the complete CPU result instead of risking a
// multi-hundred-megabyte intermediate on a normal Windows desktop.
const MAX_NATIVE_OUTPUT_PIXELS: u64 = 48_000_000;
const MAX_OUTPUT_ABS: f32 = 16.0;

pub(crate) struct OnnxUpscaleResult {
    pub(crate) rgb: RgbImage,
    pub(crate) backend_model: String,
    pub(crate) device: String,
    /// Provider downgrade detail. The caller records this in the shared
    /// `engine_fallback_reason` field while retaining a successful model run.
    pub(crate) device_fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tile {
    core_x0: u32,
    core_y0: u32,
    core_x1: u32,
    core_y1: u32,
    context_x0: u32,
    context_y0: u32,
    context_x1: u32,
    context_y1: u32,
}

/// Resolve the trained weight through the shared native-model precedence:
/// process env, persisted override, shared cache, then packaged/development
/// resources.
pub(crate) fn resolve_realesrgan_model_path() -> Option<PathBuf> {
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

/// Run native tiled Real-ESRGAN inference and return an RGB surface at the
/// card's exact target size. Alpha, metadata and the complete CPU fallback stay
/// owned by `image_enhance_cpu`.
pub(crate) fn upscale(
    source: &RgbImage,
    target_width: u32,
    target_height: u32,
    device_requested: &str,
) -> Result<OnnxUpscaleResult, String> {
    validate_geometry(source.width(), source.height(), target_width, target_height)?;
    let path = resolve_realesrgan_model_path().ok_or_else(|| {
        format!(
            "Real-ESRGAN model not found; configure {MODEL_ENGINE}, set {MODEL_ENV}, or install resources/models/{MODEL_FILE}"
        )
    })?;

    let normalized_device = device_requested.trim().to_ascii_lowercase();
    let request = OnnxDeviceRequest::from_param(&normalized_device);
    let shared = cached_session(&path, request)?;
    let mut session = shared
        .lock()
        .map_err(|_| "Real-ESRGAN ONNX session poisoned".to_string())?;
    validate_model_contract(&session)?;

    let native = run_tiled(&mut session, source)?;
    drop(session);
    let rgb = if native.dimensions() == (target_width, target_height) {
        native
    } else {
        let downscaling = target_width < native.width() || target_height < native.height();
        super::image_enhance_cpu::resample_rgb(&native, target_width, target_height, downscaling)
    };

    let resolution = annotate_unknown_device(shared.resolution().clone(), &normalized_device);
    let backend_model = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    Ok(OnnxUpscaleResult {
        rgb,
        backend_model,
        device: resolution.device.to_string(),
        device_fallback_reason: resolution.fallback_reason,
    })
}

fn validate_geometry(
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Result<(), String> {
    if source_width == 0 || source_height == 0 {
        return Err("Real-ESRGAN source cannot be empty".to_string());
    }
    if target_width == 0 || target_height == 0 {
        return Err("Real-ESRGAN target cannot be empty".to_string());
    }
    let native_width = source_width
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN native output width overflowed".to_string())?;
    let native_height = source_height
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN native output height overflowed".to_string())?;
    let native_pixels = u64::from(native_width)
        .checked_mul(u64::from(native_height))
        .ok_or_else(|| "Real-ESRGAN native output pixel count overflowed".to_string())?;
    if native_pixels > MAX_NATIVE_OUTPUT_PIXELS {
        return Err(format!(
            "Real-ESRGAN native 4x surface {native_width}x{native_height} exceeds the {MAX_NATIVE_OUTPUT_PIXELS}-pixel inference budget; kept the complete CPU result"
        ));
    }
    Ok(())
}

fn validate_model_contract(session: &ort::session::Session) -> Result<(), String> {
    if session.inputs().len() != 1 {
        return Err(format!(
            "Real-ESRGAN model must have exactly one input, found {}",
            session.inputs().len()
        ));
    }
    let input = session
        .inputs()
        .iter()
        .find(|input| input.name() == "input")
        .ok_or_else(|| {
            let names: Vec<_> = session.inputs().iter().map(|input| input.name()).collect();
            format!("Real-ESRGAN model has no `input` tensor (found {names:?})")
        })?;
    validate_tensor_type_and_shape(input.dtype(), "input")?;

    if session.outputs().len() != 1 {
        return Err(format!(
            "Real-ESRGAN model must have exactly one output, found {}",
            session.outputs().len()
        ));
    }
    let output = session
        .outputs()
        .iter()
        .find(|output| output.name() == "output")
        .ok_or_else(|| {
            let names: Vec<_> = session
                .outputs()
                .iter()
                .map(|output| output.name())
                .collect();
            format!("Real-ESRGAN model has no `output` tensor (found {names:?})")
        })?;
    validate_tensor_type_and_shape(output.dtype(), "output")
}

fn validate_tensor_type_and_shape(
    value_type: &ort::value::ValueType,
    name: &str,
) -> Result<(), String> {
    if value_type.tensor_type() != Some(TensorElementType::Float32) {
        return Err(format!(
            "Real-ESRGAN `{name}` must be float32, found {:?}",
            value_type.tensor_type()
        ));
    }
    let shape = value_type
        .tensor_shape()
        .ok_or_else(|| format!("Real-ESRGAN `{name}` is not a tensor"))?;
    validate_nchw_shape(shape, name)
}

fn validate_nchw_shape(shape: &[i64], name: &str) -> Result<(), String> {
    let compatible = shape.len() == 4
        && matches!(shape[0], -1 | 1)
        && shape[1] == 3
        && (shape[2] == -1 || shape[2] > 0)
        && (shape[3] == -1 || shape[3] > 0);
    if compatible {
        Ok(())
    } else {
        Err(format!(
            "Real-ESRGAN `{name}` shape {shape:?} is incompatible with float32 NCHW [1,3,H,W]"
        ))
    }
}

fn run_tiled(session: &mut ort::session::Session, source: &RgbImage) -> Result<RgbImage, String> {
    let native_width = source
        .width()
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN output width overflowed".to_string())?;
    let native_height = source
        .height()
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN output height overflowed".to_string())?;
    let mut assembled = RgbImage::new(native_width, native_height);

    for tile in tiles(source.width(), source.height()) {
        let context_width = tile.context_x1 - tile.context_x0;
        let context_height = tile.context_y1 - tile.context_y0;
        let packed = pack_context(source, tile);
        let tensor = Tensor::from_array((
            vec![
                1_i64,
                3,
                i64::from(context_height),
                i64::from(context_width),
            ],
            packed,
        ))
        .map_err(|err| format!("failed to build Real-ESRGAN `input`: {err}"))?;
        let outputs = session
            .run(ort::inputs!["input" => tensor])
            .map_err(|err| format!("Real-ESRGAN inference failed: {err}"))?;
        let output = outputs
            .get("output")
            .ok_or_else(|| "Real-ESRGAN model returned no `output` tensor".to_string())?;
        let (shape, values) = output
            .try_extract_tensor::<f32>()
            .map_err(|err| format!("failed to read Real-ESRGAN `output`: {err}"))?;
        copy_core(&mut assembled, tile, shape, values)?;
    }
    Ok(assembled)
}

fn tiles(width: u32, height: u32) -> Vec<Tile> {
    let mut result = Vec::new();
    let mut core_y0 = 0;
    while core_y0 < height {
        let core_y1 = core_y0.saturating_add(TILE_EDGE).min(height);
        let mut core_x0 = 0;
        while core_x0 < width {
            let core_x1 = core_x0.saturating_add(TILE_EDGE).min(width);
            result.push(Tile {
                core_x0,
                core_y0,
                core_x1,
                core_y1,
                context_x0: core_x0.saturating_sub(TILE_PAD),
                context_y0: core_y0.saturating_sub(TILE_PAD),
                context_x1: core_x1.saturating_add(TILE_PAD).min(width),
                context_y1: core_y1.saturating_add(TILE_PAD).min(height),
            });
            core_x0 = core_x1;
        }
        core_y0 = core_y1;
    }
    result
}

fn pack_context(source: &RgbImage, tile: Tile) -> Vec<f32> {
    let width = tile.context_x1 - tile.context_x0;
    let height = tile.context_y1 - tile.context_y0;
    let plane = (width as usize) * (height as usize);
    let mut packed = vec![0.0_f32; plane * 3];
    for y in tile.context_y0..tile.context_y1 {
        for x in tile.context_x0..tile.context_x1 {
            let local = ((y - tile.context_y0) as usize) * (width as usize)
                + (x - tile.context_x0) as usize;
            let pixel = source.get_pixel(x, y).0;
            for channel in 0..3 {
                packed[channel * plane + local] = f32::from(pixel[channel]) / 255.0;
            }
        }
    }
    packed
}

fn copy_core(
    assembled: &mut RgbImage,
    tile: Tile,
    shape: &[i64],
    values: &[f32],
) -> Result<(), String> {
    let context_width = tile.context_x1 - tile.context_x0;
    let context_height = tile.context_y1 - tile.context_y0;
    let output_width = context_width
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN tile output width overflowed".to_string())?;
    let output_height = context_height
        .checked_mul(MODEL_SCALE)
        .ok_or_else(|| "Real-ESRGAN tile output height overflowed".to_string())?;
    let expected_shape = [1_i64, 3, i64::from(output_height), i64::from(output_width)];
    let plane = (output_width as usize)
        .checked_mul(output_height as usize)
        .ok_or_else(|| "Real-ESRGAN tile output size overflowed".to_string())?;
    let expected_len = plane
        .checked_mul(3)
        .ok_or_else(|| "Real-ESRGAN tile output length overflowed".to_string())?;
    if shape != expected_shape || values.len() != expected_len {
        return Err(format!(
            "Real-ESRGAN `output` shape {shape:?} / length {} does not match {expected_shape:?}",
            values.len()
        ));
    }
    if let Some((index, value)) = values
        .iter()
        .copied()
        .enumerate()
        .find(|(_, value)| !value.is_finite() || value.abs() > MAX_OUTPUT_ABS)
    {
        return Err(format!(
            "Real-ESRGAN `output` contains invalid value {value} at index {index}"
        ));
    }

    let core_width = (tile.core_x1 - tile.core_x0) * MODEL_SCALE;
    let core_height = (tile.core_y1 - tile.core_y0) * MODEL_SCALE;
    let source_x0 = (tile.core_x0 - tile.context_x0) * MODEL_SCALE;
    let source_y0 = (tile.core_y0 - tile.context_y0) * MODEL_SCALE;
    let destination_x0 = tile.core_x0 * MODEL_SCALE;
    let destination_y0 = tile.core_y0 * MODEL_SCALE;
    for y in 0..core_height {
        for x in 0..core_width {
            let source_index =
                ((source_y0 + y) as usize) * (output_width as usize) + (source_x0 + x) as usize;
            let mut pixel = [0_u8; 3];
            for channel in 0..3 {
                pixel[channel] =
                    (values[channel * plane + source_index].clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            assembled.put_pixel(destination_x0 + x, destination_y0 + y, Rgb(pixel));
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_grid_covers_the_source_once_and_adds_bounded_context() {
        let grid = tiles(300, 270);
        assert_eq!(grid.len(), 9);
        let mut coverage = vec![0_u8; 300 * 270];
        for tile in grid {
            assert!(tile.context_x0 <= tile.core_x0);
            assert!(tile.context_y0 <= tile.core_y0);
            assert!(tile.context_x1 >= tile.core_x1 && tile.context_x1 <= 300);
            assert!(tile.context_y1 >= tile.core_y1 && tile.context_y1 <= 270);
            for y in tile.core_y0..tile.core_y1 {
                for x in tile.core_x0..tile.core_x1 {
                    coverage[y as usize * 300 + x as usize] += 1;
                }
            }
        }
        assert!(coverage.iter().all(|count| *count == 1));
    }

    #[test]
    fn context_packing_is_rgb_nchw_in_zero_one_range() {
        let mut source = RgbImage::new(2, 1);
        source.put_pixel(0, 0, Rgb([255, 128, 0]));
        source.put_pixel(1, 0, Rgb([64, 32, 16]));
        let tile = tiles(2, 1)[0];
        let packed = pack_context(&source, tile);
        assert_eq!(packed.len(), 6);
        assert_eq!(packed[0], 1.0);
        assert!((packed[1] - 64.0 / 255.0).abs() < 1e-6);
        assert!((packed[2] - 128.0 / 255.0).abs() < 1e-6);
        assert!((packed[3] - 32.0 / 255.0).abs() < 1e-6);
        assert_eq!(packed[4], 0.0);
        assert!((packed[5] - 16.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn core_copy_discards_the_context_halo() {
        let tile = Tile {
            core_x0: 1,
            core_y0: 0,
            core_x1: 2,
            core_y1: 1,
            context_x0: 0,
            context_y0: 0,
            context_x1: 2,
            context_y1: 1,
        };
        let width = 8_usize;
        let height = 4_usize;
        let plane = width * height;
        let mut values = vec![0.0_f32; plane * 3];
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                values[index] = x as f32 / 7.0;
                values[plane + index] = y as f32 / 3.0;
                values[2 * plane + index] = 0.5;
            }
        }
        let mut assembled = RgbImage::new(8, 4);
        copy_core(&mut assembled, tile, &[1, 3, 4, 8], &values).unwrap();
        assert_eq!(assembled.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(assembled.get_pixel(4, 0).0, [146, 0, 128]);
        assert_eq!(assembled.get_pixel(7, 3).0, [255, 255, 128]);
    }

    #[test]
    fn malformed_shapes_and_values_are_rejected() {
        assert!(validate_nchw_shape(&[1, 3, -1, -1], "input").is_ok());
        assert!(validate_nchw_shape(&[1, 3, 64, 64], "input").is_ok());
        assert!(validate_nchw_shape(&[1, 3, -2, -1], "input").is_err());
        assert!(validate_nchw_shape(&[1, 4, -1, -1], "input").is_err());
        assert!(validate_nchw_shape(&[3, -1, -1], "input").is_err());

        let tile = tiles(1, 1)[0];
        let mut assembled = RgbImage::new(4, 4);
        let mut values = vec![0.0_f32; 3 * 4 * 4];
        values[7] = f32::NAN;
        let err = copy_core(&mut assembled, tile, &[1, 3, 4, 4], &values).unwrap_err();
        assert!(err.contains("invalid value"), "{err}");
        values[7] = 0.0;
        let err = copy_core(&mut assembled, tile, &[1, 3, 2, 8], &values).unwrap_err();
        assert!(err.contains("does not match"), "{err}");
    }

    #[test]
    fn native_surface_budget_is_checked_before_session_resolution() {
        assert!(validate_geometry(100, 100, 200, 200).is_ok());
        let err = validate_geometry(4_000, 4_000, 8_000, 8_000).unwrap_err();
        assert!(err.contains("inference budget"), "{err}");
    }
}
