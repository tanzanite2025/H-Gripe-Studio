use serde_json::Value;

use super::selected_layer_geometry::{
    json_f32, source_image_op, CompositeFrame, WORLD_COORDINATE_LIMIT,
};
use super::MAX_LAYER_VIA_COPY_PIXELS;

const MAX_SELECTION_POLYGON_POINTS: usize = 65_536;

#[derive(Debug)]
pub(super) struct LayerRasterGates {
    pub(super) linked: Option<Vec<u8>>,
    pub(super) unlinked: Option<Vec<u8>>,
}

pub(super) fn raster_layer_gates(
    layer: &Value,
    width: u32,
    height: u32,
    frame: CompositeFrame,
) -> Result<LayerRasterGates, String> {
    let mask = raster_layer_mask(layer, width, height, frame);
    let mut linked = raster_layer_clip(layer, width, height, frame)?;
    let mask_linked = layer
        .get("mask")
        .and_then(|mask| mask.get("unlinked"))
        .and_then(Value::as_bool)
        != Some(true);
    let unlinked = if mask_linked {
        if let Some(mask) = mask {
            if let Some(linked) = linked.as_mut() {
                for (destination, source) in linked.iter_mut().zip(mask.iter()) {
                    *destination = (*destination).min(*source);
                }
            } else {
                linked = Some(mask);
            }
        }
        None
    } else {
        mask
    };
    Ok(LayerRasterGates { linked, unlinked })
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
    let Some(clip) = source_image_op(layer).and_then(|op| op.get("clip")) else {
        return Ok(None);
    };
    if clip.is_null() {
        return Ok(None);
    }
    let region = strict_clip_region(clip)?;
    let sx = frame.sx(width);
    let sy = frame.sy(height);
    if let Some(selection_alpha) = clip.get("selectionAlpha").filter(|value| !value.is_null()) {
        return raster_selection_alpha_clip(selection_alpha, clip, width, height, frame).map(Some);
    }
    if let Some(points) = clip.get("points").filter(|value| !value.is_null()) {
        let points = points
            .as_array()
            .ok_or_else(|| "source clip points must be an array".to_string())?;
        if points.len() < 3 {
            return Err("source clip polygon must contain at least three points".to_string());
        }
        if points.len() > MAX_SELECTION_POLYGON_POINTS {
            return Err(format!(
                "source clip polygon exceeds {MAX_SELECTION_POLYGON_POINTS} points"
            ));
        }
        let polygon = points
            .iter()
            .enumerate()
            .map(|(index, point)| {
                let pair = point
                    .as_array()
                    .ok_or_else(|| format!("source clip point {index} must be an array"))?;
                if pair.len() != 2 {
                    return Err(format!(
                        "source clip point {index} must contain exactly two coordinates"
                    ));
                }
                let x = pair[0]
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("source clip point {index} x must be finite"))?;
                let y = pair[1]
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("source clip point {index} y must be finite"))?;
                if x.abs() > f64::from(WORLD_COORDINATE_LIMIT)
                    || y.abs() > f64::from(WORLD_COORDINATE_LIMIT)
                {
                    return Err(format!("source clip point {index} exceeds the world limit"));
                }
                Ok(((x as f32 - frame.x) * sx, (y as f32 - frame.y) * sy))
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(Some(raster_polygon_shape(width, height, &polygon)));
    }
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
    let region = strict_clip_region(clip)?;
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
    let starts_with = match selection_alpha.get("startsWith").and_then(Value::as_u64) {
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
    let pixel_count = u64::from(width) * u64::from(height);
    if pixel_count > MAX_LAYER_VIA_COPY_PIXELS {
        return Err(format!(
            "selection alpha clip is too large: {width}x{height} exceeds the pixel budget"
        ));
    }
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

fn strict_clip_region(clip: &Value) -> Result<[f32; 4], String> {
    let values = clip
        .get("region")
        .and_then(Value::as_array)
        .ok_or_else(|| "source clip requires a document-space region".to_string())?;
    if values.len() != 4 {
        return Err("source clip region must contain exactly four coordinates".to_string());
    }
    let mut region = [0.0f32; 4];
    for (index, value) in values.iter().enumerate() {
        let coordinate = value
            .as_f64()
            .filter(|coordinate| coordinate.is_finite())
            .ok_or_else(|| format!("source clip region coordinate {index} must be finite"))?;
        if coordinate.abs() > f64::from(WORLD_COORDINATE_LIMIT) {
            return Err(format!(
                "source clip region coordinate {index} exceeds the world limit"
            ));
        }
        region[index] = coordinate as f32;
    }
    let left = region[0].min(region[2]);
    let top = region[1].min(region[3]);
    let right = region[0].max(region[2]);
    let bottom = region[1].max(region[3]);
    if right <= left || bottom <= top {
        return Err("source clip region is empty".to_string());
    }
    Ok([left, top, right, bottom])
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
    let px0 = (x1.floor() as i64).clamp(0, width as i64) as u32;
    let py0 = (y1.floor() as i64).clamp(0, height as i64) as u32;
    let px1 = (x2.ceil() as i64).clamp(0, width as i64) as u32;
    let py1 = (y2.ceil() as i64).clamp(0, height as i64) as u32;
    for y in py0..py1 {
        for x in px0..px1 {
            let sample_x = x as f32 + 0.5;
            let sample_y = y as f32 + 0.5;
            if sample_x < x1 || sample_x >= x2 || sample_y < y1 || sample_y >= y2 {
                continue;
            }
            if ellipse {
                let nx = (sample_x - cx) / rx;
                let ny = (sample_y - cy) / ry;
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
