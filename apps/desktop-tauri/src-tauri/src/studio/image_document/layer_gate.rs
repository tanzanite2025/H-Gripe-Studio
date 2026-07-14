use serde_json::Value;

use super::selected_layer_geometry::{
    json_f32, normalize_document_rect, source_image_op, DocumentRect, WORLD_COORDINATE_LIMIT,
};
use super::MAX_LAYER_VIA_COPY_PIXELS;

pub(super) const MAX_SELECTION_POLYGON_POINTS: usize = 65_536;

#[derive(Clone)]
pub(super) enum DocumentGate {
    Region {
        rect: DocumentRect,
        ellipse: bool,
    },
    Polygon(Vec<[f32; 2]>),
    Alpha {
        rect: DocumentRect,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    },
}

impl DocumentGate {
    pub(super) fn coverage(&self, x: f32, y: f32) -> u8 {
        match self {
            Self::Region { rect, ellipse } => {
                let [left, top, right, bottom] = rect.0;
                if x < left || x >= right || y < top || y >= bottom {
                    return 0;
                }
                if !ellipse {
                    return 255;
                }
                let rx = (right - left) * 0.5;
                let ry = (bottom - top) * 0.5;
                let cx = left + rx;
                let cy = top + ry;
                let nx = (x - cx) / rx.max(f32::EPSILON);
                let ny = (y - cy) / ry.max(f32::EPSILON);
                if nx * nx + ny * ny <= 1.0 {
                    255
                } else {
                    0
                }
            }
            Self::Polygon(points) => {
                if point_in_polygon(x, y, points) {
                    255
                } else {
                    0
                }
            }
            Self::Alpha {
                rect,
                width,
                height,
                pixels,
            } => {
                let [left, top, right, bottom] = rect.0;
                if x < left || x >= right || y < top || y >= bottom {
                    return 0;
                }
                let map_x = (((x - left) / (right - left)) * *width as f32)
                    .floor()
                    .clamp(0.0, width.saturating_sub(1) as f32) as u32;
                let map_y = (((y - top) / (bottom - top)) * *height as f32)
                    .floor()
                    .clamp(0.0, height.saturating_sub(1) as f32) as u32;
                pixels[(map_y * *width + map_x) as usize]
            }
        }
    }
}

#[derive(Clone, Copy)]
enum MaskCombineMode {
    Add,
    Subtract,
    Intersect,
}

#[derive(Clone)]
struct CompiledMaskOp {
    mode: MaskCombineMode,
    shape: DocumentGate,
}

#[derive(Clone)]
struct CompiledLayerMask {
    ops: Vec<CompiledMaskOp>,
    linked: bool,
}

impl CompiledLayerMask {
    fn coverage(&self, x: f32, y: f32) -> u8 {
        let mut alpha = 0u8;
        for op in &self.ops {
            let covered = op.shape.coverage(x, y) > 0;
            match op.mode {
                MaskCombineMode::Subtract if covered => alpha = 0,
                MaskCombineMode::Intersect if !covered => alpha = 0,
                MaskCombineMode::Add if covered => alpha = 255,
                _ => {}
            }
        }
        alpha
    }
}

#[derive(Clone)]
pub(super) struct CompiledLayerGates {
    source_clip: Option<DocumentGate>,
    mask: Option<CompiledLayerMask>,
}

impl CompiledLayerGates {
    pub(super) fn coverage(
        &self,
        base_document: (f32, f32),
        destination_document: (f32, f32),
    ) -> u8 {
        let clip = self
            .source_clip
            .as_ref()
            .map(|gate| gate.coverage(base_document.0, base_document.1))
            .unwrap_or(255);
        let mask = self
            .mask
            .as_ref()
            .map(|mask| {
                let point = if mask.linked {
                    base_document
                } else {
                    destination_document
                };
                mask.coverage(point.0, point.1)
            })
            .unwrap_or(255);
        clip.min(mask)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.source_clip.is_none() && self.mask.is_none()
    }
}

