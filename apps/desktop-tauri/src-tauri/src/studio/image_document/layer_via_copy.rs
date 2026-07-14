use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::layer_gate::{
    compile_layer_gates, decode_selection_alpha_rle, DocumentGate, MAX_SELECTION_POLYGON_POINTS,
};
use super::selected_layer_geometry::{
    layer_document_transform, normalize_document_rect, source_image_op, transform_document_rect,
    DocumentRect, LayerTransform, WORLD_COORDINATE_LIMIT,
};
use super::MAX_LAYER_VIA_COPY_PIXELS;
use crate::studio::{image_buffer, studio_image};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerViaCopySelection {
    region: [f32; 4],
    #[serde(default)]
    ellipse: bool,
    points: Option<Vec<[f32; 2]>>,
    selection_alpha: Option<LayerViaCopySelectionAlpha>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerViaCopySelectionAlpha {
    width: u32,
    height: u32,
    starts_with: u8,
    runs: Vec<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerViaCopySource {
    path: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterializedLayerViaCopy {
    source: LayerViaCopySource,
    placement: [f32; 4],
}

#[derive(Debug)]
struct CompactLayerPixels {
    image: RgbaImage,
    placement: [f32; 4],
}

fn strict_rect(values: &Value, owner: &str) -> Result<DocumentRect, String> {
    let values = values
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

fn strict_selection_rect(region: [f32; 4]) -> Result<DocumentRect, String> {
    if !region
        .iter()
        .all(|coordinate| coordinate.is_finite() && coordinate.abs() <= WORLD_COORDINATE_LIMIT)
    {
        return Err("layer via copy selection region must contain finite coordinates".to_string());
    }
    normalize_document_rect(region)
        .ok_or_else(|| "layer via copy selection region is empty".to_string())
}

fn decode_selection_alpha(alpha: &LayerViaCopySelectionAlpha) -> Result<Vec<u8>, String> {
    decode_selection_alpha_rle(
        alpha.width,
        alpha.height,
        alpha.starts_with,
        &alpha.runs,
        "selection alpha",
    )
}

fn selection_gate(
    selection: &LayerViaCopySelection,
) -> Result<(DocumentRect, DocumentGate), String> {
    let rect = strict_selection_rect(selection.region)?;
    let gate =
        if let Some(alpha) = &selection.selection_alpha {
            DocumentGate::Alpha {
                rect,
                width: alpha.width,
                height: alpha.height,
                pixels: decode_selection_alpha(alpha)?,
            }
        } else if let Some(points) = &selection.points {
            if points.len() < 3 {
                return Err("layer via copy polygon must contain at least three points".to_string());
            }
            if points.len() > MAX_SELECTION_POLYGON_POINTS {
                return Err(format!(
                    "layer via copy polygon exceeds {MAX_SELECTION_POLYGON_POINTS} points"
                ));
            }
            if !points.iter().flatten().all(|coordinate| {
                coordinate.is_finite() && coordinate.abs() <= WORLD_COORDINATE_LIMIT
            }) {
                return Err("layer via copy polygon points must be finite".to_string());
            }
            DocumentGate::Polygon(points.clone())
        } else {
            DocumentGate::Region {
                rect,
                ellipse: selection.ellipse,
            }
        };
    Ok((rect, gate))
}

fn layer_opacity(layer: &Value) -> Result<f32, String> {
    let Some(value) = layer.get("opacity") else {
        return Ok(1.0);
    };
    let opacity = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| "selected layer opacity must be finite".to_string())?;
    if !(0.0..=1.0).contains(&opacity) {
        return Err("selected layer opacity must be between 0 and 1".to_string());
    }
    Ok(opacity as f32)
}

fn strict_placement(op: &Value) -> Result<DocumentRect, String> {
    strict_rect(
        op.get("placement")
            .ok_or_else(|| "selected layer has no explicit source_image placement".to_string())?,
        "selected layer source_image placement",
    )
}

fn source_path_from_op(op: &Value) -> Result<Option<&str>, String> {
    let Some(source) = op.get("source") else {
        return Ok(None);
    };
    if source.is_null() {
        return Ok(None);
    }
    let source = source
        .as_object()
        .ok_or_else(|| "selected layer source_image source must be an object".to_string())?;
    let path = source
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "selected layer source_image source requires a path".to_string())?
        .trim();
    if path.is_empty() {
        return Err("selected layer source_image source path is empty".to_string());
    }
    Ok(Some(path))
}

fn intersect_rect(a: DocumentRect, b: DocumentRect) -> Option<DocumentRect> {
    normalize_document_rect([
        a.0[0].max(b.0[0]),
        a.0[1].max(b.0[1]),
        a.0[2].min(b.0[2]),
        a.0[3].min(b.0[3]),
    ])
}

fn inverse_document_point(
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
    let scale = transform.scale;
    let (sin, cos) = transform.rotate.to_radians().sin_cos();
    let tx = x - transform.dx - cx;
    let ty = y - transform.dy - cy;
    Some((
        (tx * cos + ty * sin) / scale + cx,
        (-tx * sin + ty * cos) / scale + cy,
    ))
}

fn canonical_document_pixel_center(coordinate: f32, extent: u32) -> f32 {
    (coordinate - 0.5)
        .round()
        .clamp(0.0, extent.saturating_sub(1) as f32)
        + 0.5
}

fn bilinear_sample(image: &RgbaImage, x: f32, y: f32) -> [f32; 4] {
    let max_x = image.width().saturating_sub(1) as f32;
    let max_y = image.height().saturating_sub(1) as f32;
    let x = x.clamp(0.0, max_x);
    let y = y.clamp(0.0, max_y);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(image.width() - 1);
    let y1 = (y0 + 1).min(image.height() - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let read = |sample_x: u32, sample_y: u32| {
        let pixel = image.get_pixel(sample_x, sample_y).0;
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

#[derive(Clone, Copy)]
struct PolygonScanEdge {
    end_row: u32,
    x: f32,
    step_x: f32,
}

fn raster_polygon_selection(
    points: &[[f32; 2]],
    frame_left: i64,
    frame_top: i64,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut pending = Vec::<(u32, PolygonScanEdge)>::with_capacity(points.len());
    for index in 0..points.len() {
        let [x0, y0] = points[index];
        let [x1, y1] = points[(index + 1) % points.len()];
        if y0 == y1 {
            continue;
        }
        let (top_x, top_y, bottom_x, bottom_y) = if y0 < y1 {
            (x0, y0, x1, y1)
        } else {
            (x1, y1, x0, y0)
        };
        let start_row =
            ((top_y - frame_top as f32 - 0.5).ceil() as i64).clamp(0, i64::from(height)) as u32;
        let end_row =
            ((bottom_y - frame_top as f32 - 0.5).ceil() as i64).clamp(0, i64::from(height)) as u32;
        if start_row >= end_row {
            continue;
        }
        let step_x = (bottom_x - top_x) / (bottom_y - top_y);
        let sample_y = frame_top as f32 + start_row as f32 + 0.5;
        let x = top_x + (sample_y - top_y) * step_x;
        pending.push((start_row, PolygonScanEdge { end_row, x, step_x }));
    }
    pending.sort_by_key(|(start_row, _)| *start_row);

    let mut output = vec![0u8; (width * height) as usize];
    let mut active = Vec::<PolygonScanEdge>::new();
    let mut pending_index = 0usize;
    for row in 0..height {
        while pending_index < pending.len() && pending[pending_index].0 == row {
            active.push(pending[pending_index].1);
            pending_index += 1;
        }
        active.retain(|edge| edge.end_row > row);
        active.sort_by(|left, right| left.x.total_cmp(&right.x));
        for crossings in active.chunks_exact(2) {
            let left = crossings[0].x;
            let right = crossings[1].x;
            let start =
                ((left - frame_left as f32 - 0.5).ceil() as i64).clamp(0, i64::from(width)) as u32;
            let end =
                ((right - frame_left as f32 - 0.5).ceil() as i64).clamp(0, i64::from(width)) as u32;
            if start < end {
                let offset = (row * width) as usize;
                output[offset + start as usize..offset + end as usize].fill(255);
            }
        }
        for edge in &mut active {
            edge.x += edge.step_x;
        }
    }
    output
}

fn raster_active_polygon_selection(
    gate: &DocumentGate,
    frame_left: i64,
    frame_top: i64,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    if let DocumentGate::Polygon(points) = gate {
        return Some(raster_polygon_selection(
            points, frame_left, frame_top, width, height,
        ));
    }
    None
}

fn alpha_bounds(image: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let (width, height) = image.dimensions();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0u32, 0u32);
    let mut found = false;
    for y in 0..height {
        for x in 0..width {
            if image.get_pixel(x, y).0[3] == 0 {
                continue;
            }
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if found {
        Some((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
    } else {
        None
    }
}

fn materialize_layer_via_copy_pixels(
    document: &Value,
    selected_layer_id: &str,
    selection: &LayerViaCopySelection,
    document_width: u32,
    document_height: u32,
    load_source: &mut dyn FnMut(Option<&str>) -> Result<RgbaImage, String>,
) -> Result<Option<CompactLayerPixels>, String> {
    if document_width == 0 || document_height == 0 {
        return Err("layer via copy requires non-zero document dimensions".to_string());
    }
    let layers = document
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "layer via copy requires a layered image document".to_string())?;
    let layer = layers
        .iter()
        .find(|layer| layer.get("id").and_then(Value::as_str) == Some(selected_layer_id))
        .ok_or_else(|| format!("unknown selected layer id: {selected_layer_id}"))?;
    if layer.get("kind").and_then(Value::as_str) != Some("pixel") {
        return Err(format!(
            "selected layer {selected_layer_id} is not an editable pixel layer"
        ));
    }
    if layer.get("locked").and_then(Value::as_bool) == Some(true) {
        return Err(format!("selected layer {selected_layer_id} is locked"));
    }
    let opacity = layer_opacity(layer)?;
    if layer.get("visible").and_then(Value::as_bool) == Some(false) || opacity <= 0.0 {
        return Ok(None);
    }
    let transform = layer_document_transform(layer, None)?;
    let op = source_image_op(layer).ok_or_else(|| {
        format!("selected layer {selected_layer_id} has no enabled source_image op")
    })?;
    let placement = strict_placement(op)?;
    let source_path = source_path_from_op(op)?;
    let source = load_source(source_path)?;
    if source.width() == 0 || source.height() == 0 {
        return Err("selected layer source image is empty".to_string());
    }
    let transformed =
        transform_document_rect(placement, transform, document_width, document_height);
    let (selection_rect, active_selection) = selection_gate(selection)?;
    let Some(candidate) = intersect_rect(transformed, selection_rect) else {
        return Ok(None);
    };
    let frame_left = candidate.0[0].floor() as i64;
    let frame_top = candidate.0[1].floor() as i64;
    let frame_right = candidate.0[2].ceil() as i64;
    let frame_bottom = candidate.0[3].ceil() as i64;
    let width = u32::try_from(frame_right - frame_left)
        .map_err(|_| "layer via copy output width is invalid".to_string())?;
    let height = u32::try_from(frame_bottom - frame_top)
        .map_err(|_| "layer via copy output height is invalid".to_string())?;
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let output_pixels = u64::from(width) * u64::from(height);
    if output_pixels > MAX_LAYER_VIA_COPY_PIXELS {
        return Err(format!(
            "layer via copy output is too large: {width}x{height} exceeds the pixel budget"
        ));
    }
    let active_selection_pixels =
        raster_active_polygon_selection(&active_selection, frame_left, frame_top, width, height);
    let layer_gates = compile_layer_gates(layer)?;
    let [placement_left, placement_top, placement_right, placement_bottom] = placement.0;
    let placement_width = placement_right - placement_left;
    let placement_height = placement_bottom - placement_top;
    let mut rendered = RgbaImage::new(width, height);
    for y in 0..height {
        let destination_y = frame_top as f32 + y as f32 + 0.5;
        for x in 0..width {
            let destination_x = frame_left as f32 + x as f32 + 0.5;
            let destination_index = (y * width + x) as usize;
            let selection_coverage = active_selection_pixels
                .as_ref()
                .map(|pixels| pixels[destination_index])
                .unwrap_or_else(|| active_selection.coverage(destination_x, destination_y));
            if selection_coverage == 0 {
                continue;
            }
            let Some((base_x, base_y)) = inverse_document_point(
                destination_x,
                destination_y,
                transform,
                document_width,
                document_height,
            ) else {
                continue;
            };
            let source_x = (base_x - placement_left) / placement_width;
            let source_y = (base_y - placement_top) / placement_height;
            if !(0.0..1.0).contains(&source_x) || !(0.0..1.0).contains(&source_y) {
                continue;
            }
            let sample = bilinear_sample(
                &source,
                source_x * source.width() as f32 - 0.5,
                source_y * source.height() as f32 - 0.5,
            );
            let mut alpha = sample[3];
            alpha *=
                f32::from(layer_gates.coverage((base_x, base_y), (destination_x, destination_y)))
                    / 255.0;
            alpha *= opacity;
            // The committed selection is a read constraint in document space.
            // Apply it last so it never follows the layer transform or mask link.
            alpha *= f32::from(selection_coverage) / 255.0;
            let alpha = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
            if alpha == 0 {
                continue;
            }
            rendered.put_pixel(
                x,
                y,
                Rgba([
                    (sample[0].clamp(0.0, 1.0) * 255.0).round() as u8,
                    (sample[1].clamp(0.0, 1.0) * 255.0).round() as u8,
                    (sample[2].clamp(0.0, 1.0) * 255.0).round() as u8,
                    alpha,
                ]),
            );
        }
    }
    let Some((crop_x, crop_y, crop_width, crop_height)) = alpha_bounds(&rendered) else {
        return Ok(None);
    };
    let image =
        image::imageops::crop_imm(&rendered, crop_x, crop_y, crop_width, crop_height).to_image();
    let left = frame_left as f32 + crop_x as f32;
    let top = frame_top as f32 + crop_y as f32;
    Ok(Some(CompactLayerPixels {
        image,
        placement: [
            left,
            top,
            left + crop_width as f32,
            top + crop_height as f32,
        ],
    }))
}

fn content_hash(image: &RgbaImage) -> String {
    let mut hash = Sha256::new();
    hash.update(image.width().to_le_bytes());
    hash.update(image.height().to_le_bytes());
    hash.update(image.as_raw());
    format!("{:x}", hash.finalize())
}

fn unique_temp_path(directory: &Path, hash: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    directory.join(format!(".{hash}.{}.{}.tmp", std::process::id(), nanos))
}

fn persist_compact_pixels(
    directory: &Path,
    pixels: &CompactLayerPixels,
) -> Result<(LayerViaCopySource, String), String> {
    fs::create_dir_all(directory)
        .map_err(|err| format!("failed to create {}: {err}", directory.display()))?;
    let hash = content_hash(&pixels.image);
    let output_path = directory.join(format!("{hash}.png"));
    let mut verify_existing = output_path.is_file();
    if !verify_existing {
        let temp_path = unique_temp_path(directory, &hash);
        let write_result = (|| {
            let mut file = File::create(&temp_path)
                .map_err(|err| format!("failed to create {}: {err}", temp_path.display()))?;
            pixels
                .image
                .write_to(&mut file, image::ImageFormat::Png)
                .map_err(|err| format!("failed to encode {}: {err}", temp_path.display()))?;
            file.sync_all()
                .map_err(|err| format!("failed to flush {}: {err}", temp_path.display()))?;
            match fs::rename(&temp_path, &output_path) {
                Ok(()) => Ok(()),
                Err(_) if output_path.is_file() => {
                    let _ = fs::remove_file(&temp_path);
                    verify_existing = true;
                    Ok(())
                }
                Err(err) => Err(format!(
                    "failed to publish {}: {err}",
                    output_path.display()
                )),
            }
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result?;
    }
    if verify_existing {
        let persisted = image::open(&output_path)
            .map_err(|err| format!("failed to verify {}: {err}", output_path.display()))?
            .into_rgba8();
        if persisted != pixels.image {
            return Err(format!(
                "content-addressed layer pixels do not match {}",
                output_path.display()
            ));
        }
    }
    let canonical = fs::canonicalize(&output_path)
        .map_err(|err| format!("failed to resolve {}: {err}", output_path.display()))?;
    image_buffer::publish_rgba(&canonical, &pixels.image, studio_image::png_output_meta());
    Ok((
        LayerViaCopySource {
            path: canonical.to_string_lossy().to_string(),
            width: pixels.image.width(),
            height: pixels.image.height(),
        },
        hash,
    ))
}

#[allow(clippy::too_many_arguments)]
fn materialize_layer_via_copy_inner(
    image_path: Option<String>,
    document: Value,
    selected_layer_id: String,
    selection: LayerViaCopySelection,
    document_width: u32,
    document_height: u32,
) -> Result<Option<MaterializedLayerViaCopy>, String> {
    let shared_path = image_path.unwrap_or_default().trim().to_string();
    let mut load_source = |layer_path: Option<&str>| {
        let path = match layer_path {
            Some(path) => path,
            None if !shared_path.is_empty() => shared_path.as_str(),
            None => return Err("layer via copy requires an image path".to_string()),
        };
        studio_image::load_rgba(Path::new(path), studio_image::DEFAULT_MAX_DECODE_PIXELS)
            .map(|loaded| loaded.image)
    };
    let Some(pixels) = materialize_layer_via_copy_pixels(
        &document,
        &selected_layer_id,
        &selection,
        document_width,
        document_height,
        &mut load_source,
    )?
    else {
        return Ok(None);
    };
    let directory = crate::cache_subdir(".image-editor/layer-pixels")?;
    let placement = pixels.placement;
    let pixel_width = pixels.image.width() as f32;
    let pixel_height = pixels.image.height() as f32;
    if !placement.iter().all(|coordinate| coordinate.fract() == 0.0)
        || placement[2] - placement[0] != pixel_width
        || placement[3] - placement[1] != pixel_height
    {
        return Err("layer via copy produced inconsistent compact geometry".to_string());
    }
    let (source, _content_hash) = persist_compact_pixels(&directory, &pixels)?;
    Ok(Some(MaterializedLayerViaCopy { source, placement }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn materialize_layer_via_copy(
    image_path: Option<String>,
    document: Value,
    selected_layer_id: String,
    selection: LayerViaCopySelection,
    document_width: u32,
    document_height: u32,
) -> Result<Option<MaterializedLayerViaCopy>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        materialize_layer_via_copy_inner(
            image_path,
            document,
            selected_layer_id,
            selection,
            document_width,
            document_height,
        )
    })
    .await
    .map_err(|err| format!("layer via copy worker failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    use crate::studio::image_document::CompositeFrame;
    use crate::studio::{
        render_retained_image_scene, retain_image_document_scene, RetainedImageSceneKey,
    };

    fn selection(region: [f32; 4]) -> LayerViaCopySelection {
        LayerViaCopySelection {
            region,
            ellipse: false,
            points: None,
            selection_alpha: None,
        }
    }

    #[test]
    fn wire_contract_uses_points_and_returns_only_source_plus_placement() {
        let selection: LayerViaCopySelection = serde_json::from_value(json!({
            "region": [1, 2, 4, 5],
            "points": [[1, 2], [4, 2], [1, 5]]
        }))
        .unwrap();
        assert_eq!(selection.points.as_ref().map(Vec::len), Some(3));

        let encoded = serde_json::to_value(MaterializedLayerViaCopy {
            source: LayerViaCopySource {
                path: "C:/pixels.png".to_string(),
                width: 3,
                height: 3,
            },
            placement: [1.0, 2.0, 4.0, 5.0],
        })
        .unwrap();
        assert_eq!(
            encoded,
            json!({
                "source": { "path": "C:/pixels.png", "width": 3, "height": 3 },
                "placement": [1.0, 2.0, 4.0, 5.0]
            })
        );
    }

    fn source_document(extra: Value) -> Value {
        let mut layer = json!({
            "id": "selected",
            "kind": "pixel",
            "visible": true,
            "opacity": 1.0,
            "blend": "normal",
            "ops": [{
                "type": "source_image",
                "source": { "path": "layer.png", "width": 4, "height": 2 },
                "placement": [0.0, 0.0, 4.0, 2.0]
            }]
        });
        if let Some(extra) = extra.as_object() {
            layer.as_object_mut().unwrap().extend(extra.clone());
        }
        json!({ "layers": [layer] })
    }

    fn materialize(
        document: &Value,
        active: &LayerViaCopySelection,
        source: RgbaImage,
        width: u32,
        height: u32,
    ) -> Result<Option<CompactLayerPixels>, String> {
        materialize_layer_via_copy_pixels(
            document,
            "selected",
            active,
            width,
            height,
            &mut |path| {
                assert_eq!(path, Some("layer.png"));
                Ok(source.clone())
            },
        )
    }

    fn isolated_retained_crop(
        document: &Value,
        source: &RgbaImage,
        width: u32,
        height: u32,
    ) -> Option<CompactLayerPixels> {
        let key = RetainedImageSceneKey::new(
            "shared.png",
            "differential",
            width,
            height,
            0.0,
            0.0,
            width,
            height,
        );
        let scene = retain_image_document_scene(
            key,
            document,
            width,
            height,
            Arc::new(source.clone()),
            &mut |path, _detail| {
                assert_eq!(path, "layer.png");
                Ok(Arc::new(source.clone()))
            },
        )
        .unwrap();
        let rendered = render_retained_image_scene(
            &scene,
            0.0,
            0.0,
            width,
            height,
            width.max(height),
            1.0,
            0.0,
            0.0,
            None,
            None,
            None,
        )
        .unwrap();
        let (x, y, crop_width, crop_height) = alpha_bounds(&rendered.image)?;
        Some(CompactLayerPixels {
            image: image::imageops::crop_imm(&rendered.image, x, y, crop_width, crop_height)
                .to_image(),
            placement: [
                x as f32,
                y as f32,
                (x + crop_width) as f32,
                (y + crop_height) as f32,
            ],
        })
    }

    fn assert_materialized_matches_retained(
        document: &Value,
        source: RgbaImage,
        width: u32,
        height: u32,
    ) -> CompactLayerPixels {
        let materialized = materialize(
            document,
            &selection([0.0, 0.0, width as f32, height as f32]),
            source.clone(),
            width,
            height,
        )
        .unwrap()
        .unwrap();
        let retained = isolated_retained_crop(document, &source, width, height).unwrap();
        assert_eq!(materialized.placement, retained.placement);
        assert_eq!(materialized.image, retained.image);
        materialized
    }

    #[test]
    fn rect_selection_bakes_document_space_translation_without_frame_clipping() {
        let mut document = source_document(json!({}));
        document["layers"][0]["ops"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "type": "transform", "dx": 3.0, "dy": 0.0 }));
        let result = materialize(
            &document,
            &selection([4.0, 0.0, 6.0, 2.0]),
            RgbaImage::from_pixel(4, 2, Rgba([220, 30, 40, 255])),
            10,
            4,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [4.0, 0.0, 6.0, 2.0]);
        assert_eq!(result.image.dimensions(), (2, 2));
        assert!(result
            .image
            .pixels()
            .all(|pixel| pixel.0 == [220, 30, 40, 255]));
    }

    #[test]
    fn scale_rotation_and_translation_are_baked_into_identity_placement() {
        let document = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 2, "height": 2 },
                    "placement": [3.0, 3.0, 5.0, 5.0]
                },
                { "type": "transform", "dx": 1.0, "dy": -1.0, "scale": 2.0, "rotate": 90.0 }
            ]
        }));
        let result = materialize(
            &document,
            &selection([0.0, 0.0, 8.0, 8.0]),
            RgbaImage::from_pixel(2, 2, Rgba([25, 125, 225, 255])),
            8,
            8,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [3.0, 1.0, 7.0, 5.0]);
        assert_eq!(result.image.dimensions(), (4, 4));
        assert!(result
            .image
            .pixels()
            .all(|pixel| pixel.0 == [25, 125, 225, 255]));
    }

    #[test]
    fn subunit_and_composed_scales_match_retained_rendering() {
        let shrunken = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 4 },
                    "placement": [2.0, 2.0, 6.0, 6.0]
                },
                { "type": "transform", "scale": 0.5 }
            ]
        }));
        let shrunken = assert_materialized_matches_retained(
            &shrunken,
            RgbaImage::from_pixel(4, 4, Rgba([80, 120, 160, 255])),
            8,
            8,
        );
        assert_eq!(shrunken.placement, [3.0, 3.0, 5.0, 5.0]);

        let composed = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 2, "height": 2 },
                    "placement": [199.0, 199.0, 201.0, 201.0]
                },
                { "type": "transform", "scale": 10.0 },
                { "type": "transform", "scale": 10.0 }
            ]
        }));
        let composed = assert_materialized_matches_retained(
            &composed,
            RgbaImage::from_pixel(2, 2, Rgba([30, 130, 230, 255])),
            400,
            400,
        );
        assert_eq!(composed.placement, [100.0, 100.0, 300.0, 300.0]);
        assert_eq!(composed.image.dimensions(), (200, 200));
    }

    #[test]
    fn ellipse_keeps_transparent_corners_and_uses_its_alpha_bounds() {
        let active = LayerViaCopySelection {
            region: [1.0, 1.0, 5.0, 5.0],
            ellipse: true,
            points: None,
            selection_alpha: None,
        };
        let document = source_document(json!({
            "ops": [{
                "type": "source_image",
                "source": { "path": "layer.png", "width": 6, "height": 6 },
                "placement": [0.0, 0.0, 6.0, 6.0]
            }]
        }));
        let result = materialize(
            &document,
            &active,
            RgbaImage::from_pixel(6, 6, Rgba([180, 90, 45, 255])),
            6,
            6,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [1.0, 1.0, 5.0, 5.0]);
        assert_eq!(result.image.dimensions(), (4, 4));
        assert_eq!(alpha_bounds(&result.image), Some((0, 0, 4, 4)));
        assert_eq!(result.image.get_pixel(0, 0).0[3], 0);
        assert_eq!(result.image.get_pixel(3, 3).0[3], 0);
        assert_eq!(result.image.get_pixel(0, 1).0[3], 255);
    }

    #[test]
    fn retained_rect_and_ellipse_right_bottom_edges_match_materialized_bytes() {
        for shape in ["rect", "ellipse"] {
            let document = source_document(json!({
                "ops": [{
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 6, "height": 6 },
                    "placement": [0.0, 0.0, 6.0, 6.0]
                }],
                "mask": {
                    "ops": [{ "type": shape, "region": [1.0, 1.0, 5.0, 5.0] }]
                }
            }));
            let result = assert_materialized_matches_retained(
                &document,
                RgbaImage::from_pixel(6, 6, Rgba([70, 140, 210, 255])),
                6,
                6,
            );
            assert_eq!(result.placement, [1.0, 1.0, 5.0, 5.0], "{shape}");
            assert_eq!(result.image.dimensions(), (4, 4), "{shape}");
        }
    }

    #[test]
    fn polygon_selection_keeps_shape_alpha_and_crops_its_true_bounds() {
        let active = LayerViaCopySelection {
            region: [0.0, 0.0, 4.0, 4.0],
            ellipse: false,
            points: Some(vec![[1.0, 1.0], [4.0, 1.0], [1.0, 4.0]]),
            selection_alpha: None,
        };
        let document = source_document(json!({
            "ops": [{
                "type": "source_image",
                "source": { "path": "layer.png", "width": 4, "height": 4 },
                "placement": [0.0, 0.0, 4.0, 4.0]
            }]
        }));
        let result = materialize(
            &document,
            &active,
            RgbaImage::from_pixel(4, 4, Rgba([10, 200, 30, 255])),
            4,
            4,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [1.0, 1.0, 3.0, 3.0]);
        assert_eq!(result.image.dimensions(), (2, 2));
        assert_eq!(result.image.get_pixel(1, 1).0[3], 0);
    }

    #[test]
    fn thousand_point_active_polygon_uses_the_scanline_gate() {
        let points = (0..1_000)
            .map(|index| {
                let angle = index as f32 / 1_000.0 * std::f32::consts::TAU;
                [1024.0 + angle.cos() * 900.0, 512.0 + angle.sin() * 400.0]
            })
            .collect::<Vec<_>>();
        let gate = raster_polygon_selection(&points, 0, 0, 2_048, 1_024);

        assert_eq!(gate.len(), 2_048 * 1_024);
        assert_eq!(gate[512 * 2_048 + 1_024], 255);
        assert_eq!(gate[0], 0);
    }

    #[test]
    fn selection_alpha_is_applied_last_and_tightly_cropped() {
        let active = LayerViaCopySelection {
            region: [0.0, 0.0, 4.0, 2.0],
            ellipse: false,
            points: None,
            selection_alpha: Some(LayerViaCopySelectionAlpha {
                width: 4,
                height: 2,
                starts_with: 0,
                runs: vec![1, 2, 2, 3],
            }),
        };
        let result = materialize(
            &source_document(json!({})),
            &active,
            RgbaImage::from_pixel(4, 2, Rgba([90, 80, 70, 255])),
            4,
            2,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [1.0, 0.0, 4.0, 2.0]);
        assert_eq!(result.image.dimensions(), (3, 2));
        assert_eq!(result.image.get_pixel(2, 0).0[3], 0);
        assert_eq!(result.image.get_pixel(2, 1).0[3], 255);
    }

    #[test]
    fn linked_and_unlinked_masks_sample_in_their_respective_document_spaces() {
        let layer = json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 1 },
                    "placement": [0.0, 0.0, 4.0, 1.0]
                },
                { "type": "transform", "dx": 4.0, "dy": 0.0 }
            ],
            "mask": {
                "ops": [{ "type": "rect", "region": [0.0, 0.0, 2.0, 1.0] }]
            }
        });
        let linked = materialize(
            &source_document(layer.clone()),
            &selection([0.0, 0.0, 10.0, 1.0]),
            RgbaImage::from_pixel(4, 1, Rgba([255, 120, 0, 255])),
            10,
            2,
        )
        .unwrap()
        .unwrap();
        assert_eq!(linked.placement, [4.0, 0.0, 6.0, 1.0]);

        let mut unlinked_layer = layer;
        unlinked_layer["mask"]["unlinked"] = Value::Bool(true);
        let unlinked = materialize(
            &source_document(unlinked_layer),
            &selection([0.0, 0.0, 10.0, 1.0]),
            RgbaImage::from_pixel(4, 1, Rgba([255, 120, 0, 255])),
            10,
            2,
        )
        .unwrap();
        assert!(unlinked.is_none());
    }

    #[test]
    fn unsupported_mask_intersect_op_is_skipped_as_a_whole() {
        let document = source_document(json!({
            "mask": {
                "ops": [
                    { "type": "rect", "region": [0.0, 0.0, 4.0, 2.0] },
                    { "type": "future-mask-shape", "mode": "intersect" }
                ]
            }
        }));
        let result = assert_materialized_matches_retained(
            &document,
            RgbaImage::from_pixel(4, 2, Rgba([200, 100, 50, 255])),
            4,
            2,
        );

        assert_eq!(result.placement, [0.0, 0.0, 4.0, 2.0]);
        assert!(result.image.pixels().all(|pixel| pixel.0[3] == 255));
    }

    #[test]
    fn an_existing_source_clip_moves_with_the_layer_but_never_supplies_placement() {
        let document = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 1 },
                    "placement": [0.0, 0.0, 4.0, 1.0],
                    "clip": { "region": [0.0, 0.0, 2.0, 1.0] }
                },
                { "type": "transform", "dx": 4.0, "dy": 0.0 }
            ]
        }));
        let result = materialize(
            &document,
            &selection([0.0, 0.0, 10.0, 1.0]),
            RgbaImage::from_pixel(4, 1, Rgba([30, 60, 240, 255])),
            10,
            2,
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.placement, [4.0, 0.0, 6.0, 1.0]);
        assert_eq!(result.image.dimensions(), (2, 1));
    }

    #[test]
    fn retained_source_clip_and_unlinked_mask_match_materialized_bytes() {
        let document = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 2 },
                    "placement": [0.0, 0.0, 4.0, 2.0],
                    "clip": { "region": [0.0, 0.0, 3.0, 2.0] }
                },
                { "type": "transform", "dx": 2.0, "dy": 0.0 }
            ],
            "mask": {
                "unlinked": true,
                "ops": [{ "type": "rect", "region": [3.0, 0.0, 5.0, 2.0] }]
            }
        }));
        let result = assert_materialized_matches_retained(
            &document,
            RgbaImage::from_pixel(4, 2, Rgba([35, 95, 155, 255])),
            8,
            4,
        );

        assert_eq!(result.placement, [3.0, 0.0, 5.0, 2.0]);
        assert_eq!(result.image.dimensions(), (2, 2));
    }

    #[test]
    fn retained_fractional_clip_edge_under_scale_matches_materialized_bytes() {
        let document = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 6, "height": 6 },
                    "placement": [0.0, 0.0, 6.0, 6.0],
                    "clip": { "region": [0.0, 0.0, 2.3, 6.0] }
                },
                { "type": "transform", "scale": 2.0 }
            ]
        }));
        let result = assert_materialized_matches_retained(
            &document,
            RgbaImage::from_pixel(6, 6, Rgba([45, 105, 165, 255])),
            6,
            6,
        );

        assert_eq!(result.placement, [0.0, 0.0, 2.0, 6.0]);
        assert_eq!(result.image.dimensions(), (2, 6));
    }

    #[test]
    fn retained_fractional_clip_edge_under_subpixel_translation_matches_materialized_bytes() {
        let document = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 6, "height": 6 },
                    "placement": [0.0, 0.0, 6.0, 6.0],
                    "clip": { "region": [0.0, 0.0, 2.3, 6.0] }
                },
                { "type": "transform", "dx": 0.1, "dy": 0.0 }
            ]
        }));
        let result = assert_materialized_matches_retained(
            &document,
            RgbaImage::from_pixel(6, 6, Rgba([55, 115, 175, 255])),
            6,
            6,
        );

        // Gates are sampled at destination pixel centers. The third column
        // maps back to x=2.4, outside the clip's half-open [0.0, 2.3) range.
        assert_eq!(result.placement, [0.0, 0.0, 2.0, 6.0]);
        assert_eq!(result.image.dimensions(), (2, 6));
    }

    #[test]
    fn transparent_or_non_intersecting_selection_returns_empty_without_a_surface() {
        let document = source_document(json!({}));
        let transparent = materialize(
            &document,
            &selection([0.0, 0.0, 4.0, 2.0]),
            RgbaImage::from_pixel(4, 2, Rgba([20, 30, 40, 0])),
            4,
            2,
        )
        .unwrap();
        assert!(transparent.is_none());

        let outside = materialize(
            &document,
            &selection([8.0, 8.0, 10.0, 10.0]),
            RgbaImage::from_pixel(4, 2, Rgba([20, 30, 40, 255])),
            10,
            10,
        )
        .unwrap();
        assert!(outside.is_none());
    }

    #[test]
    fn missing_placement_and_malformed_polygon_are_errors_not_fallbacks() {
        let mut document = source_document(json!({}));
        document["layers"][0]["ops"][0]
            .as_object_mut()
            .unwrap()
            .remove("placement");
        let error = materialize(
            &document,
            &selection([0.0, 0.0, 4.0, 2.0]),
            RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255])),
            4,
            2,
        )
        .unwrap_err();
        assert!(
            error.contains("no explicit source_image placement"),
            "{error}"
        );

        let invalid_polygon = LayerViaCopySelection {
            region: [0.0, 0.0, 4.0, 2.0],
            ellipse: false,
            points: Some(vec![[0.0, 0.0], [4.0, 2.0]]),
            selection_alpha: None,
        };
        let error = materialize(
            &source_document(json!({})),
            &invalid_polygon,
            RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255])),
            4,
            2,
        )
        .unwrap_err();
        assert!(error.contains("at least three points"), "{error}");
    }

    #[test]
    fn malformed_source_clip_never_falls_back_in_materializer_or_retained_raster() {
        for clip in [
            json!({
                "region": [0.0, 0.0, 4.0, 2.0],
                "points": [[0.0, 0.0], [4.0, 2.0]]
            }),
            json!({ "region": ["0", 0.0, 4.0, 2.0] }),
        ] {
            let document = source_document(json!({
                "ops": [{
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 2 },
                    "placement": [0.0, 0.0, 4.0, 2.0],
                    "clip": clip
                }]
            }));
            let error = materialize(
                &document,
                &selection([0.0, 0.0, 4.0, 2.0]),
                RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255])),
                4,
                2,
            )
            .unwrap_err();
            assert!(error.contains("source clip"), "{error}");

            let layer = &document["layers"][0];
            let error = super::super::mask_raster::raster_layer_gates(
                layer,
                4,
                2,
                CompositeFrame::new(0.0, 0.0, 4, 2),
            )
            .unwrap_err();
            assert!(error.contains("source clip"), "{error}");
        }
    }

    #[test]
    fn materializer_rejects_non_pixel_locked_and_out_of_limit_transforms() {
        let source = RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255]));

        let non_pixel = source_document(json!({ "kind": "adjustment" }));
        let error = materialize(
            &non_pixel,
            &selection([0.0, 0.0, 4.0, 2.0]),
            source.clone(),
            4,
            2,
        )
        .unwrap_err();
        assert!(error.contains("not an editable pixel layer"), "{error}");

        let locked = source_document(json!({ "locked": true }));
        let error = materialize(
            &locked,
            &selection([0.0, 0.0, 4.0, 2.0]),
            source.clone(),
            4,
            2,
        )
        .unwrap_err();
        assert!(error.contains("is locked"), "{error}");

        let oversized_single = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 2 },
                    "placement": [0.0, 0.0, 4.0, 2.0]
                },
                { "type": "transform", "scale": 65.0 }
            ]
        }));
        let error = materialize(
            &oversized_single,
            &selection([0.0, 0.0, 4.0, 2.0]),
            source.clone(),
            4,
            2,
        )
        .unwrap_err();
        assert!(error.contains("at most 64"), "{error}");

        let overflowing_composition = source_document(json!({
            "ops": [
                {
                    "type": "source_image",
                    "source": { "path": "layer.png", "width": 4, "height": 2 },
                    "placement": [0.0, 0.0, 4.0, 2.0]
                },
                { "type": "transform", "dx": 900000.0 },
                { "type": "transform", "scale": 2.0 }
            ]
        }));
        let error = materialize(
            &overflowing_composition,
            &selection([0.0, 0.0, 4.0, 2.0]),
            source,
            4,
            2,
        )
        .unwrap_err();
        assert!(error.contains("exceed its limits"), "{error}");
    }

    #[test]
    fn alpha_maps_and_candidate_surfaces_are_budgeted_before_allocation() {
        let oversized_width = (MAX_LAYER_VIA_COPY_PIXELS + 1) as u32;
        let alpha = LayerViaCopySelectionAlpha {
            width: oversized_width,
            height: 1,
            starts_with: 0,
            runs: vec![u64::from(oversized_width)],
        };
        let error = decode_selection_alpha(&alpha).unwrap_err();
        assert!(error.contains("exceeds the pixel budget"), "{error}");

        let clipped_layer = json!({
            "ops": [{
                "type": "source_image",
                "placement": [0.0, 0.0, 1.0, 1.0],
                "clip": {
                    "region": [0.0, 0.0, 1.0, 1.0],
                    "selectionAlpha": {
                        "width": oversized_width,
                        "height": 1,
                        "startsWith": 0,
                        "runs": [oversized_width]
                    }
                }
            }]
        });
        let error = super::super::mask_raster::raster_layer_gates(
            &clipped_layer,
            1,
            1,
            CompositeFrame::new(0.0, 0.0, 1, 1),
        )
        .unwrap_err();
        assert!(error.contains("exceeds the pixel budget"), "{error}");

        let side = 4_097u32;
        let oversized_candidate = source_document(json!({
            "ops": [{
                "type": "source_image",
                "source": { "path": "layer.png", "width": 1, "height": 1 },
                "placement": [0.0, 0.0, side, side]
            }]
        }));
        let error = materialize(
            &oversized_candidate,
            &selection([0.0, 0.0, side as f32, side as f32]),
            RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])),
            side,
            side,
        )
        .unwrap_err();
        assert!(error.contains("exceeds the pixel budget"), "{error}");
    }

    #[test]
    fn persistent_pixel_store_is_content_addressed_and_decodable() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "hgripe_layer_via_copy_{}_{}",
            std::process::id(),
            nanos
        ));
        let pixels = CompactLayerPixels {
            image: RgbaImage::from_pixel(3, 2, Rgba([12, 34, 56, 200])),
            placement: [4.0, 5.0, 7.0, 7.0],
        };
        let (first, first_hash) = persist_compact_pixels(&directory, &pixels).unwrap();
        let (second, second_hash) = persist_compact_pixels(&directory, &pixels).unwrap();

        assert_eq!(first_hash, second_hash);
        assert_eq!(first.path, second.path);
        assert_eq!((first.width, first.height), (3, 2));
        assert_eq!(image::open(&first.path).unwrap().into_rgba8(), pixels.image);
        assert_eq!(
            fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            1
        );
        let _ = fs::remove_dir_all(directory);
    }
}
