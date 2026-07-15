//! Native ONNX semantic-defect detector for the Detail Watchdog card.
//!
//! This module is deliberately an opt-in layer over the always-on rule detector
//! in [`super::detail_watchdog_cpu`].  It ports the historical `onnx_defect`
//! contract without bringing the deleted Python runtime back into the product:
//! one RGB NCHW tensor, named (or positional) box outputs, and DB-style
//! probability-map outputs.  Model loading uses the process-wide ONNX session
//! pool so a detector weight is parsed only once per process.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use image::{imageops::FilterType, RgbaImage};
use ort::value::{DynValue, Tensor, TensorElementType};
use serde_json::Value;

use super::onnx_pool::{cached_session, resolve_provider, OnnxDeviceRequest};
use crate::contracts::QualityIssue;

const MODEL_FILE: &str = "watchdog_defect.onnx";
const MODEL_ENV: &str = "HGRIPE_WATCHDOG_MODEL";
const MODEL_ENGINE: &str = "onnx_defect";
const DEFAULT_INPUT_EDGE: i64 = 640;
const SCORE_FLOOR: f32 = 0.35;
const PROBABILITY_THRESHOLD: f32 = 0.30;
const MAX_INPUT_EDGE: i64 = 2048;
const MAX_TENSOR_ELEMENTS: usize = 2048 * 2048 * 3;
const MAX_PROBABILITY_MAP_ELEMENTS: usize = 2048 * 2048;
const MAX_DETECTIONS: usize = 100_000;
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const TARGETS: [&str; 3] = ["hands", "text", "logo"];

const ISSUE_TYPES: [(&str, &str); 3] = [
    ("hands", "malformed_hands"),
    ("text", "garbled_text"),
    ("logo", "deformed_logo"),
];

