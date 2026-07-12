use std::path::Path;

use hgripe_grade::{composite_over, BlendMode, GradeSpace, GradeSurface};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{srgb_proxy_surface, surface_to_rgba};
use super::studio_image::{load_rgba, DEFAULT_MAX_DECODE_PIXELS};
use super::viewport::{cpu_backend, pixels_bin_payload};

const WORLD_COORDINATE_LIMIT: f32 = 1_000_000.0;
const MAX_TRANSFORM_SCALE: f32 = 64.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct DocumentRect([f32; 4]);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedLayerFrame {
    owner: &'static str,
    shape: &'static str,
    layer_id: String,
    rect: [f32; 4],
    source_rect: [f32; 4],
    source: &'static str,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedLayerMoveDraft {
    dx: f32,
    dy: f32,
}

fn finite_f32(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn json_f32(value: Option<&Value>, fallback: f32) -> f32 {
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

fn json_positive_f32(value: Option<&Value>, fallback: f32) -> f32 {
    json_f32(value, fallback).max(1.0)
}

#[derive(Clone, Copy)]
struct CompositeFrame {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl CompositeFrame {
    fn new(x: f32, y: f32, w: u32, h: u32) -> Self {
        Self {
            x: finite_f32(x, 0.0).clamp(-WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            y: finite_f32(y, 0.0).clamp(-WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            w: (w.max(1) as f32).min(WORLD_COORDINATE_LIMIT),
            h: (h.max(1) as f32).min(WORLD_COORDINATE_LIMIT),
        }
    }

    fn sx(self, width: u32) -> f32 {
        width as f32 / self.w.max(1.0)
    }

    fn sy(self, height: u32) -> f32 {
        height as f32 / self.h.max(1.0)
    }
}

pub(crate) fn composite_image_document(
    source: &RgbaImage,
    document: &Value,
    document_width: u32,
    document_height: u32,
) -> Result<RgbaImage, String> {
    composite_image_document_with_sources(
        source,
        document,
        document_width,
        document_height,
        document_width.max(document_height),
        &mut |path| Err(format!("no loader for per-layer image source {path}")),
    )
}

/// [`composite_image_document`] with a loader for layers that carry their own
/// image resource (`source_image.source.path`). Each layer draws either the
/// shared opened image or its own resource, placed at the document-space
/// `placement` rect its op records, so one layer's bounds never clip another.
///
/// The output is document-proportioned: the document rect scaled to fit
/// within `output_limit` (never upscaled past its native size), independent
/// of the shared source proxy's dimensions 鈥?a small opened image must not
/// drop the whole canvas to its own resolution.
pub(crate) fn composite_image_document_with_sources(
    source: &RgbaImage,
    document: &Value,
    document_width: u32,
    document_height: u32,
    output_limit: u32,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<RgbaImage, String> {
    composite_image_document_with_sources_in_frame(
        source,
        document,
        document_width,
        document_height,
        0.0,
        0.0,
        document_width,
        document_height,
        output_limit,
        load_source,
    )
}

/// Composite the document into an arbitrary scene-frame window. The document
/// dimensions remain the edit coordinate system; `frame_*` is only the
/// rendered pasteboard window, so layers outside `[0,0,document]` can be shown
/// without changing history/export semantics.
pub(crate) fn composite_image_document_with_sources_in_frame(
    source: &RgbaImage,
    document: &Value,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
    output_limit: u32,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<RgbaImage, String> {
    let Some(layers) = document.get("layers").and_then(Value::as_array) else {
        return Ok(source.clone());
    };
    let dw = document_width.max(1);
    let dh = document_height.max(1);
    let frame = CompositeFrame::new(frame_x, frame_y, frame_width, frame_height);
    let out_scale = (output_limit.max(1) as f32 / frame.w.max(frame.h)).min(1.0);
    let out_w = ((frame.w * out_scale).round() as u32).max(1);
    let out_h = ((frame.h * out_scale).round() as u32).max(1);
    let source_surface = srgb_proxy_surface(source)?;
    let document_rect = [0.0, 0.0, dw as f32, dh as f32];
    let transform_center = (
        ((dw as f32 / 2.0) - frame.x) * frame.sx(out_w),
        ((dh as f32 / 2.0) - frame.y) * frame.sy(out_h),
    );
    let mut composite = GradeSurface {
        w: out_w,
        h: out_h,
        data: vec![0.0; (out_w * out_h * 4) as usize],
        space: GradeSpace::Srgb,
    };
    for (index, layer) in layers.iter().enumerate() {
        if layer.get("visible").and_then(Value::as_bool) == Some(false)
            || layer.get("kind").and_then(Value::as_str) == Some("adjustment")
            || !layer_sources_image(layer, index)
        {
            continue;
        }
        let opacity = layer
            .get("opacity")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.0, 1.0) as f32;
        if opacity <= 0.0 {
            continue;
        }
        let mask = raster_layer_gate(layer, out_w, out_h, frame)?;
        let transform = layer_transform(layer, out_w, out_h, frame);
        let mask_linked = layer
            .get("mask")
            .and_then(|mask| mask.get("unlinked"))
            .and_then(Value::as_bool)
            != Some(true);
        let placed = placed_layer_surface(
            layer,
            &source_surface,
            out_w,
            out_h,
            document_width,
            document_height,
            frame,
            load_source,
        )?;
        let layer_base = match placed {
            Some(placed) => placed,
            None => place_surface_in_frame(&source_surface, out_w, out_h, frame, document_rect),
        };
        let (surface, gate) = transformed_layer(
            &layer_base,
            mask.as_deref(),
            transform,
            mask_linked,
            transform_center,
        );
        let mode = layer
            .get("blend")
            .and_then(Value::as_str)
            .and_then(BlendMode::from_name)
            .filter(|mode| {
                matches!(
                    mode,
                    BlendMode::Normal
                        | BlendMode::Multiply
                        | BlendMode::Screen
                        | BlendMode::Darken
                        | BlendMode::Lighten
                        | BlendMode::Difference
                )
            })
            .unwrap_or(BlendMode::Normal);
        composite_over(&mut composite, &surface, mode, opacity, gate.as_deref());
    }
    surface_to_rgba(&composite)
}

fn document_with_only_selected_layer(
    document: &Value,
    selected_layer_id: &str,
) -> Result<Value, String> {
    let layers = document
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "selection assist read requires a layered image document".to_string())?;
    let Some((selected_index, selected_layer)) = layers.iter().enumerate().find(|(_, layer)| {
        layer.get("id").and_then(Value::as_str) == Some(selected_layer_id)
    }) else {
        return Err(format!("unknown selected layer id: {selected_layer_id}"));
    };
    if selected_layer_source_rect(selected_layer, selected_index).is_none()
    {
        return Err(format!(
            "selected layer {selected_layer_id} is not an active editable pixel layer"
        ));
    }

    let mut isolated = document.clone();
    let isolated_layers = isolated
        .get_mut("layers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "selection assist read could not isolate document layers".to_string())?;
    for (index, layer) in isolated_layers.iter_mut().enumerate() {
        if index == selected_index {
            continue;
        }
        if let Some(obj) = layer.as_object_mut() {
            obj.insert("visible".to_string(), Value::Bool(false));
        }
    }
    Ok(isolated)
}

/// Materialize the active editable pixel layer into a scene-frame window for
/// selection-assist tools such as magnetic lasso. This is not a document
/// composite and not the Layer Via Copy source; it is a gesture-local analysis
/// surface resolved from the selected layer's real placed/transformed pixels.
pub(crate) fn selection_assist_layer_pixels_in_frame(
    source: &RgbaImage,
    document: &Value,
    selected_layer_id: &str,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
    output_limit: u32,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<RgbaImage, String> {
    let isolated = document_with_only_selected_layer(
        document,
        selected_layer_id,
    )?;
    composite_image_document_with_sources_in_frame(
        source,
        &isolated,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
        output_limit,
        load_source,
    )
}

/// Resolve a layer whose `source_image` op carries its own image resource
/// and/or a document-space placement rect into a canvas-sized surface: the
/// layer's image is resampled into its placement, transparent elsewhere.
/// Returns `None` for legacy layers that draw the shared image full-canvas.
fn placed_layer_surface(
    layer: &Value,
    shared: &GradeSurface,
    out_w: u32,
    out_h: u32,
    document_width: u32,
    document_height: u32,
    frame: CompositeFrame,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<Option<GradeSurface>, String> {
    let Some(op) = layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|op| {
            op.get("type").and_then(Value::as_str) == Some("source_image")
                && op.get("disabled").and_then(Value::as_bool) != Some(true)
        })
    else {
        return Ok(None);
    };
    let source_path = op
        .get("source")
        .and_then(|source| source.get("path"))
        .and_then(Value::as_str);
    let placement = op
        .get("placement")
        .and_then(Value::as_array)
        .and_then(|values| {
            Some([
                json_f32(values.first(), 0.0),
                json_f32(values.get(1), 0.0),
                json_f32(values.get(2), 0.0),
                json_f32(values.get(3), 0.0),
            ])
        });
    if source_path.is_none() && placement.is_none() {
        return Ok(None);
    }
    let own_surface = match source_path {
        Some(path) => Some(srgb_proxy_surface(&load_source(path)?)?),
        None => None,
    };
    let image = own_surface.as_ref().unwrap_or(shared);
    let natural = op.get("source").and_then(|source| {
        Some((
            json_positive_f32(source.get("width"), image.w as f32),
            json_positive_f32(source.get("height"), image.h as f32),
        ))
    });
    let dw = document_width.max(1) as f32;
    let dh = document_height.max(1) as f32;
    let placement = placement.unwrap_or_else(|| {
        // Contain-fit the image's natural size inside the canvas, centred.
        let (nw, nh) = natural.unwrap_or((image.w as f32, image.h as f32));
        let scale = (dw / nw.max(1.0)).min(dh / nh.max(1.0)).min(1.0);
        let w = nw * scale;
        let h = nh * scale;
        let x0 = (dw - w) / 2.0;
        let y0 = (dh - h) / 2.0;
        [x0, y0, x0 + w, y0 + h]
    });
    Ok(Some(place_surface_in_frame(
        image, out_w, out_h, frame, placement,
    )))
}

fn place_surface_in_frame(
    image: &GradeSurface,
    out_w: u32,
    out_h: u32,
    frame: CompositeFrame,
    placement: [f32; 4],
) -> GradeSurface {
    let sx = frame.sx(out_w);
    let sy = frame.sy(out_h);
    let px0 = (placement[0].min(placement[2]) - frame.x) * sx;
    let py0 = (placement[1].min(placement[3]) - frame.y) * sy;
    let px1 = (placement[0].max(placement[2]) - frame.x) * sx;
    let py1 = (placement[1].max(placement[3]) - frame.y) * sy;
    let pw = (px1 - px0).max(1e-6);
    let ph = (py1 - py0).max(1e-6);
    let mut data = vec![0.0; (out_w * out_h * 4) as usize];
    for y in 0..out_h {
        let fy = (y as f32 + 0.5 - py0) / ph;
        if !(0.0..1.0).contains(&fy) {
            continue;
        }
        for x in 0..out_w {
            let fx = (x as f32 + 0.5 - px0) / pw;
            if !(0.0..1.0).contains(&fx) {
                continue;
            }
            let dst = ((y * out_w + x) * 4) as usize;
            let px = bilinear_sample(image, fx * image.w as f32 - 0.5, fy * image.h as f32 - 0.5);
            data[dst..dst + 4].copy_from_slice(&px);
        }
    }
    GradeSurface {
        w: out_w,
        h: out_h,
        data,
        space: image.space,
    }
}

/// Clamped bilinear sample of a surface at pixel-space `(fx, fy)` (the pixel
/// grid's sample points sit at integer coordinates here).
fn bilinear_sample(surface: &GradeSurface, fx: f32, fy: f32) -> [f32; 4] {
    if !fx.is_finite() || !fy.is_finite() {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let max_x = (surface.w - 1) as f32;
    let max_y = (surface.h - 1) as f32;
    let fx = fx.clamp(0.0, max_x);
    let fy = fy.clamp(0.0, max_y);
    let x0 = fx.floor() as u32;
    let y0 = fy.floor() as u32;
    let x1 = (x0 + 1).min(surface.w - 1);
    let y1 = (y0 + 1).min(surface.h - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let read = |x: u32, y: u32| -> [f32; 4] {
        let i = ((y * surface.w + x) * 4) as usize;
        [
            surface.data[i],
            surface.data[i + 1],
            surface.data[i + 2],
            surface.data[i + 3],
        ]
    };
    let (a, b, c, d) = (read(x0, y0), read(x1, y0), read(x0, y1), read(x1, y1));
    let mut out = [0.0; 4];
    for i in 0..4 {
        let top = a[i] + (b[i] - a[i]) * tx;
        let bottom = c[i] + (d[i] - c[i]) * tx;
        out[i] = top + (bottom - top) * ty;
    }
    out
}

#[derive(Clone, Copy)]
struct LayerTransform {
    dx: f32,
    dy: f32,
    scale: f32,
    rotate: f32,
}

impl LayerTransform {
    const IDENTITY: LayerTransform = LayerTransform {
        dx: 0.0,
        dy: 0.0,
        scale: 1.0,
        rotate: 0.0,
    };

    fn is_identity(self) -> bool {
        self.dx == 0.0 && self.dy == 0.0 && self.scale == 1.0 && self.rotate == 0.0
    }

    fn is_finite(self) -> bool {
        self.dx.is_finite()
            && self.dy.is_finite()
            && self.scale.is_finite()
            && self.rotate.is_finite()
    }
}

fn compose_layer_transform(a: LayerTransform, b: LayerTransform) -> LayerTransform {
    let rad = b.rotate.to_radians();
    let (sin, cos) = rad.sin_cos();
    LayerTransform {
        dx: b.scale * (cos * a.dx - sin * a.dy) + b.dx,
        dy: b.scale * (sin * a.dx + cos * a.dy) + b.dy,
        scale: a.scale * b.scale,
        rotate: a.rotate + b.rotate,
    }
}

fn layer_transform(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> LayerTransform {
    let sx = frame.sx(width);
    let sy = frame.sy(height);
    let mut transform = LayerTransform::IDENTITY;
    for op in layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if op.get("disabled").and_then(Value::as_bool) == Some(true)
            || op.get("type").and_then(Value::as_str) != Some("transform")
        {
            continue;
        }
        let next = LayerTransform {
            dx: json_f32(op.get("dx"), 0.0) * sx,
            dy: json_f32(op.get("dy"), 0.0) * sy,
            scale: json_positive_f32(op.get("scale"), 1.0).clamp(1e-6, MAX_TRANSFORM_SCALE),
            rotate: json_f32(op.get("rotate"), 0.0).rem_euclid(360.0),
        };
        transform = compose_layer_transform(transform, next);
        if !transform.is_finite() {
            return LayerTransform::IDENTITY;
        }
    }
    transform
}

fn layer_sources_image(layer: &Value, index: usize) -> bool {
    index == 0
        || layer
            .get("ops")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|op| op.get("type").and_then(Value::as_str) == Some("source_image"))
}

fn source_image_op(layer: &Value) -> Option<&Value> {
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

fn normalize_document_rect(rect: [f32; 4]) -> Option<DocumentRect> {
    if !rect.iter().all(|value| value.is_finite()) {
        return None;
    }
    let x0 = rect[0].min(rect[2]);
    let y0 = rect[1].min(rect[3]);
    let x1 = rect[0].max(rect[2]);
    let y1 = rect[1].max(rect[3]);
    (x1 > x0 && y1 > y0).then_some(DocumentRect([x0, y0, x1, y1]))
}

fn placement_rect_from_op(op: &Value) -> Option<DocumentRect> {
    let values = op.get("placement")?.as_array()?;
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

fn clip_region_rect_from_op(op: &Value) -> Option<DocumentRect> {
    let values = op
        .get("clip")?
        .get("region")?
        .as_array()?;
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

fn intersect_document_rect(a: DocumentRect, b: DocumentRect) -> Option<DocumentRect> {
    let [ax0, ay0, ax1, ay1] = a.0;
    let [bx0, by0, bx1, by1] = b.0;
    normalize_document_rect([
        ax0.max(bx0),
        ay0.max(by0),
        ax1.min(bx1),
        ay1.min(by1),
    ])
}

fn selected_layer_source_rect(
    layer: &Value,
    index: usize,
) -> Option<DocumentRect> {
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
    if !layer_sources_image(layer, index) {
        return None;
    }
    let Some(op) = source_image_op(layer) else {
        return None;
    };
    if let Some(placement) = placement_rect_from_op(op) {
        return match clip_region_rect_from_op(op) {
            Some(clip) => intersect_document_rect(placement, clip),
            None => Some(placement),
        };
    }
    None
}

fn layer_document_transform(
    layer: &Value,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> LayerTransform {
    let mut transform = LayerTransform::IDENTITY;
    for op in layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if op.get("disabled").and_then(Value::as_bool) == Some(true)
            || op.get("type").and_then(Value::as_str) != Some("transform")
        {
            continue;
        }
        let next = LayerTransform {
            dx: json_f32(op.get("dx"), 0.0),
            dy: json_f32(op.get("dy"), 0.0),
            scale: json_positive_f32(op.get("scale"), 1.0).clamp(1e-6, MAX_TRANSFORM_SCALE),
            rotate: json_f32(op.get("rotate"), 0.0).rem_euclid(360.0),
        };
        transform = compose_layer_transform(transform, next);
        if !transform.is_finite() {
            return LayerTransform::IDENTITY;
        }
    }
    if let Some(draft) = move_draft {
        if draft.dx.is_finite()
            && draft.dy.is_finite()
            && (draft.dx.abs() >= 0.01 || draft.dy.abs() >= 0.01)
        {
            transform = compose_layer_transform(
                transform,
                LayerTransform {
                    dx: draft.dx,
                    dy: draft.dy,
                    scale: 1.0,
                    rotate: 0.0,
                },
            );
        }
    }
    transform
}

fn transform_document_point(
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

fn transform_document_rect(
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

pub(crate) fn selected_layer_frame(
    document: &Value,
    selected_layer_id: &str,
    document_width: u32,
    document_height: u32,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Option<SelectedLayerFrame> {
    let layers = document.get("layers")?.as_array()?;
    let (index, layer) = layers
        .iter()
        .enumerate()
        .find(|(_, layer)| layer.get("id").and_then(Value::as_str) == Some(selected_layer_id))?;
    let source_rect = selected_layer_source_rect(layer, index)?;
    let transform = layer_document_transform(layer, move_draft);
    let rect = transform_document_rect(source_rect, transform, document_width, document_height);
    Some(SelectedLayerFrame {
        owner: "selected-layer-frame",
        shape: "axis-aligned-rect",
        layer_id: selected_layer_id.to_string(),
        rect: rect.0,
        source_rect: source_rect.0,
        source: "asset-frame",
    })
}

#[tauri::command]
pub(crate) fn resolve_selected_layer_frame(
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<Option<SelectedLayerFrame>, String> {
    Ok(selected_layer_frame(
        &document,
        &selected_layer_id,
        document_width,
        document_height,
        move_draft,
    ))
}

async fn read_selected_layer_pixels_response(
    image_path: String,
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = image_path.trim();
        if trimmed.is_empty() {
            return Err("selection assist read requires an image path".to_string());
        }
        let source = load_rgba(Path::new(trimmed), DEFAULT_MAX_DECODE_PIXELS)?.image;
        let mut load_source = |source_path: &str| {
            load_rgba(Path::new(source_path), DEFAULT_MAX_DECODE_PIXELS).map(|loaded| loaded.image)
        };
        let image = selection_assist_layer_pixels_in_frame(
            &source,
            &document,
            &selected_layer_id,
            document_width.max(1),
            document_height.max(1),
            frame_x,
            frame_y,
            frame_width.max(1),
            frame_height.max(1),
            frame_width.max(frame_height).max(1),
            &mut load_source,
        )?;
        let (w, h) = image.dimensions();
        Ok(tauri::ipc::Response::new(pixels_bin_payload(
            w,
            h,
            &cpu_backend(),
            image.as_raw(),
        )?))
    })
    .await
    .map_err(|err| format!("selected layer pixels read task failed: {err}"))?
}

#[tauri::command]
pub(crate) async fn read_selection_assist_pixels(
    image_path: String,
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<tauri::ipc::Response, String> {
    read_selected_layer_pixels_response(
        image_path,
        document,
        selected_layer_id,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
    )
    .await
}

#[tauri::command]
pub(crate) async fn read_selected_layer_move_surface_pixels(
    image_path: String,
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<tauri::ipc::Response, String> {
    read_selected_layer_pixels_response(
        image_path,
        document,
        selected_layer_id,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
    )
    .await
}

/// The layer's alpha gate: its mask attachment intersected with the selection
/// a PS Layer Via Copy recorded on its ops as `clip` (the copy holds only the
/// selected region's pixels).
fn raster_layer_gate(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Result<Option<Vec<u8>>, String> {
    let mask = raster_layer_mask(layer, width, height, frame);
    let clip = raster_layer_clip(layer, width, height, frame)?;
    Ok(match (mask, clip) {
        (Some(mut mask), Some(clip)) => {
            for (dst, src) in mask.iter_mut().zip(clip.iter()) {
                *dst = (*dst).min(*src);
            }
            Some(mask)
        }
        (mask, clip) => mask.or(clip),
    })
}

/// Rasterise the selection recorded as `clip` on the layer's `source_image`
/// op: a rect / ellipse `region`, an exact polygon when `points` is set, or
/// an exact pixel-alpha selection when `selectionAlpha` is set.
fn raster_layer_clip(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Result<Option<Vec<u8>>, String> {
    let source_op = layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|op| op.get("type").and_then(Value::as_str) == Some("source_image"));
    let Some(clip) = source_op.and_then(|op| op.get("clip"))
    else {
        return Ok(None);
    };
    let sx = frame.sx(width);
    let sy = frame.sy(height);
    if let Some(selection_alpha) = clip.get("selectionAlpha") {
        return raster_selection_alpha_clip(selection_alpha, clip, width, height, frame).map(Some);
    }
    if let Some(points) = clip.get("points").and_then(Value::as_array) {
        let polygon = points
            .iter()
            .filter_map(|p| {
                let pair = p.as_array()?;
                Some((
                    (json_f32(pair.first(), 0.0) - frame.x) * sx,
                    (json_f32(pair.get(1), 0.0) - frame.y) * sy,
                ))
            })
            .collect::<Vec<_>>();
        if polygon.len() >= 3 {
            return Ok(Some(raster_polygon_shape(width, height, &polygon)));
        }
    }
    let Some(region) = op_region(clip) else {
        return Ok(None);
    };
    Ok(Some(raster_region_shape(
        width,
        height,
        &region,
        clip.get("ellipse").and_then(Value::as_bool) == Some(true),
        sx,
        sy,
        frame,
    )))
}

fn raster_selection_alpha_clip(
    selection_alpha: &Value,
    clip: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Result<Vec<u8>, String> {
    let region = op_region(clip).ok_or_else(|| {
        "selection alpha clip requires a document-space region".to_string()
    })?;
    let alpha_width = selection_alpha
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| "selection alpha clip width must be a positive integer".to_string())?;
    let alpha_height = selection_alpha
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| "selection alpha clip height must be a positive integer".to_string())?;
    let starts_with = match selection_alpha
        .get("startsWith")
        .and_then(Value::as_u64)
    {
        Some(0) => 0u8,
        Some(255) => 255u8,
        Some(other) => {
            return Err(format!(
                "selection alpha clip startsWith must be 0 or 255, got {other}"
            ));
        }
        None => return Err("selection alpha clip startsWith is missing".to_string()),
    };
    let decoded = decode_selection_alpha_rle(
        selection_alpha
            .get("runs")
            .ok_or_else(|| "selection alpha clip runs are missing".to_string())?,
        alpha_width,
        alpha_height,
        starts_with,
    )?;
    let left = region[0].min(region[2]);
    let top = region[1].min(region[3]);
    let right = region[0].max(region[2]);
    let bottom = region[1].max(region[3]);
    if right <= left || bottom <= top {
        return Err("selection alpha clip region is empty".to_string());
    }
    let mut alpha = vec![0u8; (width * height) as usize];
    for y in 0..height {
        let doc_y = frame.y + (y as f32 + 0.5) / frame.sy(height);
        if doc_y < top || doc_y >= bottom {
            continue;
        }
        let my = (((doc_y - top) / (bottom - top)) * alpha_height as f32)
            .floor()
            .clamp(0.0, alpha_height.saturating_sub(1) as f32) as u32;
        for x in 0..width {
            let doc_x = frame.x + (x as f32 + 0.5) / frame.sx(width);
            if doc_x < left || doc_x >= right {
                continue;
            }
            let mx = (((doc_x - left) / (right - left)) * alpha_width as f32)
                .floor()
                .clamp(0.0, alpha_width.saturating_sub(1) as f32) as u32;
            alpha[(y * width + x) as usize] = decoded[(my * alpha_width + mx) as usize];
        }
    }
    Ok(alpha)
}

fn decode_selection_alpha_rle(
    runs: &Value,
    width: u32,
    height: u32,
    starts_with: u8,
) -> Result<Vec<u8>, String> {
    let total = width
        .checked_mul(height)
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| "selection alpha clip dimensions overflow".to_string())?;
    let mut out = vec![0u8; total];
    let mut cursor = 0usize;
    let mut value = if starts_with > 0 { 255u8 } else { 0u8 };
    for run in runs
        .as_array()
        .ok_or_else(|| "selection alpha clip runs must be an array".to_string())?
    {
        let count = run
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| "selection alpha clip run must be a non-negative integer".to_string())?;
        let end = cursor
            .checked_add(count)
            .ok_or_else(|| "selection alpha clip run length overflow".to_string())?;
        if end > total {
            return Err("selection alpha clip runs exceed dimensions".to_string());
        }
        if value > 0 {
            out[cursor..end].fill(255);
        }
        cursor = end;
        value = if value > 0 { 0 } else { 255 };
    }
    if cursor != total {
        return Err("selection alpha clip runs do not cover dimensions".to_string());
    }
    Ok(out)
}

fn raster_layer_mask(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Option<Vec<u8>> {
    let mask = layer.get("mask")?;
    if mask.get("disabled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let ops = mask.get("ops").and_then(Value::as_array)?;
    if ops.is_empty() {
        return None;
    }
    let mut alpha = vec![0u8; (width * height) as usize];
    let sx = frame.sx(width);
    let sy = frame.sy(height);
    for op in ops {
        let mode = op.get("mode").and_then(Value::as_str).unwrap_or("add");
        let Some(shape) = raster_mask_shape(op, width, height, sx, sy, frame) else {
            continue;
        };
        for (dst, src) in alpha.iter_mut().zip(shape.iter()) {
            match mode {
                "subtract" if *src > 0 => *dst = 0,
                "intersect" => *dst = if *src > 0 { *dst } else { 0 },
                _ if *src > 0 => *dst = 255,
                _ => {}
            }
        }
    }
    Some(alpha)
}

fn raster_mask_shape(
    op: &Value,
    width: u32,
    height: u32,
    sx: f32,
    sy: f32,
    frame: CompositeFrame,
) -> Option<Vec<u8>> {
    match op.get("type").and_then(Value::as_str) {
        Some("rect") | Some("ellipse") => {
            let region = op_region(op)?;
            Some(raster_region_shape(
                width,
                height,
                &region,
                op.get("type").and_then(Value::as_str) == Some("ellipse"),
                sx,
                sy,
                frame,
            ))
        }
        Some("path") => {
            let points = op
                .get("points")?
                .as_array()?
                .iter()
                .filter_map(|p| {
                    Some((
                        (json_f32(p.get("x"), 0.0) - frame.x) * sx,
                        (json_f32(p.get("y"), 0.0) - frame.y) * sy,
                    ))
                })
                .collect::<Vec<_>>();
            (points.len() >= 3).then(|| raster_polygon_shape(width, height, &points))
        }
        _ => None,
    }
}

fn op_region(op: &Value) -> Option<[f32; 4]> {
    let values = op.get("region")?.as_array()?;
    if values.len() < 4 {
        return None;
    }
    Some([
        json_f32(values.first(), 0.0),
        json_f32(values.get(1), 0.0),
        json_f32(values.get(2), 0.0),
        json_f32(values.get(3), 0.0),
    ])
}

fn raster_region_shape(
    width: u32,
    height: u32,
    region: &[f32; 4],
    ellipse: bool,
    sx: f32,
    sy: f32,
    frame: CompositeFrame,
) -> Vec<u8> {
    let mut alpha = vec![0u8; (width * height) as usize];
    let x1 = (region[0].min(region[2]) - frame.x) * sx;
    let y1 = (region[1].min(region[3]) - frame.y) * sy;
    let x2 = (region[0].max(region[2]) - frame.x) * sx;
    let y2 = (region[1].max(region[3]) - frame.y) * sy;
    let cx = (x1 + x2) * 0.5;
    let cy = (y1 + y2) * 0.5;
    let rx = ((x2 - x1) * 0.5).max(0.5);
    let ry = ((y2 - y1) * 0.5).max(0.5);
    let px0 = x1.floor().max(0.0) as u32;
    let py0 = y1.floor().max(0.0) as u32;
    let px1 = (x2.ceil() as i64).clamp(0, width as i64 - 1) as u32;
    let py1 = (y2.ceil() as i64).clamp(0, height as i64 - 1) as u32;
    for y in py0..=py1 {
        for x in px0..=px1 {
            if ellipse {
                let nx = (x as f32 + 0.5 - cx) / rx;
                let ny = (y as f32 + 0.5 - cy) / ry;
                if nx * nx + ny * ny > 1.0 {
                    continue;
                }
            }
            alpha[(y * width + x) as usize] = 255;
        }
    }
    alpha
}

fn raster_polygon_shape(width: u32, height: u32, points: &[(f32, f32)]) -> Vec<u8> {
    let mut alpha = vec![0u8; (width * height) as usize];
    for y in 0..height {
        for x in 0..width {
            if point_in_polygon(x as f32 + 0.5, y as f32 + 0.5, points) {
                alpha[(y * width + x) as usize] = 255;
            }
        }
    }
    alpha
}

fn point_in_polygon(x: f32, y: f32, points: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let mut j = points.len() - 1;
    for i in 0..points.len() {
        let (xi, yi) = points[i];
        let (xj, yj) = points[j];
        if ((yi > y) != (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn transformed_layer(
    source: &GradeSurface,
    mask: Option<&[u8]>,
    transform: LayerTransform,
    mask_linked: bool,
    transform_center: (f32, f32),
) -> (GradeSurface, Option<Vec<f32>>) {
    let mut data = vec![0.0; source.data.len()];
    let mut gate = mask.map(|_| vec![0.0; (source.w * source.h) as usize]);
    for y in 0..source.h {
        for x in 0..source.w {
            let Some((sx, sy)) =
                inverse_layer_sample_about(x, y, source.w, source.h, transform, transform_center)
            else {
                continue;
            };
            let dst_index = (y * source.w + x) as usize;
            let px = bilinear_sample(source, sx, sy);
            data[dst_index * 4..dst_index * 4 + 4].copy_from_slice(&px);
            if let (Some(mask), Some(gate)) = (mask, gate.as_mut()) {
                let src_index = (sy.round() as u32).min(source.h - 1) * source.w
                    + (sx.round() as u32).min(source.w - 1);
                gate[dst_index] = f32::from(
                    mask[if mask_linked {
                        src_index as usize
                    } else {
                        dst_index
                    }],
                ) / 255.0;
            }
        }
    }
    (
        GradeSurface {
            w: source.w,
            h: source.h,
            data,
            space: source.space,
        },
        gate,
    )
}

fn inverse_layer_sample(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    transform: LayerTransform,
) -> Option<(f32, f32)> {
    inverse_layer_sample_about(
        x,
        y,
        width,
        height,
        transform,
        (width as f32 / 2.0, height as f32 / 2.0),
    )
}

fn inverse_layer_sample_about(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    transform: LayerTransform,
    center: (f32, f32),
) -> Option<(f32, f32)> {
    if !transform.is_finite() {
        return None;
    }
    if transform.is_identity() {
        return Some((x as f32, y as f32));
    }
    let (cx, cy) = center;
    let s = transform.scale.max(1e-6);
    let rad = transform.rotate.to_radians();
    let (sin, cos) = rad.sin_cos();
    let tx = x as f32 + 0.5 - transform.dx - cx;
    let ty = y as f32 + 0.5 - transform.dy - cy;
    let sx = (tx * cos + ty * sin) / s + cx - 0.5;
    let sy = (-tx * sin + ty * cos) / s + cy - 0.5;
    if sx < -0.5 || sy < -0.5 || sx >= width as f32 - 0.5 || sy >= height as f32 - 0.5 {
        return None;
    }
    Some((sx, sy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ImageDocumentFixtures {
        rgba_composite_cases: Vec<RgbaCompositeCase>,
        transform_compose_cases: Vec<TransformComposeCase>,
        transform_inverse_sample_cases: Vec<TransformInverseSampleCase>,
    }

    #[derive(Deserialize)]
    struct TransformCaseParams {
        dx: f32,
        dy: f32,
        scale: f32,
        rotate: f32,
    }

    impl From<&TransformCaseParams> for LayerTransform {
        fn from(params: &TransformCaseParams) -> Self {
            LayerTransform {
                dx: params.dx,
                dy: params.dy,
                scale: params.scale,
                rotate: params.rotate,
            }
        }
    }

    #[derive(Deserialize)]
    struct TransformComposeCase {
        name: String,
        a: TransformCaseParams,
        b: TransformCaseParams,
        expected: TransformCaseParams,
    }

    #[derive(Deserialize)]
    struct TransformInverseSampleCase {
        name: String,
        width: u32,
        height: u32,
        transform: TransformCaseParams,
        x: u32,
        y: u32,
        expected: Option<[f32; 2]>,
    }

    #[derive(Deserialize)]
    struct RgbaCompositeCase {
        name: String,
        mode: String,
        backdrop: [u8; 4],
        source: [u8; 4],
        opacity: f64,
        expected: [u8; 4],
    }

    fn contract_fixtures() -> ImageDocumentFixtures {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../studio-ui/src/editor/imageDocumentContractFixtures.json"
        );
        let raw = std::fs::read_to_string(path).expect("image-document fixtures readable");
        serde_json::from_str::<ImageDocumentFixtures>(&raw).expect("image-document fixtures parse")
    }

    #[test]
    fn compose_matches_the_shared_transform_contract() {
        let cases = contract_fixtures().transform_compose_cases;
        assert!(!cases.is_empty());
        for case in cases {
            let composed = compose_layer_transform(
                LayerTransform::from(&case.a),
                LayerTransform::from(&case.b),
            );
            let expected = LayerTransform::from(&case.expected);
            assert!(
                (composed.dx - expected.dx).abs() < 1e-4,
                "{}: dx",
                case.name
            );
            assert!(
                (composed.dy - expected.dy).abs() < 1e-4,
                "{}: dy",
                case.name
            );
            assert!(
                (composed.scale - expected.scale).abs() < 1e-4,
                "{}: scale",
                case.name
            );
            assert!(
                (composed.rotate - expected.rotate).abs() < 1e-4,
                "{}: rotate",
                case.name
            );
        }
    }

    #[test]
    fn inverse_sample_matches_the_shared_transform_contract() {
        let cases = contract_fixtures().transform_inverse_sample_cases;
        assert!(!cases.is_empty());
        for case in cases {
            let sample = inverse_layer_sample(
                case.x,
                case.y,
                case.width,
                case.height,
                LayerTransform::from(&case.transform),
            );
            match (sample, case.expected) {
                (Some((sx, sy)), Some([ex, ey])) => {
                    assert!((sx - ex).abs() < 1e-4, "{}: sx", case.name);
                    assert!((sy - ey).abs() < 1e-4, "{}: sy", case.name);
                }
                (None, None) => {}
                (sample, expected) => panic!(
                    "{}: sample {:?} does not match expected {:?}",
                    case.name, sample, expected
                ),
            }
        }
    }

    #[test]
    fn composite_matches_the_shared_rgba_contract() {
        let cases = contract_fixtures().rgba_composite_cases;
        assert!(!cases.is_empty());
        for case in cases {
            let mut source = RgbaImage::new(2, 1);
            source.put_pixel(0, 0, Rgba(case.source));
            source.put_pixel(1, 0, Rgba(case.backdrop));
            let document = json!({
                "layers": [
                    {
                        "kind": "mask",
                        "visible": true,
                        "opacity": 1.0,
                        "blend": "normal",
                        "ops": []
                    },
                    {
                        "kind": "mask",
                        "visible": true,
                        "opacity": case.opacity,
                        "blend": case.mode,
                        "ops": [
                            { "type": "source_image" },
                            { "type": "transform", "dx": 1.0 }
                        ]
                    }
                ]
            });
            let output =
                composite_image_document(&source, &document, 2, 1).expect("composite image");
            assert_eq!(output.get_pixel(1, 0).0, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn placed_layer_draws_its_own_image_without_clipping_others() {
        let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                { "kind": "mask", "visible": true, "opacity": 1.0, "blend": "normal", "ops": [] },
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "green.png", "width": 2, "height": 2 },
                            "placement": [1.0, 1.0, 3.0, 3.0]
                        }
                    ]
                }
            ]
        });
        let mut load = |path: &str| {
            assert_eq!(path, "green.png");
            Ok(RgbaImage::from_pixel(2, 2, Rgba([0, 255, 0, 255])))
        };
        let output = composite_image_document_with_sources(&source, &document, 4, 4, 4, &mut load)
            .expect("composite placed layer");
        // Outside the placement the base layer still shows (not clipped).
        assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(output.get_pixel(3, 3).0, [255, 0, 0, 255]);
        // Inside the placement the layer's own image draws.
        assert_eq!(output.get_pixel(1, 1).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(2, 2).0, [0, 255, 0, 255]);
    }

    #[test]
    fn source_image_clip_rasterizes_exact_selection_alpha() {
        let source = RgbaImage::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                { "kind": "mask", "visible": false, "opacity": 1.0, "blend": "normal", "ops": [] },
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "green.png", "width": 4, "height": 2 },
                            "placement": [0.0, 0.0, 4.0, 2.0],
                            "clip": {
                                "region": [0.0, 0.0, 4.0, 2.0],
                                "selectionAlpha": { "width": 4, "height": 2, "startsWith": 0, "runs": [1, 2, 2, 3] }
                            }
                        }
                    ]
                }
            ]
        });
        let mut load = |path: &str| {
            assert_eq!(path, "green.png");
            Ok(RgbaImage::from_pixel(4, 2, Rgba([0, 255, 0, 255])))
        };

        let output = composite_image_document_with_sources(&source, &document, 4, 2, 4, &mut load)
            .expect("composite selection-alpha clip");

        assert_eq!(output.dimensions(), (4, 2));
        assert_eq!(output.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(output.get_pixel(1, 0).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(2, 0).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(3, 0).0, [0, 0, 0, 0]);
        assert_eq!(output.get_pixel(0, 1).0, [0, 0, 0, 0]);
        assert_eq!(output.get_pixel(1, 1).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(2, 1).0, [0, 255, 0, 255]);
        assert_eq!(output.get_pixel(3, 1).0, [0, 255, 0, 255]);
    }

    #[test]
    fn source_image_clip_rejects_malformed_selection_alpha_runs() {
        let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "clip": {
                                "region": [0.0, 0.0, 2.0, 2.0],
                                "selectionAlpha": { "width": 2, "height": 2, "startsWith": 0, "runs": [1, 1] }
                            }
                        }
                    ]
                }
            ]
        });

        let err = composite_image_document_with_sources(&source, &document, 2, 2, 2, &mut |_| {
            Err("unused".into())
        })
        .expect_err("malformed selection-alpha clips must not fall back to a rect");

        assert!(err.contains("runs do not cover dimensions"));
    }

    #[test]
    fn scene_frame_renders_placed_layers_outside_the_document_rect() {
        let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                { "kind": "mask", "visible": true, "opacity": 1.0, "blend": "normal", "ops": [] },
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "green.png", "width": 4, "height": 4 },
                            "placement": [1.0, 5.0, 3.0, 7.0]
                        }
                    ]
                }
            ]
        });
        let mut load = |path: &str| {
            assert_eq!(path, "green.png");
            Ok(RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])))
        };
        let output = composite_image_document_with_sources_in_frame(
            &source, &document, 4, 4, 0.0, 0.0, 4, 8, 8, &mut load,
        )
        .expect("composite scene frame");
        assert_eq!(output.dimensions(), (4, 8));
        assert_eq!(output.get_pixel(2, 2).0, [255, 0, 0, 255]);
        assert_eq!(output.get_pixel(1, 5).0, [0, 255, 0, 255]);
        // The base image belongs to the document rect only; the pasteboard
        // below it is not filled unless a layer is actually placed there.
        assert_eq!(output.get_pixel(0, 7).0, [0, 0, 0, 0]);
    }

    #[test]
    fn scene_frame_sanitizes_non_finite_origin() {
        let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                { "kind": "mask", "visible": true, "opacity": 1.0, "blend": "normal", "ops": [] }
            ]
        });
        let output = composite_image_document_with_sources_in_frame(
            &source,
            &document,
            4,
            4,
            f32::NAN,
            f32::INFINITY,
            4,
            4,
            4,
            &mut |_| Err("unused".into()),
        )
        .expect("composite with non-finite frame origin");
        assert_eq!(output.dimensions(), (4, 4));
        assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn extreme_layer_transform_does_not_poison_sampling() {
        let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        { "type": "source_image" },
                        { "type": "transform", "dx": 1.0e300, "dy": -1.0e300, "scale": 1.0e300, "rotate": 1.0e300 }
                    ]
                }
            ]
        });
        let output =
            composite_image_document_with_sources(&source, &document, 4, 4, 4, &mut |_| {
                Err("unused".into())
            })
            .expect("composite with extreme transform");
        assert_eq!(output.dimensions(), (4, 4));
    }

    #[test]
    fn output_follows_the_document_size_not_the_shared_proxy() {
        // A small opened image must not drop a larger canvas's resolution:
        // the composite output is document-proportioned within the limit.
        let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                { "kind": "mask", "visible": true, "opacity": 1.0, "blend": "normal", "ops": [] }
            ]
        });
        let output =
            composite_image_document_with_sources(&source, &document, 8, 4, 8, &mut |_| {
                Err("unused".into())
            })
            .expect("composite at document size");
        assert_eq!(output.dimensions(), (8, 4));
        assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(output.get_pixel(7, 3).0, [255, 0, 0, 255]);
        // The limit caps the output without changing the aspect.
        let capped =
            composite_image_document_with_sources(&source, &document, 8, 4, 4, &mut |_| {
                Err("unused".into())
            })
            .expect("composite capped");
        assert_eq!(capped.dimensions(), (4, 2));
    }

    #[test]
    fn hidden_base_keeps_a_transformed_placed_layer_visible() {
        // Hiding the opened base layer must not blank a moved placed layer:
        // the placed layer still draws its own source through its transform.
        let source = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 255]));
        let mut load = |_: &str| Ok(RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])));
        let doc = |base_visible: bool, dx: f64| {
            json!({
                "layers": [
                    {
                        "kind": "mask",
                        "visible": base_visible,
                        "opacity": 1.0,
                        "blend": "normal",
                        "ops": []
                    },
                    {
                        "kind": "mask",
                        "visible": true,
                        "opacity": 1.0,
                        "blend": "normal",
                        "ops": [
                            {
                                "type": "source_image",
                                "source": { "path": "green.png", "width": 4, "height": 4 },
                                "placement": [2.0, 2.0, 6.0, 6.0]
                            },
                            { "type": "transform", "dx": dx, "dy": 0.0 }
                        ]
                    }
                ]
            })
        };
        for (name, base_visible, dx) in [
            ("base visible, unmoved", true, 0.0),
            ("base hidden, unmoved", false, 0.0),
            ("base visible, moved", true, 1.0),
            ("base hidden, moved", false, 1.0),
        ] {
            let out = composite_image_document_with_sources(
                &source,
                &doc(base_visible, dx),
                8,
                8,
                8,
                &mut load,
            )
            .expect("composite");
            let green = out.pixels().filter(|p| p.0 == [0, 255, 0, 255]).count();
            assert_eq!(green, 16, "placed layer pixels missing: {name}");
            let opaque = out.pixels().filter(|p| p.0[3] > 0).count();
            let expected = if base_visible { 64 } else { 16 };
            assert_eq!(opaque, expected, "unexpected coverage: {name}");
        }
    }

    #[test]
    fn explicit_full_canvas_base_source_matches_the_implicit_base() {
        // The de-specialised base layer states its own source and a
        // full-canvas placement; the composite must be identical to the
        // legacy implicit "index 0 draws the shared image" layer.
        let mut source = RgbaImage::from_pixel(8, 6, Rgba([255, 0, 0, 255]));
        source.put_pixel(2, 3, Rgba([0, 0, 255, 255]));
        let upper = json!({
            "kind": "mask",
            "visible": true,
            "opacity": 1.0,
            "blend": "normal",
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "green.png", "width": 2, "height": 2 },
                    "placement": [1.0, 1.0, 3.0, 3.0]
                },
                { "type": "transform", "dx": 1.0, "dy": 0.0 }
            ]
        });
        let implicit = json!({
            "layers": [
                { "kind": "mask", "visible": true, "opacity": 1.0, "blend": "normal", "ops": [] },
                upper.clone()
            ]
        });
        let explicit = json!({
            "layers": [
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "base.png", "width": 8, "height": 6 },
                            "placement": [0.0, 0.0, 8.0, 6.0]
                        }
                    ]
                },
                upper
            ]
        });
        let base = source.clone();
        let mut load = move |path: &str| match path {
            "base.png" => Ok(base.clone()),
            "green.png" => Ok(RgbaImage::from_pixel(2, 2, Rgba([0, 255, 0, 255]))),
            other => Err(format!("unexpected source {other}")),
        };
        let a = composite_image_document_with_sources(&source, &implicit, 8, 6, 8, &mut load)
            .expect("implicit base composite");
        let b = composite_image_document_with_sources(&source, &explicit, 8, 6, 8, &mut load)
            .expect("explicit base composite");
        assert_eq!(a, b);
    }

    #[test]
    fn selection_assist_read_materializes_only_the_selected_pixel_layer() {
        let source = RgbaImage::from_pixel(6, 6, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                {
                    "id": "base",
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": []
                },
                {
                    "id": "picked",
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "green.png", "width": 2, "height": 2 },
                            "placement": [2.0, 2.0, 4.0, 4.0]
                        }
                    ]
                }
            ]
        });
        let mut load = |path: &str| match path {
            "green.png" => Ok(RgbaImage::from_pixel(2, 2, Rgba([0, 255, 0, 255]))),
            other => Err(format!("unexpected source {other}")),
        };

        let out = selection_assist_layer_pixels_in_frame(
            &source,
            &document,
            "picked",
            6,
            6,
            0.0,
            0.0,
            6,
            6,
            6,
            &mut load,
        )
        .expect("assist pixels");

        assert_eq!(out.dimensions(), (6, 6));
        assert_eq!(out.get_pixel(2, 2).0, [0, 255, 0, 255]);
        assert_eq!(out.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert!(
            out.pixels().all(|p| p.0 != [255, 0, 0, 255]),
            "assist read must not include the lower base layer"
        );
    }

    #[test]
    fn selection_assist_read_rejects_non_pixel_layers() {
        let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
        let document = json!({
            "layers": [
                {
                    "id": "adjustment",
                    "kind": "adjustment",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": []
                }
            ]
        });
        let mut load = |_: &str| Err("unused".into());

        let err = selection_assist_layer_pixels_in_frame(
            &source,
            &document,
            "adjustment",
            2,
            2,
            0.0,
            0.0,
            2,
            2,
            2,
            &mut load,
        )
        .expect_err("adjustment layers cannot be assist-read sources");

        assert!(err.contains("not an active editable pixel layer"));
    }

    #[test]
    fn selected_layer_frame_resolves_layer_placement_and_transform() {
        let document = json!({
            "layers": [
                {
                    "id": "layer-photo",
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "photo.png", "width": 80, "height": 40 },
                            "placement": [-20.0, 10.0, 60.0, 50.0]
                        },
                        { "type": "transform", "dx": 5.0, "dy": -2.0 }
                    ]
                }
            ]
        });

        let frame =
            selected_layer_frame(&document, "layer-photo", 100, 80, None).expect("selected frame");

        assert_eq!(frame.owner, "selected-layer-frame");
        assert_eq!(frame.shape, "axis-aligned-rect");
        assert_eq!(frame.layer_id, "layer-photo");
        assert_eq!(frame.source_rect, [-20.0, 10.0, 60.0, 50.0]);
        assert_eq!(frame.rect, [-15.0, 8.0, 65.0, 48.0]);
        assert_eq!(frame.source, "asset-frame");
    }

    #[test]
    fn selected_layer_frame_uses_source_clip_and_ignores_masks_and_normal_op_clips() {
        let document = json!({
            "layers": [
                {
                    "id": "layer-with-mask",
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "photo.png", "width": 100, "height": 80 },
                            "placement": [0.0, 0.0, 100.0, 80.0],
                            "clip": { "region": [40.0, 20.0, 65.0, 45.0] }
                        },
                        {
                            "type": "invert",
                            "clip": { "region": [2.0, 3.0, 20.0, 30.0] }
                        }
                    ],
                    "mask": {
                        "id": "mask-1",
                        "ops": [{ "type": "rect", "region": [2.0, 3.0, 20.0, 30.0] }]
                    }
                }
            ]
        });

        let frame = selected_layer_frame(
            &document,
            "layer-with-mask",
            100,
            80,
            Some(SelectedLayerMoveDraft { dx: 7.0, dy: 9.0 }),
        )
        .expect("selected frame");

        assert_eq!(frame.source_rect, [40.0, 20.0, 65.0, 45.0]);
        assert_eq!(frame.rect, [47.0, 29.0, 72.0, 54.0]);
    }

    #[test]
    fn selected_layer_frame_requires_explicit_source_placement() {
        let document = json!({
            "layers": [
                {
                    "id": "source-without-placement",
                    "kind": "pixel",
                    "visible": true,
                    "opacity": 1.0,
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "photo.png", "width": 320, "height": 180 }
                        }
                    ]
                }
            ]
        });

        assert!(selected_layer_frame(
            &document,
            "source-without-placement",
            800,
            600,
            None,
        )
        .is_none());
    }

    #[test]
    fn selected_layer_frame_returns_none_for_non_image_layers() {
        let document = json!({
            "layers": [
                {
                    "id": "adjustment",
                    "kind": "adjustment",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": []
                }
            ]
        });

        assert!(selected_layer_frame(&document, "adjustment", 100, 80, None).is_none());
        assert!(selected_layer_frame(&document, "missing", 100, 80, None).is_none());
    }

    #[test]
    fn selected_layer_frame_requires_an_explicit_source_image_op() {
        let document = json!({
            "layers": [
                {
                    "id": "empty-base",
                    "kind": "pixel",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": []
                }
            ]
        });

        assert!(selected_layer_frame(&document, "empty-base", 800, 600, None).is_none());
    }

    #[test]
    fn missing_layer_stack_keeps_the_source() {
        let source = RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 40]));
        assert_eq!(
            composite_image_document(&source, &json!({}), 1, 1).expect("source fallback"),
            source
        );
    }
}