pub(super) fn decode_selection_alpha_rle(
    width: u32,
    height: u32,
    starts_with: u8,
    runs: &[u64],
    owner: &str,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err(format!("{owner} dimensions must be positive"));
    }
    if starts_with != 0 && starts_with != 255 {
        return Err(format!(
            "{owner} startsWith must be 0 or 255, got {starts_with}"
        ));
    }
    let pixel_count = u64::from(width) * u64::from(height);
    if pixel_count > MAX_LAYER_VIA_COPY_PIXELS {
        return Err(format!(
            "{owner} is too large: {width}x{height} exceeds the pixel budget"
        ));
    }
    let total = usize::try_from(pixel_count)
        .map_err(|_| format!("{owner} dimensions overflow this platform"))?;
    let mut decoded = vec![0u8; total];
    let mut cursor = 0usize;
    let mut value = starts_with;
    for count in runs {
        let count = usize::try_from(*count)
            .map_err(|_| format!("{owner} run length overflows this platform"))?;
        let end = cursor
            .checked_add(count)
            .ok_or_else(|| format!("{owner} run length overflow"))?;
        if end > total {
            return Err(format!("{owner} runs exceed dimensions"));
        }
        if value > 0 {
            decoded[cursor..end].fill(255);
        }
        cursor = end;
        value = if value > 0 { 0 } else { 255 };
    }
    if cursor != total {
        return Err(format!("{owner} runs do not cover dimensions"));
    }
    Ok(decoded)
}

fn strict_rect(value: &Value, owner: &str) -> Result<DocumentRect, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{owner} must be an array"))?;
    if values.len() != 4 {
        return Err(format!("{owner} must contain exactly four coordinates"));
    }
    let mut rect = [0.0f32; 4];
    for (index, value) in values.iter().enumerate() {
        let coordinate = value
            .as_f64()
            .filter(|coordinate| coordinate.is_finite())
            .ok_or_else(|| format!("{owner} coordinate {index} must be finite"))?;
        if coordinate.abs() > f64::from(WORLD_COORDINATE_LIMIT) {
            return Err(format!(
                "{owner} coordinate {index} exceeds the world limit"
            ));
        }
        rect[index] = coordinate as f32;
    }
    normalize_document_rect(rect).ok_or_else(|| format!("{owner} is empty"))
}

fn strict_polygon(value: &Value, owner: &str) -> Result<Vec<[f32; 2]>, String> {
    let points = value
        .as_array()
        .ok_or_else(|| format!("{owner} points must be an array"))?;
    if points.len() < 3 {
        return Err(format!(
            "{owner} polygon must contain at least three points"
        ));
    }
    if points.len() > MAX_SELECTION_POLYGON_POINTS {
        return Err(format!(
            "{owner} polygon exceeds {MAX_SELECTION_POLYGON_POINTS} points"
        ));
    }
    points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let point = point
                .as_array()
                .ok_or_else(|| format!("{owner} point {index} must be an array"))?;
            if point.len() != 2 {
                return Err(format!(
                    "{owner} point {index} must contain exactly two coordinates"
                ));
            }
            let x = point[0]
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("{owner} point {index} x must be finite"))?;
            let y = point[1]
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("{owner} point {index} y must be finite"))?;
            if x.abs() > f64::from(WORLD_COORDINATE_LIMIT)
                || y.abs() > f64::from(WORLD_COORDINATE_LIMIT)
            {
                return Err(format!("{owner} point {index} exceeds the world limit"));
            }
            Ok([x as f32, y as f32])
        })
        .collect()
}

