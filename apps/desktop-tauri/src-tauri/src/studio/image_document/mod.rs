use hgripe_grade::{composite_over, BlendMode, GradeSpace, GradeSurface};
use image::RgbaImage;
use serde_json::Value;

use super::surface_to_rgba;

const MAX_LAYER_VIA_COPY_PIXELS: u64 = 16_777_216;

mod layer_gate;
mod layer_sampling;
mod layer_via_copy;
mod mask_raster;
mod retained_scene;
mod selected_layer_geometry;
mod selected_layer_pixels;

use layer_gate::compile_layer_gates;
use layer_sampling::render_placed_transformed_layer;
pub(crate) use layer_via_copy::*;
pub(crate) use retained_scene::*;
#[cfg(test)]
use selected_layer_geometry::selected_layer_frame;
use selected_layer_geometry::{
    layer_document_transform, placement_rect_from_op, selected_layer_source_rect, source_image_op,
    CompositeFrame,
};
pub(crate) use selected_layer_geometry::{SelectedLayerFrame, SelectedLayerMoveDraft};
pub(crate) use selected_layer_pixels::*;

#[cfg(test)]
use layer_sampling::inverse_layer_sample;
#[cfg(test)]
use selected_layer_geometry::{compose_layer_transform, LayerTransform};

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
/// of the shared source proxy's dimensions 闁?a small opened image must not
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
    let layers = document
        .get("layers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let dw = document_width.max(1);
    let dh = document_height.max(1);
    let frame = CompositeFrame::new(frame_x, frame_y, frame_width, frame_height);
    let out_scale = (output_limit.max(1) as f32 / frame.w.max(frame.h)).min(1.0);
    let out_w = ((frame.w * out_scale).round() as u32).max(1);
    let out_h = ((frame.h * out_scale).round() as u32).max(1);
    let mut composite = GradeSurface {
        w: out_w,
        h: out_h,
        data: vec![0.0; (out_w * out_h * 4) as usize],
        space: GradeSpace::Srgb,
    };
    for layer in layers {
        if layer.get("visible").and_then(Value::as_bool) == Some(false)
            || layer.get("kind").and_then(Value::as_str) == Some("adjustment")
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
        let Some(source_op) = source_image_op(layer) else {
            continue;
        };
        let Some(placement) = placement_rect_from_op(source_op) else {
            continue;
        };
        let source_path = source_op
            .get("source")
            .and_then(|source| source.get("path"))
            .and_then(Value::as_str);
        let own_source = match source_path {
            Some(path) => Some(load_source(path)?),
            None => None,
        };
        let layer_pixels = own_source.as_ref().unwrap_or(source);
        let gates = compile_layer_gates(layer)?;
        let transform = layer_document_transform(layer, None)?;
        let (surface, gate) = render_placed_transformed_layer(
            layer_pixels,
            &gates,
            out_w,
            out_h,
            frame,
            placement.0,
            transform,
            dw,
            dh,
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
    let Some((selected_index, selected_layer)) = layers
        .iter()
        .enumerate()
        .find(|(_, layer)| layer.get("id").and_then(Value::as_str) == Some(selected_layer_id))
    else {
        return Err(format!("unknown selected layer id: {selected_layer_id}"));
    };
    if selected_layer_source_rect(selected_layer).is_none() {
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
    let isolated = document_with_only_selected_layer(document, selected_layer_id)?;
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

#[cfg(test)]
mod tests;