/// The successful native detector result consumed by the watchdog executor.
#[derive(Debug, Clone)]
pub(crate) struct OnnxDefectResult {
    pub(crate) issues: Vec<QualityIssue>,
    /// Semantic targets covered by the loaded weight, intersected with the
    /// targets requested for this run.  Uncovered targets remain `skipped`.
    pub(crate) covered_targets: BTreeSet<String>,
    pub(crate) backend_model: String,
    pub(crate) device: String,
    /// Provider downgrade detail.  The caller records this in the shared
    /// `engine_fallback_reason` field while keeping a successful detector run.
    pub(crate) device_fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Sidecar {
    labels: BTreeMap<i64, String>,
    normalize_imagenet: bool,
}

#[derive(Debug, Clone)]
struct Letterbox {
    tensor: Vec<f32>,
    scale: f32,
    pad_x: f32,
    pad_y: f32,
    net_w: i64,
    net_h: i64,
}

#[derive(Debug, Clone)]
struct Detection {
    box_xyxy: [f32; 4],
    score: f32,
    label: i64,
}

/// Resolve `watchdog_defect.onnx` using the same precedence as the former
/// backend: process env, persisted model-path override, shared cache, then the
/// bundled/executable/in-repo resource locations.
pub(crate) fn resolve_watchdog_model_path() -> Option<PathBuf> {
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
        .filter(|value| !value.trim().is_empty());
    for cache in [env_cache.as_deref(), config.model_cache_dir.as_deref()]
        .into_iter()
        .flatten()
    {
        let candidate = Path::new(cache.trim()).join(MODEL_FILE);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // `resolve_model_file` covers the captured Tauri resource dir, the
    // executable's resources directory, and the checkout's resources/models.
    super::subject_model::resolve_model_file(MODEL_ENV, MODEL_FILE)
}

/// Run the learned detector on an 8-bit RGBA image.  The alpha channel is
/// intentionally ignored: the semantic model contract is RGB-only, while the
/// rule layer owns alpha-rim detection.
pub(crate) fn detect(
    image: &RgbaImage,
    watch: &BTreeSet<String>,
    device_requested: &str,
) -> Result<OnnxDefectResult, String> {
    let path = resolve_watchdog_model_path().ok_or_else(|| {
        format!(
            "watchdog defect model not found; configure {MODEL_ENGINE}, set {MODEL_ENV}, or install resources/models/{MODEL_FILE}"
        )
    })?;
    let sidecar = read_sidecar(&path);
    let session = cached_session(&path)?;
    let mut session = session
        .lock()
        .map_err(|_| "watchdog defect ONNX session poisoned".to_string())?;

    let input = session
        .inputs()
        .first()
        .ok_or_else(|| "watchdog defect model has no inputs".to_string())?;
    if session.inputs().len() != 1 {
        return Err(format!(
            "watchdog defect model must have exactly one input, found {}",
            session.inputs().len()
        ));
    }
    if input.dtype().tensor_type() != Some(TensorElementType::Float32) {
        return Err(format!(
            "watchdog defect input `{}` must be float32, found {:?}",
            input.name(),
            input.dtype().tensor_type()
        ));
    }
    let input_shape = input
        .dtype()
        .tensor_shape()
        .ok_or_else(|| "watchdog defect input is not a tensor".to_string())?;
    let (net_h, net_w) = input_spatial_shape(input_shape)?;
    let mut prepared = letterbox(image, net_w, net_h, sidecar.normalize_imagenet)?;
    let input_name = input.name().to_string();
    let output_names: Vec<String> = session
        .outputs()
        .iter()
        .map(|output| output.name().to_string())
        .collect();
    if output_names.is_empty() {
        return Err("watchdog defect model has no outputs".to_string());
    }

    let tensor_data = std::mem::take(&mut prepared.tensor);
    let tensor = Tensor::from_array((vec![1_i64, 3, prepared.net_h, prepared.net_w], tensor_data))
        .map_err(|err| format!("failed to build watchdog defect input: {err}"))?;
    let outputs = session
        .run(ort::inputs![input_name => tensor])
        .map_err(|err| format!("watchdog defect inference failed: {err}"))?;

    let detections = decode_outputs(&outputs, &output_names, net_w, net_h)?;
    let mut issues = Vec::new();
    for detection in detections {
        if !detection.score.is_finite() || detection.score < SCORE_FLOOR {
            continue;
        }
        let Some(target) = sidecar.labels.get(&detection.label) else {
            continue;
        };
        if !TARGETS.contains(&target.as_str()) || !watch.contains(target) {
            continue;
        }
        let bbox = undo_letterbox(detection.box_xyxy, &prepared, image.width(), image.height());
        if bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            continue;
        }
        let issue_type = ISSUE_TYPES
            .iter()
            .find_map(|(name, issue)| (*name == target).then_some(*issue))
            .unwrap_or(target.as_str());
        issues.push(QualityIssue {
            issue_type: issue_type.to_string(),
            confidence: (f64::from(detection.score.min(0.99)) * 100.0).round() / 100.0,
            bbox,
            suggested_action: "detail_redraw".to_string(),
        });
    }

    let covered_targets = sidecar
        .labels
        .values()
        .filter(|target| TARGETS.contains(&target.as_str()) && watch.contains(*target))
        .cloned()
        .collect();
    let resolution = resolve_provider(OnnxDeviceRequest::from_param(device_requested));
    let backend_model = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());

    Ok(OnnxDefectResult {
        issues,
        covered_targets,
        backend_model,
        device: resolution.device.to_string(),
        device_fallback_reason: resolution.fallback_reason,
    })
}

fn env_file(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| existing_file(&value))
}

fn existing_file(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw.trim());
    path.is_file().then_some(path)
}

fn sidecar_path(weight: &Path) -> PathBuf {
    let mut name = weight
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from(MODEL_FILE));
    name.push(".labels.json");
    weight.with_file_name(name)
}

