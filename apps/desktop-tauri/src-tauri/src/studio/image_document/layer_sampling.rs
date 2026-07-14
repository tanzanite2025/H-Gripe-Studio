use hgripe_grade::{GradeSpace, GradeSurface};
use image::RgbaImage;
use serde_json::Value;

use super::super::srgb_proxy_surface;
use super::layer_gate::CompiledLayerGates;
use super::selected_layer_geometry::{
    placement_rect_from_op, source_image_op, CompositeFrame, LayerTransform,
};

pub(super) fn placed_layer_surface(
    layer: &Value,
    shared: &GradeSurface,
    out_w: u32,
    out_h: u32,
    frame: CompositeFrame,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<Option<GradeSurface>, String> {
    let Some(op) = source_image_op(layer) else {
        return Ok(None);
    };
    let Some(placement) = placement_rect_from_op(op) else {
        return Ok(None);
    };
    let source_path = op
        .get("source")
        .and_then(|source| source.get("path"))
        .and_then(Value::as_str);
    let own_surface = match source_path {
        Some(path) => Some(srgb_proxy_surface(&load_source(path)?)?),
        None => None,
    };
    let image = own_surface.as_ref().unwrap_or(shared);
    Ok(Some(place_surface_in_frame(
        image,
        out_w,
        out_h,
        frame,
        placement.0,
    )))
}

pub(super) fn place_surface_in_frame(
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

/// Sample compact layer pixels through placement and transform directly into
/// one viewport-sized temporary surface. This is the retained-scene path: it
/// never materializes a placed full-frame surface before transforming it.
pub(super) fn render_placed_transformed_layer(
    image: &RgbaImage,
    gates: &CompiledLayerGates,
    out_w: u32,
    out_h: u32,
    frame: CompositeFrame,
    placement: [f32; 4],
    transform: LayerTransform,
    document_width: u32,
    document_height: u32,
) -> (GradeSurface, Option<Vec<f32>>) {
    let sx = frame.sx(out_w);
    let sy = frame.sy(out_h);
    let left = placement[0].min(placement[2]);
    let top = placement[1].min(placement[3]);
    let width = (placement[0].max(placement[2]) - left).max(1e-6);
    let height = (placement[1].max(placement[3]) - top).max(1e-6);
    let mut data = vec![0.0; (out_w * out_h * 4) as usize];
    let mut gate = (!gates.is_empty()).then(|| vec![0.0; (out_w * out_h) as usize]);
    for y in 0..out_h {
        for x in 0..out_w {
            let destination_x = frame.x + (x as f32 + 0.5) / sx;
            let destination_y = frame.y + (y as f32 + 0.5) / sy;
            let Some((base_x, base_y)) = inverse_document_sample(
                destination_x,
                destination_y,
                transform,
                document_width,
                document_height,
            ) else {
                continue;
            };
            let fx = (base_x - left) / width;
            let fy = (base_y - top) / height;
            if !(0.0..1.0).contains(&fx) || !(0.0..1.0).contains(&fy) {
                continue;
            }
            let dst_index = (y * out_w + x) as usize;
            let pixel = bilinear_sample_rgba(
                image,
                fx * image.width() as f32 - 0.5,
                fy * image.height() as f32 - 0.5,
            );
            data[dst_index * 4..dst_index * 4 + 4].copy_from_slice(&pixel);
            if let Some(gate) = gate.as_mut() {
                gate[dst_index] =
                    f32::from(gates.coverage((base_x, base_y), (destination_x, destination_y)))
                        / 255.0;
            }
        }
    }
    (
        GradeSurface {
            w: out_w,
            h: out_h,
            data,
            space: GradeSpace::Srgb,
        },
        gate,
    )
}

fn inverse_document_sample(
    x: f32,
    y: f32,
    transform: LayerTransform,
    document_width: u32,
    document_height: u32,
) -> Option<(f32, f32)> {
    if !transform.is_finite() || transform.scale <= 0.0 {
        return None;
    }
    let cx = document_width as f32 * 0.5;
    let cy = document_height as f32 * 0.5;
    let (sin, cos) = transform.rotate.to_radians().sin_cos();
    let tx = x - transform.dx - cx;
    let ty = y - transform.dy - cy;
    Some((
        (tx * cos + ty * sin) / transform.scale + cx,
        (-tx * sin + ty * cos) / transform.scale + cy,
    ))
}

fn bilinear_sample_rgba(image: &RgbaImage, fx: f32, fy: f32) -> [f32; 4] {
    if !fx.is_finite() || !fy.is_finite() {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let max_x = image.width().saturating_sub(1) as f32;
    let max_y = image.height().saturating_sub(1) as f32;
    let fx = fx.clamp(0.0, max_x);
    let fy = fy.clamp(0.0, max_y);
    let x0 = fx.floor() as u32;
    let y0 = fy.floor() as u32;
    let x1 = (x0 + 1).min(image.width() - 1);
    let y1 = (y0 + 1).min(image.height() - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let read = |x: u32, y: u32| -> [f32; 4] {
        let pixel = image.get_pixel(x, y).0;
        [
            f32::from(pixel[0]) / 255.0,
            f32::from(pixel[1]) / 255.0,
            f32::from(pixel[2]) / 255.0,
            f32::from(pixel[3]) / 255.0,
        ]
    };
    let (a, b, c, d) = (read(x0, y0), read(x1, y0), read(x0, y1), read(x1, y1));
    let mut output = [0.0; 4];
    for index in 0..4 {
        let top = a[index] + (b[index] - a[index]) * tx;
        let bottom = c[index] + (d[index] - c[index]) * tx;
        output[index] = top + (bottom - top) * ty;
    }
    output
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

/// The layer's alpha gate: its mask attachment intersected with the selection
/// a PS Layer Via Copy recorded on its ops as `clip` (the copy holds only the
/// selected region's pixels).
pub(super) fn transformed_layer(
    source: &GradeSurface,
    linked_gate: Option<&[u8]>,
    unlinked_gate: Option<&[u8]>,
    transform: LayerTransform,
    transform_center: (f32, f32),
) -> (GradeSurface, Option<Vec<f32>>) {
    let mut data = vec![0.0; source.data.len()];
    let mut gate = (linked_gate.is_some() || unlinked_gate.is_some())
        .then(|| vec![0.0; (source.w * source.h) as usize]);
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
            if let Some(gate) = gate.as_mut() {
                let source_x = sx.round().clamp(0.0, source.w.saturating_sub(1) as f32) as u32;
                let source_y = sy.round().clamp(0.0, source.h.saturating_sub(1) as f32) as u32;
                let src_index = source_y * source.w + source_x;
                let linked = linked_gate
                    .map(|values| values[src_index as usize])
                    .unwrap_or(255);
                let unlinked = unlinked_gate.map(|values| values[dst_index]).unwrap_or(255);
                gate[dst_index] = f32::from(linked.min(unlinked)) / 255.0;
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

pub(super) fn inverse_layer_sample(
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