fn compile_source_clip(layer: &Value) -> Result<Option<DocumentGate>, String> {
    let Some(clip) = source_image_op(layer).and_then(|op| op.get("clip")) else {
        return Ok(None);
    };
    if clip.is_null() {
        return Ok(None);
    }
    let rect = strict_rect(
        clip.get("region")
            .ok_or_else(|| "source clip requires a region".to_string())?,
        "source clip region",
    )?;
    if let Some(alpha) = clip.get("selectionAlpha").filter(|value| !value.is_null()) {
        let width = alpha
            .get("width")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "source selection alpha width must be a positive integer".to_string())?;
        let height = alpha
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| {
                "source selection alpha height must be a positive integer".to_string()
            })?;
        let starts_with = alpha
            .get("startsWith")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| "source selection alpha startsWith is missing".to_string())?;
        let runs = alpha
            .get("runs")
            .and_then(Value::as_array)
            .ok_or_else(|| "source selection alpha runs must be an array".to_string())?
            .iter()
            .map(|run| {
                run.as_u64()
                    .ok_or_else(|| "source selection alpha run must be an integer".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(Some(DocumentGate::Alpha {
            rect,
            width,
            height,
            pixels: decode_selection_alpha_rle(
                width,
                height,
                starts_with,
                &runs,
                "source selection alpha",
            )?,
        }));
    }
    if let Some(points) = clip.get("points").filter(|value| !value.is_null()) {
        return Ok(Some(DocumentGate::Polygon(strict_polygon(
            points,
            "source clip",
        )?)));
    }
    Ok(Some(DocumentGate::Region {
        rect,
        ellipse: clip.get("ellipse").and_then(Value::as_bool) == Some(true),
    }))
}

fn legacy_region(op: &Value) -> Option<DocumentRect> {
    let values = op.get("region")?.as_array()?;
    if values.len() < 4 {
        return None;
    }
    normalize_document_rect([
        json_f32(values.first(), 0.0),
        json_f32(values.get(1), 0.0),
        json_f32(values.get(2), 0.0),
        json_f32(values.get(3), 0.0),
    ])
}

fn compile_mask_shape(op: &Value) -> Option<DocumentGate> {
    match op.get("type").and_then(Value::as_str) {
        Some("rect") | Some("ellipse") => Some(DocumentGate::Region {
            rect: legacy_region(op)?,
            ellipse: op.get("type").and_then(Value::as_str) == Some("ellipse"),
        }),
        Some("path") => {
            let points = op
                .get("points")?
                .as_array()?
                .iter()
                .filter_map(|point| {
                    Some([json_f32(point.get("x"), 0.0), json_f32(point.get("y"), 0.0)])
                })
                .collect::<Vec<_>>();
            (points.len() >= 3).then_some(DocumentGate::Polygon(points))
        }
        _ => None,
    }
}

fn compile_layer_mask(layer: &Value) -> Option<CompiledLayerMask> {
    let mask = layer.get("mask")?;
    if mask.get("disabled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let ops = mask.get("ops")?.as_array()?;
    if ops.is_empty() {
        return None;
    }
    let mut compiled = Vec::with_capacity(ops.len());
    for op in ops {
        let Some(shape) = compile_mask_shape(op) else {
            continue;
        };
        let mode = match op.get("mode").and_then(Value::as_str).unwrap_or("add") {
            "subtract" => MaskCombineMode::Subtract,
            "intersect" => MaskCombineMode::Intersect,
            _ => MaskCombineMode::Add,
        };
        compiled.push(CompiledMaskOp { mode, shape });
    }
    Some(CompiledLayerMask {
        ops: compiled,
        linked: mask.get("unlinked").and_then(Value::as_bool) != Some(true),
    })
}

pub(super) fn compile_layer_gates(layer: &Value) -> Result<CompiledLayerGates, String> {
    Ok(CompiledLayerGates {
        source_clip: compile_source_clip(layer)?,
        mask: compile_layer_mask(layer),
    })
}

fn point_in_polygon(x: f32, y: f32, points: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        let [current_x, current_y] = points[current];
        let [previous_x, previous_y] = points[previous];
        if ((current_y > y) != (previous_y > y))
            && x < (previous_x - current_x) * (y - current_y) / (previous_y - current_y) + current_x
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}