fn read_sidecar(weight: &Path) -> Sidecar {
    let fallback = || Sidecar {
        labels: TARGETS
            .iter()
            .enumerate()
            .map(|(index, target)| (index as i64, (*target).to_string()))
            .collect(),
        normalize_imagenet: false,
    };
    let path = sidecar_path(weight);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return fallback();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return fallback();
    };
    let (labels_value, normalize) = match value {
        Value::Object(mut object) => {
            let normalize = object
                .remove("normalize")
                .and_then(|value| {
                    value
                        .as_str()
                        .map(|text| text.eq_ignore_ascii_case("imagenet"))
                })
                .unwrap_or(false);
            let labels = object.remove("labels").unwrap_or(Value::Object(object));
            (labels, normalize)
        }
        _ => (Value::Null, false),
    };
    let mut labels = BTreeMap::new();
    if let Value::Object(entries) = labels_value {
        for (key, value) in entries {
            let Ok(class_id) = key.parse::<i64>() else {
                continue;
            };
            let Some(target) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            labels.insert(class_id, target.to_string());
        }
    }
    if labels.is_empty() {
        let mut result = fallback();
        result.normalize_imagenet = normalize;
        result
    } else {
        Sidecar {
            labels,
            normalize_imagenet: normalize,
        }
    }
}

fn input_spatial_shape(shape: &[i64]) -> Result<(i64, i64), String> {
    if shape.len() != 4 {
        return Err(format!(
            "watchdog defect input shape {shape:?} is not NCHW rank 4"
        ));
    }
    for (index, dimension) in shape.iter().enumerate().take(2) {
        if *dimension == 0 || *dimension < -1 {
            return Err(format!(
                "watchdog defect input shape {shape:?} has invalid dimension {dimension}"
            ));
        }
        if *dimension > 0 && !(index == 0 && *dimension == 1 || index == 1 && *dimension == 3) {
            return Err(format!(
                "watchdog defect input shape {shape:?} must have batch 1 and channels 3"
            ));
        }
    }
    let h = checked_dimension(shape[2], "height")?;
    let w = checked_dimension(shape[3], "width")?;
    let elements = (h as usize)
        .checked_mul(w as usize)
        .and_then(|value| value.checked_mul(3))
        .ok_or_else(|| "watchdog defect input tensor size overflows usize".to_string())?;
    if elements > MAX_TENSOR_ELEMENTS {
        return Err(format!(
            "watchdog defect input tensor is too large ({h}x{w})"
        ));
    }
    Ok((h, w))
}

fn checked_dimension(value: i64, label: &str) -> Result<i64, String> {
    if value == 0 || value < -1 {
        return Err(format!(
            "watchdog defect input {label} dimension {value} is invalid"
        ));
    }
    let resolved = if value == -1 {
        DEFAULT_INPUT_EDGE
    } else {
        value
    };
    if resolved > MAX_INPUT_EDGE {
        return Err(format!(
            "watchdog defect input {label} dimension {resolved} exceeds {MAX_INPUT_EDGE}"
        ));
    }
    Ok(resolved)
}

fn letterbox(
    image: &RgbaImage,
    net_w: i64,
    net_h: i64,
    normalize_imagenet: bool,
) -> Result<Letterbox, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("watchdog defect cannot process an empty image".to_string());
    }
    let src_w = image.width() as f32;
    let src_h = image.height() as f32;
    let scale = (net_w as f32 / src_w).min(net_h as f32 / src_h);
    if !scale.is_finite() || scale <= 0.0 {
        return Err("watchdog defect letterbox scale is invalid".to_string());
    }
    let new_w = (src_w * scale).round().clamp(1.0, net_w as f32) as u32;
    let new_h = (src_h * scale).round().clamp(1.0, net_h as f32) as u32;
    let resized = image::imageops::resize(image, new_w, new_h, FilterType::Triangle);
    let pad_x = ((net_w as u32).saturating_sub(new_w) / 2) as usize;
    let pad_y = ((net_h as u32).saturating_sub(new_h) / 2) as usize;
    let width = net_w as usize;
    let height = net_h as usize;
    let plane = width
        .checked_mul(height)
        .ok_or_else(|| "watchdog defect input plane size overflows usize".to_string())?;
    let mut chw = vec![0.0_f32; plane * 3];
    if normalize_imagenet {
        for channel in 0..3 {
            chw[channel * plane..(channel + 1) * plane]
                .fill(-IMAGENET_MEAN[channel] / IMAGENET_STD[channel]);
        }
    }
    for (y, row) in resized.rows().enumerate() {
        for (x, pixel) in row.enumerate() {
            let dst = (y + pad_y) * width + x + pad_x;
            for channel in 0..3 {
                let mut value = f32::from(pixel.0[channel]) / 255.0;
                if normalize_imagenet {
                    value = (value - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel];
                }
                chw[channel * plane + dst] = value;
            }
        }
    }
    Ok(Letterbox {
        tensor: chw,
        scale,
        pad_x: pad_x as f32,
        pad_y: pad_y as f32,
        net_w,
        net_h,
    })
}

