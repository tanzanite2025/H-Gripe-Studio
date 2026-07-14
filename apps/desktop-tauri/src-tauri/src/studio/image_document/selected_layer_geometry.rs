use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const WORLD_COORDINATE_LIMIT: f32 = 1_000_000.0;
pub(super) const MAX_TRANSFORM_SCALE: f32 = 64.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct DocumentRect(pub(super) [f32; 4]);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedLayerFrame {
    pub(crate) owner: &'static str,
    pub(crate) shape: &'static str,
    pub(crate) layer_id: String,
    pub(crate) rect: [f32; 4],
    pub(crate) source_rect: [f32; 4],
    pub(crate) source: &'static str,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedLayerMoveDraft {
    pub(crate) dx: f32,
    pub(crate) dy: f32,
}

impl SelectedLayerMoveDraft {
    pub(crate) fn is_finite(self) -> bool {
        self.dx.is_finite() && self.dy.is_finite()
    }
}

pub(super) fn finite_f32(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

pub(super) fn json_f32(value: Option<&Value>, fallback: f32) -> f32 {
    value
        .and_then(Value::as_f64)
        .map(|v| {
            v.clamp(
                -(WORLD_COORDINATE_LIMIT as f64),
                WORLD_COORDINATE_LIMIT as f64,
            ) as f32
        })
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}

pub(super) fn json_positive_f32(value: Option<&Value>, fallback: f32) -> f32 {
    json_f32(value, fallback).max(1e-6)
}

#[derive(Clone, Copy)]
pub(super) struct CompositeFrame {
    pub(super) x: f32,
    pub(super) y: f32,
    pub(super) w: f32,
    pub(super) h: f32,
}

impl CompositeFrame {
    pub(super) fn new(x: f32, y: f32, w: u32, h: u32) -> Self {
        Self {
            x: finite_f32(x, 0.0).clamp(-WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            y: finite_f32(y, 0.0).clamp(-WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            w: (w.max(1) as f32).min(WORLD_COORDINATE_LIMIT),
            h: (h.max(1) as f32).min(WORLD_COORDINATE_LIMIT),
        }
    }

    pub(super) fn sx(self, width: u32) -> f32 {
        width as f32 / self.w.max(1.0)
    }

    pub(super) fn sy(self, height: u32) -> f32 {
        height as f32 / self.h.max(1.0)
    }
}

#[derive(Clone, Copy)]
pub(super) struct LayerTransform {
    pub(super) dx: f32,
    pub(super) dy: f32,
    pub(super) scale: f32,
    pub(super) rotate: f32,
}

impl LayerTransform {
    pub(super) const IDENTITY: LayerTransform = LayerTransform {
        dx: 0.0,
        dy: 0.0,
        scale: 1.0,
        rotate: 0.0,
    };

    pub(super) fn is_identity(self) -> bool {
        self.dx == 0.0 && self.dy == 0.0 && self.scale == 1.0 && self.rotate == 0.0
    }

    pub(super) fn is_finite(self) -> bool {
        self.dx.is_finite()
            && self.dy.is_finite()
            && self.scale.is_finite()
            && self.rotate.is_finite()
    }
}

pub(super) fn compose_layer_transform(a: LayerTransform, b: LayerTransform) -> LayerTransform {
    let rad = b.rotate.to_radians();
    let (sin, cos) = rad.sin_cos();
    LayerTransform {
        dx: b.scale * (cos * a.dx - sin * a.dy) + b.dx,
        dy: b.scale * (sin * a.dx + cos * a.dy) + b.dy,
        scale: a.scale * b.scale,
        rotate: a.rotate + b.rotate,
    }
}

fn fold_layer_transform_ops(
    layer: &Value,
    translation_scale: (f32, f32),
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<LayerTransform, String> {
    let (translation_scale_x, translation_scale_y) = translation_scale;
    let mut transform = LayerTransform::IDENTITY;
    for (index, op) in layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if op.get("disabled").and_then(Value::as_bool) == Some(true)
            || op.get("type").and_then(Value::as_str) != Some("transform")
        {
            continue;
        }
        let field = |name: &str, default: f32| -> Result<f32, String> {
            let Some(value) = op.get(name) else {
                return Ok(default);
            };
            let value = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("transform op {index} field {name} must be finite"))?;
            if value.abs() > f64::from(WORLD_COORDINATE_LIMIT) {
                return Err(format!(
                    "transform op {index} field {name} exceeds the world limit"
                ));
            }
            Ok(value as f32)
        };
        let scale = field("scale", 1.0)?;
        if scale <= 0.0 || scale > MAX_TRANSFORM_SCALE {
            return Err(format!(
                "transform op {index} scale must be positive and at most {MAX_TRANSFORM_SCALE}"
            ));
        }
        let next = LayerTransform {
            dx: field("dx", 0.0)? * translation_scale_x,
            dy: field("dy", 0.0)? * translation_scale_y,
            scale,
            rotate: field("rotate", 0.0)?.rem_euclid(360.0),
        };
        transform = compose_layer_transform(transform, next);
        transform.rotate = transform.rotate.rem_euclid(360.0);
        if !transform.is_finite()
            || transform.scale <= 0.0
            || transform.scale > WORLD_COORDINATE_LIMIT
            || transform.dx.abs() > WORLD_COORDINATE_LIMIT
            || transform.dy.abs() > WORLD_COORDINATE_LIMIT
        {
            return Err(format!(
                "transform op {index} makes the layer transform exceed its limits"
            ));
        }
    }
    if let Some(draft) = move_draft {
        if !draft.is_finite()
            || draft.dx.abs() > WORLD_COORDINATE_LIMIT
            || draft.dy.abs() > WORLD_COORDINATE_LIMIT
        {
            return Err("selected layer move draft exceeds the world limit".to_string());
        }
        if draft.dx.abs() >= 0.01 || draft.dy.abs() >= 0.01 {
            transform = compose_layer_transform(
                transform,
                LayerTransform {
                    dx: draft.dx,
                    dy: draft.dy,
                    scale: 1.0,
                    rotate: 0.0,
                },
            );
            if !transform.is_finite()
                || transform.dx.abs() > WORLD_COORDINATE_LIMIT
                || transform.dy.abs() > WORLD_COORDINATE_LIMIT
            {
                return Err("selected layer move draft makes the transform invalid".to_string());
            }
        }
    }
    Ok(transform)
}

pub(super) fn layer_output_frame_transform(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Result<LayerTransform, String> {
    fold_layer_transform_ops(layer, (frame.sx(width), frame.sy(height)), None)
}

pub(super) fn layer_output_frame_transform_with_draft(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<LayerTransform, String> {
    let scaled_draft = move_draft.map(|draft| SelectedLayerMoveDraft {
        dx: draft.dx * frame.sx(width),
        dy: draft.dy * frame.sy(height),
    });
    fold_layer_transform_ops(layer, (frame.sx(width), frame.sy(height)), scaled_draft)
}

pub(super) fn source_image_op(layer: &Value) -> Option<&Value> {
    layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|op| {
            op.get("type").and_then(Value::as_str) == Some("source_image")
                && op.get("disabled").and_then(Value::as_bool) != Some(true)
        })
}

pub(super) fn normalize_document_rect(rect: [f32; 4]) -> Option<DocumentRect> {
    if !rect.iter().all(|value| value.is_finite()) {
        return None;
    }
    let x0 = rect[0].min(rect[2]);
    let y0 = rect[1].min(rect[3]);
    let x1 = rect[0].max(rect[2]);
    let y1 = rect[1].max(rect[3]);
    (x1 > x0 && y1 > y0).then_some(DocumentRect([x0, y0, x1, y1]))
}

pub(super) fn placement_rect_from_op(op: &Value) -> Option<DocumentRect> {
    let values = op.get("placement")?.as_array()?;
    if values.len() < 4 {
        return None;
    }
    let coordinate = |value: Option<&Value>| {
        let value = value?.as_f64()?;
        value.is_finite().then(|| {
            value.clamp(
                -(WORLD_COORDINATE_LIMIT as f64),
                WORLD_COORDINATE_LIMIT as f64,
            ) as f32
        })
    };
    normalize_document_rect([
        coordinate(values.first())?,
        coordinate(values.get(1))?,
        coordinate(values.get(2))?,
        coordinate(values.get(3))?,
    ])
}

pub(super) fn selected_layer_source_rect(layer: &Value) -> Option<DocumentRect> {
    if layer.get("kind").and_then(Value::as_str) == Some("adjustment")
        || layer.get("visible").and_then(Value::as_bool) == Some(false)
        || layer
            .get("opacity")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.0, 1.0)
            <= 0.0
    {
        return None;
    }
    let Some(op) = source_image_op(layer) else {
        return None;
    };
    placement_rect_from_op(op)
}

pub(super) fn layer_document_transform(
    layer: &Value,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<LayerTransform, String> {
    fold_layer_transform_ops(layer, (1.0, 1.0), move_draft)
}

pub(super) fn transform_document_point(
    point: (f32, f32),
    transform: LayerTransform,
    document_width: u32,
    document_height: u32,
) -> (f32, f32) {
    let cx = document_width.max(1) as f32 / 2.0;
    let cy = document_height.max(1) as f32 / 2.0;
    let (sin, cos) = transform.rotate.to_radians().sin_cos();
    let sx = (point.0 - cx) * transform.scale;
    let sy = (point.1 - cy) * transform.scale;
    (
        cx + sx * cos - sy * sin + transform.dx,
        cy + sx * sin + sy * cos + transform.dy,
    )
}

pub(super) fn transform_document_rect(
    rect: DocumentRect,
    transform: LayerTransform,
    document_width: u32,
    document_height: u32,
) -> DocumentRect {
    if transform.is_identity() {
        return rect;
    }
    let [x0, y0, x1, y1] = rect.0;
    let points = [
        transform_document_point((x0, y0), transform, document_width, document_height),
        transform_document_point((x1, y0), transform, document_width, document_height),
        transform_document_point((x1, y1), transform, document_width, document_height),
        transform_document_point((x0, y1), transform, document_width, document_height),
    ];
    let (mut min_x, mut min_y) = points[0];
    let (mut max_x, mut max_y) = points[0];
    for (x, y) in points.iter().copied().skip(1) {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    DocumentRect([min_x, min_y, max_x, max_y])
}

pub(super) fn selected_layer_frame_for_layer(
    layer: &Value,
    selected_layer_id: &str,
    document_width: u32,
    document_height: u32,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<Option<SelectedLayerFrame>, String> {
    let Some(source_rect) = selected_layer_source_rect(layer) else {
        return Ok(None);
    };
    let transform = layer_document_transform(layer, move_draft)?;
    let rect = transform_document_rect(source_rect, transform, document_width, document_height);
    Ok(Some(SelectedLayerFrame {
        owner: "selected-layer-frame",
        shape: "axis-aligned-rect",
        layer_id: selected_layer_id.to_string(),
        rect: rect.0,
        source_rect: source_rect.0,
        source: "asset-frame",
    }))
}

#[cfg(test)]
pub(crate) fn selected_layer_frame(
    document: &Value,
    selected_layer_id: &str,
    document_width: u32,
    document_height: u32,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<Option<SelectedLayerFrame>, String> {
    let Some(layers) = document.get("layers").and_then(Value::as_array) else {
        return Ok(None);
    };
    let Some(layer) = layers
        .iter()
        .find(|layer| layer.get("id").and_then(Value::as_str) == Some(selected_layer_id))
    else {
        return Ok(None);
    };
    selected_layer_frame_for_layer(
        layer,
        selected_layer_id,
        document_width,
        document_height,
        move_draft,
    )
}
