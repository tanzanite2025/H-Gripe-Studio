use hgripe_grade::{composite_over, BlendMode, GradeSpace, GradeSurface};
use image::RgbaImage;
use serde_json::Value;

use super::{srgb_proxy_surface, surface_to_rgba};

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
/// of the shared source proxy's dimensions — a small opened image must not
/// drop the whole canvas to its own resolution.
pub(crate) fn composite_image_document_with_sources(
    source: &RgbaImage,
    document: &Value,
    document_width: u32,
    document_height: u32,
    output_limit: u32,
    load_source: &mut dyn FnMut(&str) -> Result<RgbaImage, String>,
) -> Result<RgbaImage, String> {
    let Some(layers) = document.get("layers").and_then(Value::as_array) else {
        return Ok(source.clone());
    };
    let dw = document_width.max(1);
    let dh = document_height.max(1);
    let out_scale = (output_limit.max(1) as f32 / dw.max(dh) as f32).min(1.0);
    let out_w = ((dw as f32 * out_scale).round() as u32).max(1);
    let out_h = ((dh as f32 * out_scale).round() as u32).max(1);
    let source_surface = srgb_proxy_surface(source)?;
    // Legacy full-canvas layers draw the shared image over the whole output;
    // resampled once (bilinear) when the proxy and output sizes differ.
    let mut shared_full: Option<GradeSurface> = None;
    let mut shared_at_output = |shared: &GradeSurface| -> GradeSurface {
        if shared.w == out_w && shared.h == out_h {
            return shared.clone();
        }
        shared_full
            .get_or_insert_with(|| resample_surface(shared, out_w, out_h))
            .clone()
    };
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
        let mask = raster_layer_gate(layer, out_w, out_h, document_width, document_height);
        let transform = layer_transform(layer, out_w, out_h, document_width, document_height);
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
            load_source,
        )?;
        let layer_base = match placed {
            Some(placed) => placed,
            None => shared_at_output(&source_surface),
        };
        let (surface, gate) =
            transformed_layer(&layer_base, mask.as_deref(), transform, mask_linked);
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
                values.first()?.as_f64()? as f32,
                values.get(1)?.as_f64()? as f32,
                values.get(2)?.as_f64()? as f32,
                values.get(3)?.as_f64()? as f32,
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
            source.get("width")?.as_f64()? as f32,
            source.get("height")?.as_f64()? as f32,
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
    let sx = out_w as f32 / dw;
    let sy = out_h as f32 / dh;
    let px0 = placement[0].min(placement[2]) * sx;
    let py0 = placement[1].min(placement[3]) * sy;
    let px1 = placement[0].max(placement[2]) * sx;
    let py1 = placement[1].max(placement[3]) * sy;
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
    Ok(Some(GradeSurface {
        w: out_w,
        h: out_h,
        data,
        space: shared.space,
    }))
}