fn decode_outputs(
    outputs: &ort::session::SessionOutputs<'_>,
    names: &[String],
    net_w: i64,
    net_h: i64,
) -> Result<Vec<Detection>, String> {
    if names.len() == 1 {
        let value = outputs
            .get(&names[0])
            .ok_or_else(|| "watchdog defect output disappeared after inference".to_string())?;
        if let Some((shape, data)) = extract_f32(value) {
            if shape.len() == 4 && shape[0] == 1 && shape[1] == 1 {
                return decode_probability_map(&shape, &data, net_w, net_h);
            }
        }
    }

    let boxes_index = find_output(names, &["box"]);
    let scores_index = find_output(names, &["score", "conf"]);
    let labels_index = find_output(names, &["label", "class"]);
    let boxes_index = boxes_index.or((!names.is_empty()).then_some(0));
    let boxes = boxes_index
        .and_then(|index| names.get(index))
        .and_then(|name| outputs.get(name))
        .ok_or_else(|| "watchdog defect model has no box output".to_string())?;
    let (box_shape, box_data) = extract_f32_required(boxes, "boxes")?;
    let scores = if let Some(index) = scores_index.or((names.len() >= 2).then_some(1)) {
        let value = outputs
            .get(&names[index])
            .ok_or_else(|| "watchdog defect scores output disappeared".to_string())?;
        Some(extract_f32_required(value, "scores")?)
    } else {
        None
    };
    let labels = if let Some(index) = labels_index.or((names.len() >= 3).then_some(2)) {
        let value = outputs
            .get(&names[index])
            .ok_or_else(|| "watchdog defect labels output disappeared".to_string())?;
        Some(extract_labels_required(value)?)
    } else {
        None
    };

    decode_box_tensors(
        (&box_shape, &box_data),
        scores
            .as_ref()
            .map(|(shape, data)| (shape.as_slice(), data.as_slice())),
        labels
            .as_ref()
            .map(|(shape, data)| (shape.as_slice(), data.as_slice())),
    )
}

fn decode_box_tensors(
    boxes: (&[i64], &[f32]),
    scores: Option<(&[i64], &[f32])>,
    labels: Option<(&[i64], &[i64])>,
) -> Result<Vec<Detection>, String> {
    let (box_shape, box_data) = boxes;
    let count = match box_shape {
        [count, 4] if *count >= 0 => *count as usize,
        _ => {
            return Err(format!(
                "watchdog defect boxes output shape {box_shape:?} must be [N,4]"
            ))
        }
    };
    if count > MAX_DETECTIONS {
        return Err(format!(
            "watchdog defect boxes output has too many detections ({count} > {MAX_DETECTIONS})"
        ));
    }
    if box_data.len() != count.saturating_mul(4) {
        return Err(format!(
            "watchdog defect boxes output shape {box_shape:?} disagrees with length {}",
            box_data.len(),
        ));
    }
    if let Some((shape, data)) = scores {
        if shape != [count as i64] || data.len() != count {
            return Err(format!(
                "watchdog defect scores output shape {shape:?} / length {} must be [{count}]",
                data.len()
            ));
        }
    }
    if let Some((shape, data)) = labels {
        if shape != [count as i64] || data.len() != count {
            return Err(format!(
                "watchdog defect labels output shape {shape:?} / length {} must be [{count}]",
                data.len()
            ));
        }
    }
    let mut detections = Vec::with_capacity(count);
    for index in 0..count {
        let base = index * 4;
        let box_xyxy = [
            box_data[base],
            box_data[base + 1],
            box_data[base + 2],
            box_data[base + 3],
        ];
        let score = scores.map(|(_, data)| data[index]).unwrap_or(1.0);
        if !box_xyxy.iter().all(|value| value.is_finite()) || !score.is_finite() {
            return Err("watchdog defect output contains NaN or infinity".to_string());
        }
        detections.push(Detection {
            box_xyxy,
            score,
            label: labels.map(|(_, data)| data[index]).unwrap_or(0),
        });
    }
    Ok(detections)
}

