use std::sync::Arc;

use hgripe_grade::{composite_over, BlendMode, GradeSpace, GradeSurface};
use image::RgbaImage;
use serde_json::Value;

use super::layer_gate::{compile_layer_gates, CompiledLayerGates};
use super::layer_sampling::render_placed_transformed_layer;
use super::selected_layer_geometry::{
    json_positive_f32, layer_document_transform, placement_rect_from_op,
    selected_layer_frame_for_layer, source_image_op, CompositeFrame, DocumentRect,
};
use super::{surface_to_rgba, SelectedLayerFrame, SelectedLayerMoveDraft};

const MAX_RETAINED_PIXEL_STORE_DETAIL: u32 = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RetainedImageSceneKey {
    source_path: String,
    document_key: String,
    document_width: u32,
    document_height: u32,
    frame_x_bits: u32,
    frame_y_bits: u32,
    frame_width: u32,
    frame_height: u32,
}

impl RetainedImageSceneKey {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        source_path: &str,
        document_key: &str,
        document_width: u32,
        document_height: u32,
        frame_x: f32,
        frame_y: f32,
        frame_width: u32,
        frame_height: u32,
    ) -> Self {
        Self {
            source_path: source_path.to_string(),
            document_key: document_key.to_string(),
            document_width: document_width.max(1),
            document_height: document_height.max(1),
            frame_x_bits: frame_x.to_bits(),
            frame_y_bits: frame_y.to_bits(),
            frame_width: frame_width.max(1),
            frame_height: frame_height.max(1),
        }
    }

    pub(crate) fn document_key(&self) -> &str {
        &self.document_key
    }
}

pub(crate) struct RetainedPixelLayer {
    id: String,
    document_layer: Value,
    placement: DocumentRect,
    pixels: Arc<RgbaImage>,
    gates: CompiledLayerGates,
}

/// One immutable image-document revision. Each node retains only its source
/// pixels and document-space properties; no document- or pasteboard-sized
/// layer surface is stored here.
pub(crate) struct RetainedImageScene {
    key: RetainedImageSceneKey,
    document_width: u32,
    document_height: u32,
    layers: Vec<RetainedPixelLayer>,
}

impl RetainedImageScene {
    pub(crate) fn key(&self) -> &RetainedImageSceneKey {
        &self.key
    }

    pub(crate) fn document_key(&self) -> &str {
        self.key.document_key()
    }
}

fn layer_source_detail(source: Option<&Value>, placement: DocumentRect) -> u32 {
    let placement_width = (placement.0[2] - placement.0[0]).ceil().max(1.0) as u32;
    let placement_height = (placement.0[3] - placement.0[1]).ceil().max(1.0) as u32;
    let width = source
        .and_then(|value| value.get("width"))
        .map(|value| json_positive_f32(Some(value), placement_width as f32) as u32)
        .unwrap_or(placement_width);
    let height = source
        .and_then(|value| value.get("height"))
        .map(|value| json_positive_f32(Some(value), placement_height as f32) as u32)
        .unwrap_or(placement_height);
    width.max(height).clamp(1, MAX_RETAINED_PIXEL_STORE_DETAIL)
}

/// Resolve an ordered layer scene from one document revision. An editable
/// pixel layer must own an enabled `source_image` op with explicit placement;
/// source natural size, clip bounds and document bounds are never substitutes.
pub(crate) fn retain_image_document_scene(
    key: RetainedImageSceneKey,
    document: &Value,
    document_width: u32,
    document_height: u32,
    shared_source: Arc<RgbaImage>,
    load_source: &mut dyn FnMut(&str, u32) -> Result<Arc<RgbaImage>, String>,
) -> Result<RetainedImageScene, String> {
    let layers = document
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "image composite target requires a layered image document".to_string())?;
    let mut retained = Vec::with_capacity(layers.len());
    for (document_index, layer) in layers.iter().enumerate() {
        if layer.get("visible").and_then(Value::as_bool) == Some(false)
            || layer.get("kind").and_then(Value::as_str) == Some("adjustment")
            || layer
                .get("opacity")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .clamp(0.0, 1.0)
                <= 0.0
        {
            continue;
        }
        let id = layer
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| format!("visible pixel layer at index {document_index} has no id"))?;
        let op = source_image_op(layer)
            .ok_or_else(|| format!("visible pixel layer {id} has no enabled source_image op"))?;
        let placement = placement_rect_from_op(op).ok_or_else(|| {
            format!("visible pixel layer {id} has no valid explicit source_image placement")
        })?;
        let source = op.get("source");
        let pixels = match source
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            Some(path) => load_source(path, layer_source_detail(source, placement))?,
            None => shared_source.clone(),
        };
        let _ = layer_document_transform(layer, None)?;
        let gates = compile_layer_gates(layer)?;
        retained.push(RetainedPixelLayer {
            id: id.to_string(),
            document_layer: layer.clone(),
            placement,
            pixels,
            gates,
        });
    }
    Ok(RetainedImageScene {
        key,
        document_width: document_width.max(1),
        document_height: document_height.max(1),
        layers: retained,
    })
}