/// Clamped bilinear sample of a surface at pixel-space `(fx, fy)` (the pixel
/// grid's sample points sit at integer coordinates here).
fn bilinear_sample(surface: &GradeSurface, fx: f32, fy: f32) -> [f32; 4] {
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

/// Bilinear resample of a whole surface to `w × h`.
fn resample_surface(surface: &GradeSurface, w: u32, h: u32) -> GradeSurface {
    let mut data = vec![0.0; (w * h * 4) as usize];
    for y in 0..h {
        let fy = (y as f32 + 0.5) / h as f32 * surface.h as f32 - 0.5;
        for x in 0..w {
            let fx = (x as f32 + 0.5) / w as f32 * surface.w as f32 - 0.5;
            let px = bilinear_sample(surface, fx, fy);
            let dst = ((y * w + x) * 4) as usize;
            data[dst..dst + 4].copy_from_slice(&px);
        }
    }
    GradeSurface {
        w,
        h,
        data,
        space: surface.space,
    }
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
    document_width: u32,
    document_height: u32,
) -> LayerTransform {
    let sx = width as f32 / document_width.max(1) as f32;
    let sy = height as f32 / document_height.max(1) as f32;
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
            dx: op.get("dx").and_then(Value::as_f64).unwrap_or(0.0) as f32 * sx,
            dy: op.get("dy").and_then(Value::as_f64).unwrap_or(0.0) as f32 * sy,
            scale: op
                .get("scale")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .max(1e-6) as f32,
            rotate: op.get("rotate").and_then(Value::as_f64).unwrap_or(0.0) as f32,
        };
        transform = compose_layer_transform(transform, next);
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

/// The layer's alpha gate: its mask attachment intersected with the selection
/// a PS Layer Via Copy recorded on its ops as `clip` (the copy holds only the
/// selected region's pixels).
fn raster_layer_gate(
    layer: &Value,
    width: u32,
    height: u32,
    document_width: u32,
    document_height: u32,
) -> Option<Vec<u8>> {
    let mask = raster_layer_mask(layer, width, height, document_width, document_height);
    let clip = raster_layer_clip(layer, width, height, document_width, document_height);
    match (mask, clip) {
        (Some(mut mask), Some(clip)) => {
            for (dst, src) in mask.iter_mut().zip(clip.iter()) {
                *dst = (*dst).min(*src);
            }
            Some(mask)
        }
        (mask, clip) => mask.or(clip),
    }
}

/// Rasterise the selection recorded as `clip` on the layer's `source_image`
/// op: a rect / ellipse `region`, or an exact polygon when `points` is set.
fn raster_layer_clip(
    layer: &Value,
    width: u32,
    height: u32,
    document_width: u32,
    document_height: u32,
) -> Option<Vec<u8>> {
    let clip = layer
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|op| op.get("type").and_then(Value::as_str) == Some("source_image"))?
        .get("clip")?;
    let sx = width as f32 / document_width.max(1) as f32;
    let sy = height as f32 / document_height.max(1) as f32;
    if let Some(points) = clip.get("points").and_then(Value::as_array) {
        let polygon = points
            .iter()
            .filter_map(|p| {
                let pair = p.as_array()?;
                Some((
                    pair.first()?.as_f64()? as f32 * sx,
                    pair.get(1)?.as_f64()? as f32 * sy,
                ))
            })
            .collect::<Vec<_>>();
        if polygon.len() >= 3 {
            return Some(raster_polygon_shape(width, height, &polygon));
        }
    }
    let region = op_region(clip)?;
    Some(raster_region_shape(
        width,
        height,
        &region,
        clip.get("ellipse").and_then(Value::as_bool) == Some(true),
        sx,
        sy,
    ))
}

fn raster_layer_mask(
    layer: &Value,
    width: u32,
    height: u32,
    document_width: u32,
    document_height: u32,
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
    let sx = width as f32 / document_width.max(1) as f32;
    let sy = height as f32 / document_height.max(1) as f32;
    for op in ops {
        let mode = op.get("mode").and_then(Value::as_str).unwrap_or("add");
        let Some(shape) = raster_mask_shape(op, width, height, sx, sy) else {
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

fn raster_mask_shape(op: &Value, width: u32, height: u32, sx: f32, sy: f32) -> Option<Vec<u8>> {
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
            ))
        }
        Some("path") => {
            let points = op
                .get("points")?
                .as_array()?
                .iter()
                .filter_map(|p| {
                    Some((
                        p.get("x")?.as_f64()? as f32 * sx,
                        p.get("y")?.as_f64()? as f32 * sy,
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
        values.first()?.as_f64()? as f32,
        values.get(1)?.as_f64()? as f32,
        values.get(2)?.as_f64()? as f32,
        values.get(3)?.as_f64()? as f32,
    ])
}

fn raster_region_shape(
    width: u32,
    height: u32,
    region: &[f32; 4],
    ellipse: bool,
    sx: f32,
    sy: f32,
) -> Vec<u8> {
    let mut alpha = vec![0u8; (width * height) as usize];
    let x1 = region[0].min(region[2]) * sx;
    let y1 = region[1].min(region[3]) * sy;
    let x2 = region[0].max(region[2]) * sx;
    let y2 = region[1].max(region[3]) * sy;
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
) -> (GradeSurface, Option<Vec<f32>>) {
    let mut data = vec![0.0; source.data.len()];
    let mut gate = mask.map(|_| vec![0.0; (source.w * source.h) as usize]);
    for y in 0..source.h {
        for x in 0..source.w {
            let Some((sx, sy)) = inverse_layer_sample(x, y, source.w, source.h, transform) else {
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
    if transform.is_identity() {
        return Some((x as f32, y as f32));
    }
    let cx = width as f32 / 2.0;
    let cy = height as f32 / 2.0;
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

    fn rgba_composite_cases() -> Vec<RgbaCompositeCase> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../studio-ui/src/editor/imageDocumentContractFixtures.json"
        );
        let raw = std::fs::read_to_string(path).expect("image-document fixtures readable");
        serde_json::from_str::<ImageDocumentFixtures>(&raw)
            .expect("image-document fixtures parse")
            .rgba_composite_cases
    }

    #[test]
    fn composite_matches_the_shared_rgba_contract() {
        let cases = rgba_composite_cases();
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
    fn missing_layer_stack_keeps_the_source() {
        let source = RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 40]));
        assert_eq!(
            composite_image_document(&source, &json!({}), 1, 1).expect("source fallback"),
            source
        );
    }
}