fn find_output(names: &[String], needles: &[&str]) -> Option<usize> {
    names.iter().position(|name| {
        let lower = name.to_ascii_lowercase();
        needles.iter().any(|needle| lower.contains(needle))
    })
}

fn extract_f32(value: &DynValue) -> Option<(Vec<i64>, Vec<f32>)> {
    if value.dtype().tensor_type() != Some(TensorElementType::Float32) {
        return None;
    }
    let (shape, data) = value.try_extract_tensor::<f32>().ok()?;
    Some((shape.to_vec(), data.to_vec()))
}

fn extract_f32_required(value: &DynValue, label: &str) -> Result<(Vec<i64>, Vec<f32>), String> {
    extract_f32(value).ok_or_else(|| {
        format!(
            "watchdog defect {label} output must be a float32 tensor, found {:?}",
            value.dtype().tensor_type()
        )
    })
}

fn extract_labels_required(value: &DynValue) -> Result<(Vec<i64>, Vec<i64>), String> {
    let Some(element_type) = value.dtype().tensor_type() else {
        return Err("watchdog defect labels output is not a tensor".to_string());
    };
    match element_type {
        TensorElementType::Int64 => value
            .try_extract_tensor::<i64>()
            .map(|(shape, data)| (shape.to_vec(), data.to_vec()))
            .map_err(|err| format!("failed to read watchdog defect labels: {err}")),
        TensorElementType::Int32 => value
            .try_extract_tensor::<i32>()
            .map(|(shape, data)| {
                (
                    shape.to_vec(),
                    data.iter().map(|&item| i64::from(item)).collect(),
                )
            })
            .map_err(|err| format!("failed to read watchdog defect labels: {err}")),
        other => Err(format!(
            "watchdog defect labels output must be int64/int32, found {other}"
        )),
    }
}

fn decode_probability_map(
    shape: &[i64],
    data: &[f32],
    net_w: i64,
    net_h: i64,
) -> Result<Vec<Detection>, String> {
    if shape.len() != 4 || shape[0] != 1 || shape[1] != 1 || shape[2] <= 0 || shape[3] <= 0 {
        return Err(format!(
            "watchdog defect probability map shape {shape:?} must be [1,1,H,W]"
        ));
    }
    let height = shape[2] as usize;
    let width = shape[3] as usize;
    let elements = height
        .checked_mul(width)
        .ok_or_else(|| "watchdog defect probability map size overflows usize".to_string())?;
    if elements > MAX_PROBABILITY_MAP_ELEMENTS {
        return Err(format!(
            "watchdog defect probability map is too large ({height}x{width})"
        ));
    }
    if data.len() != elements {
        return Err("watchdog defect probability map data length does not match shape".to_string());
    }
    if data
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
    {
        return Err(
            "watchdog defect probability map contains a non-finite or out-of-range value"
                .to_string(),
        );
    }
    let mut visited = vec![false; data.len()];
    let mut detections = Vec::new();
    for seed_y in 0..height {
        for seed_x in 0..width {
            let seed = seed_y * width + seed_x;
            if visited[seed] || data[seed] < PROBABILITY_THRESHOLD {
                continue;
            }
            visited[seed] = true;
            let mut queue = VecDeque::from([(seed_x, seed_y)]);
            let mut min_x = seed_x;
            let mut max_x = seed_x;
            let mut min_y = seed_y;
            let mut max_y = seed_y;
            let mut total = 0.0_f32;
            let mut count = 0usize;
            while let Some((x, y)) = queue.pop_front() {
                let index = y * width + x;
                total += data[index];
                count += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                for (nx, ny) in [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ] {
                    if nx >= width || ny >= height {
                        continue;
                    }
                    let next = ny * width + nx;
                    if !visited[next] && data[next] >= PROBABILITY_THRESHOLD {
                        visited[next] = true;
                        queue.push_back((nx, ny));
                    }
                }
            }
            let scale_x = net_w as f32 / width as f32;
            let scale_y = net_h as f32 / height as f32;
            detections.push(Detection {
                box_xyxy: [
                    min_x as f32 * scale_x,
                    min_y as f32 * scale_y,
                    (max_x + 1) as f32 * scale_x,
                    (max_y + 1) as f32 * scale_y,
                ],
                score: total / count.max(1) as f32,
                label: 0,
            });
        }
    }
    Ok(detections)
}