pub(crate) struct RetainedSceneRender {
    pub(crate) image: RgbaImage,
    pub(crate) visible_frame: [f32; 4],
    pub(crate) selected_layer_frame: Option<SelectedLayerFrame>,
}

fn visible_frame_and_dimensions(
    frame: CompositeFrame,
    output_limit: u32,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
) -> (CompositeFrame, (u32, u32), (u32, u32)) {
    let scale = (output_limit.max(1) as f32 / frame.w.max(frame.h)).min(1.0);
    let full_width = ((frame.w * scale).round() as u32).max(1);
    let full_height = ((frame.h * scale).round() as u32).max(1);
    let zoom = zoom.max(1.0);
    let output_width = ((full_width as f32 / zoom).round() as u32).clamp(1, full_width);
    let output_height = ((full_height as f32 / zoom).round() as u32).clamp(1, full_height);
    let visible_width = frame.w * output_width as f32 / full_width as f32;
    let visible_height = frame.h * output_height as f32 / full_height as f32;
    let max_x = (frame.w - visible_width).max(0.0);
    let max_y = (frame.h - visible_height).max(0.0);
    let offset_x = (pan_x * frame.w).clamp(0.0, max_x);
    let offset_y = (pan_y * frame.h).clamp(0.0, max_y);
    (
        CompositeFrame {
            x: frame.x + offset_x,
            y: frame.y + offset_y,
            w: visible_width.max(1e-6),
            h: visible_height.max(1e-6),
        },
        (output_width, output_height),
        (full_width, full_height),
    )
}

fn blend_mode(layer: &Value) -> BlendMode {
    layer
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
        .unwrap_or(BlendMode::Normal)
}

fn layer_contributes_pixels(surface: &GradeSurface, gate: Option<&[f32]>) -> bool {
    surface
        .data
        .chunks_exact(4)
        .enumerate()
        .any(|(index, pixel)| pixel[3] > 0.0 && gate.is_none_or(|gate| gate[index] > 0.0))
}

/// Composite only the current camera window into one framebuffer. A moving
/// layer receives its draft transform in the same pass that produces the
/// selected-layer frame, so geometry can never describe another pixel frame.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_retained_image_scene(
    scene: &RetainedImageScene,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
    output_limit: u32,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    selected_layer_id: Option<&str>,
    affected_layer_ids: Option<&[String]>,
    move_draft: Option<SelectedLayerMoveDraft>,
) -> Result<RetainedSceneRender, String> {
    let frame = CompositeFrame::new(frame_x, frame_y, frame_width, frame_height);
    let (visible_frame, (out_w, out_h), _full_dimensions) =
        visible_frame_and_dimensions(frame, output_limit, zoom, pan_x, pan_y);
    let mut composite = GradeSurface {
        w: out_w,
        h: out_h,
        data: vec![0.0; (out_w * out_h * 4) as usize],
        space: GradeSpace::Srgb,
    };
    let mut selected_layer_frame = None;
    for layer in &scene.layers {
        let is_selected = selected_layer_id == Some(layer.id.as_str());
        let is_affected =
            affected_layer_ids.is_some_and(|ids| ids.iter().any(|id| id == &layer.id));
        let draft = is_affected.then_some(move_draft).flatten();
        let transform = layer_document_transform(&layer.document_layer, draft)?;
        let (surface, gate) = render_placed_transformed_layer(
            &layer.pixels,
            &layer.gates,
            out_w,
            out_h,
            visible_frame,
            layer.placement.0,
            transform,
            scene.document_width,
            scene.document_height,
        );
        let opacity = layer
            .document_layer
            .get("opacity")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.0, 1.0) as f32;
        if is_selected && layer_contributes_pixels(&surface, gate.as_deref()) {
            selected_layer_frame = selected_layer_frame_for_layer(
                &layer.document_layer,
                &layer.id,
                scene.document_width,
                scene.document_height,
                draft,
            )?;
        }
        composite_over(
            &mut composite,
            &surface,
            blend_mode(&layer.document_layer),
            opacity,
            gate.as_deref(),
        );
    }
    Ok(RetainedSceneRender {
        image: surface_to_rgba(&composite)?,
        visible_frame: [
            visible_frame.x,
            visible_frame.y,
            visible_frame.w,
            visible_frame.h,
        ],
        selected_layer_frame,
    })
}