fn undo_letterbox(box_xyxy: [f32; 4], prepared: &Letterbox, width: u32, height: u32) -> [i64; 4] {
    let clamp_x = |value: f32| value.max(0.0).min(width as f32).round() as i64;
    let clamp_y = |value: f32| value.max(0.0).min(height as f32).round() as i64;
    [
        clamp_x((box_xyxy[0] - prepared.pad_x) / prepared.scale),
        clamp_y((box_xyxy[1] - prepared.pad_y) / prepared.scale),
        clamp_x((box_xyxy[2] - prepared.pad_x) / prepared.scale),
        clamp_y((box_xyxy[3] - prepared.pad_y) / prepared.scale),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::fs;

    #[test]
    fn sidecar_defaults_to_target_order() {
        let path = std::env::temp_dir().join(format!(
            "hgripe_watchdog_sidecar_{}.onnx",
            std::process::id()
        ));
        let sidecar = sidecar_path(&path);
        let _ = fs::remove_file(&sidecar);
        let parsed = read_sidecar(&path);
        assert_eq!(parsed.labels.get(&0).map(String::as_str), Some("hands"));
        assert_eq!(parsed.labels.get(&2).map(String::as_str), Some("logo"));
    }

    #[test]
    fn sidecar_object_form_selects_imagenet_normalisation() {
        let path = std::env::temp_dir().join(format!(
            "hgripe_watchdog_sidecar_object_{}.onnx",
            std::process::id()
        ));
        let sidecar = sidecar_path(&path);
        fs::write(
            &sidecar,
            r#"{"labels":{"0":"text"},"normalize":"imagenet"}"#,
        )
        .unwrap();
        let parsed = read_sidecar(&path);
        assert_eq!(parsed.labels, BTreeMap::from([(0_i64, "text".to_string())]));
        assert!(parsed.normalize_imagenet);
        let _ = fs::remove_file(sidecar);
    }

    #[test]
    fn letterbox_is_chw_and_preserves_aspect() {
        let image = RgbaImage::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
        let prepared = letterbox(&image, 8, 8, false).unwrap();
        assert_eq!(prepared.tensor.len(), 3 * 8 * 8);
        assert_eq!(prepared.pad_y, 2.0);
        assert_eq!(prepared.pad_x, 0.0);
        assert_eq!(prepared.tensor[2 * 64 + 2 * 8], 0.0);
        assert_eq!(prepared.tensor[2 * 64 + 2 * 8 + 1], 0.0);
    }

    #[test]
    fn invalid_input_shapes_are_rejected() {
        assert!(input_spatial_shape(&[1, 3, 64]).is_err());
        assert!(input_spatial_shape(&[2, 3, 64, 64]).is_err());
        assert!(input_spatial_shape(&[1, 4, 64, 64]).is_err());
        assert!(input_spatial_shape(&[0, 3, 64, 64]).is_err());
        assert!(input_spatial_shape(&[1, 3, 0, 64]).is_err());
        assert!(input_spatial_shape(&[1, 3, -2, 64]).is_err());
        assert!(input_spatial_shape(&[1, 3, 9000, 64]).is_err());
        assert_eq!(
            input_spatial_shape(&[1, 3, -1, -1]).unwrap(),
            (DEFAULT_INPUT_EDGE, DEFAULT_INPUT_EDGE)
        );
    }

    #[test]
    fn imagenet_normalisation_applies_to_letterbox_padding() {
        let image = RgbaImage::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
        let prepared = letterbox(&image, 8, 8, true).unwrap();
        let plane = 8 * 8;
        let red_padding = prepared.tensor[0];
        let green_padding = prepared.tensor[plane];
        assert!((red_padding + IMAGENET_MEAN[0] / IMAGENET_STD[0]).abs() < 1e-6);
        assert!((green_padding + IMAGENET_MEAN[1] / IMAGENET_STD[1]).abs() < 1e-6);
    }

    #[test]
    fn inverse_letterbox_restores_and_clamps_source_coordinates() {
        let image = RgbaImage::from_pixel(100, 50, Rgba([0, 0, 0, 255]));
        let prepared = letterbox(&image, 200, 200, false).unwrap();
        assert_eq!(prepared.scale, 2.0);
        assert_eq!(prepared.pad_y, 50.0);
        assert_eq!(
            undo_letterbox([20.0, 60.0, 180.0, 140.0], &prepared, 100, 50),
            [10, 5, 90, 45]
        );
        assert_eq!(
            undo_letterbox([-10.0, 0.0, 250.0, 250.0], &prepared, 100, 50),
            [0, 0, 100, 50]
        );
    }

    #[test]
    fn box_tensor_layout_decodes_scores_and_integer_labels() {
        let boxes = [8.0, 9.0, 40.0, 41.0, 2.0, 3.0, 10.0, 12.0];
        let scores = [0.9, 0.2];
        let labels = [2_i64, 1_i64];
        let detections = decode_box_tensors(
            (&[2, 4], &boxes),
            Some((&[2], &scores)),
            Some((&[2], &labels)),
        )
        .unwrap();
        assert_eq!(detections.len(), 2);
        assert_eq!(detections[0].box_xyxy, [8.0, 9.0, 40.0, 41.0]);
        assert_eq!(detections[0].score, 0.9);
        assert_eq!(detections[0].label, 2);

        let defaults = decode_box_tensors((&[1, 4], &boxes[..4]), None, None).unwrap();
        assert_eq!(defaults[0].score, 1.0);
        assert_eq!(defaults[0].label, 0);
    }

    #[test]
    fn box_tensor_layout_rejects_bad_shapes_lengths_and_non_finite_values() {
        assert!(decode_box_tensors((&[1, 2, 2], &[0.0; 4]), None, None).is_err());
        assert!(decode_box_tensors((&[2, 4], &[0.0; 4]), None, None).is_err());
        assert!(
            decode_box_tensors((&[1, 4], &[0.0; 4]), Some((&[2], &[0.9, 0.8])), None,).is_err()
        );
        assert!(decode_box_tensors(
            (&[1, 4], &[0.0, 0.0, f32::NAN, 1.0]),
            Some((&[1], &[0.9])),
            Some((&[1], &[0])),
        )
        .is_err());
    }

    #[test]
    fn probability_map_splits_four_connected_components() {
        let mut map = vec![0.0_f32; 4 * 4];
        map[5] = 0.9;
        map[6] = 0.8;
        map[15] = 0.7;
        let detections = decode_probability_map(&[1, 1, 4, 4], &map, 8, 8).unwrap();
        assert_eq!(detections.len(), 2);
        assert!(detections.iter().all(|d| d.label == 0));
        assert!(detections.iter().all(|d| d.score >= SCORE_FLOOR));
    }

    #[test]
    fn probability_map_rejects_non_finite_values() {
        let err = decode_probability_map(&[1, 1, 1, 1], &[f32::NAN], 4, 4).unwrap_err();
        assert!(err.contains("non-finite"));
    }

    #[test]
    fn probability_map_rejects_unbounded_output_shapes() {
        let err = decode_probability_map(&[1, 1, 4096, 4096], &[], 640, 640).unwrap_err();
        assert!(err.contains("too large"));
    }
}
