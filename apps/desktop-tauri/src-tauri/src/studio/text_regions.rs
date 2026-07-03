//! Heuristic text region detection for `smartLayerSplit`
//! (docs/plans/active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Phase 3 文字/logo/阴影).
//!
//! Deterministic, weight-free CPU detector: text is a run of small
//! high-contrast strokes on a locally uniform background, so dense horizontal
//! luminance edges dilated along the row connect glyphs into line blobs.
//! Regions come back as filled-bbox masks (text pixels are not separable
//! without OCR) so the Review Editor can mark them protected. A detection
//! model can replace this behind the same interface later.

use image::{GrayImage, Luma, RgbaImage};

/// Minimum luminance step (0–255) between horizontal neighbours to count as a
/// stroke edge. High enough to ignore photo texture, low enough for
/// anti-aliased glyph boundaries.
const EDGE_THRESHOLD: u8 = 60;

/// How far edges are dilated along the row, as a fraction of the canvas
/// width, connecting glyphs and words into one line blob.
const DILATE_X_FRACTION: f64 = 0.01;

/// A text-line blob must cover at least this fraction of the canvas…
const MIN_REGION_AREA_FRACTION: f64 = 0.0005;
/// …and at most this fraction (larger blobs are scenery, not text).
const MAX_REGION_AREA_FRACTION: f64 = 0.2;

/// A text-line bbox must be wider than tall by at least this ratio.
const MIN_ASPECT: f64 = 1.2;

/// A text-line bbox must be at most this fraction of the canvas height —
/// glyph rows are short; tall blobs are objects.
const MAX_HEIGHT_FRACTION: f64 = 0.25;

/// Within the bbox, at least this fraction of pixels must be (dilated) edge
/// pixels — text lines are dense with strokes, photo edges are sparse.
const MIN_EDGE_DENSITY: f64 = 0.35;

/// Upper bound on emitted text region masks (largest first).
pub(crate) const MAX_TEXT_REGIONS: usize = 8;

fn luma(image: &RgbaImage) -> GrayImage {
    let mut out = GrayImage::new(image.width(), image.height());
    for (x, y, pixel) in image.enumerate_pixels() {
        let [r, g, b, _] = pixel.0;
        let l = (u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000;
        out.put_pixel(x, y, Luma([l as u8]));
    }
    out
}

/// Binary map of horizontal luminance steps above [`EDGE_THRESHOLD`],
/// dilated [`DILATE_X_FRACTION`] of the width along the row.
fn dilated_edges(luma: &GrayImage) -> GrayImage {
    let (width, height) = luma.dimensions();
    let mut edges = GrayImage::new(width, height);
    for y in 0..height {
        for x in 1..width {
            let a = luma.get_pixel(x - 1, y).0[0];
            let b = luma.get_pixel(x, y).0[0];
            if a.abs_diff(b) >= EDGE_THRESHOLD {
                edges.put_pixel(x, y, Luma([255]));
                edges.put_pixel(x - 1, y, Luma([255]));
            }
        }
    }
    let radius = ((f64::from(width) * DILATE_X_FRACTION).ceil() as u32).max(1);
    let mut dilated = GrayImage::new(width, height);
    for y in 0..height {
        let mut last_edge: Option<u32> = None;
        for x in 0..width {
            if edges.get_pixel(x, y).0[0] > 0 {
                last_edge = Some(x);
            }
            if last_edge.is_some_and(|e| x - e <= radius) {
                dilated.put_pixel(x, y, Luma([255]));
            }
        }
        let mut next_edge: Option<u32> = None;
        for x in (0..width).rev() {
            if edges.get_pixel(x, y).0[0] > 0 {
                next_edge = Some(x);
            }
            if next_edge.is_some_and(|e| e - x <= radius) {
                dilated.put_pixel(x, y, Luma([255]));
            }
        }
    }
    dilated
}

struct Component {
    bbox: [u32; 4],
    area: u64,
}

/// 4-connected components of the binary map, as bbox + pixel count (the
/// instancing pass in `layer_split` has its own area floor / cap, so text
/// detection labels components itself).
fn components(map: &GrayImage) -> Vec<Component> {
    let (width, height) = map.dimensions();
    let index = |x: u32, y: u32| (y * width + x) as usize;
    let mut seen = vec![false; (u64::from(width) * u64::from(height)) as usize];
    let mut out = Vec::new();
    let mut stack: Vec<(u32, u32)> = Vec::new();
    for y in 0..height {
        for x in 0..width {
            if map.get_pixel(x, y).0[0] == 0 || seen[index(x, y)] {
                continue;
            }
            let (mut x0, mut y0, mut x1, mut y1) = (x, y, x, y);
            let mut area = 0u64;
            seen[index(x, y)] = true;
            stack.push((x, y));
            while let Some((cx, cy)) = stack.pop() {
                area += 1;
                x0 = x0.min(cx);
                y0 = y0.min(cy);
                x1 = x1.max(cx);
                y1 = y1.max(cy);
                let neighbours = [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ];
                for (nx, ny) in neighbours {
                    if nx < width
                        && ny < height
                        && !seen[index(nx, ny)]
                        && map.get_pixel(nx, ny).0[0] > 0
                    {
                        seen[index(nx, ny)] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            out.push(Component {
                bbox: [x0, y0, x1, y1],
                area,
            });
        }
    }
    out
}

/// Detect likely text-line regions in an sRGB image. Returns filled-bbox
/// masks, largest first, at most [`MAX_TEXT_REGIONS`]; empty when nothing
/// text-like is found.
pub(crate) fn text_region_masks(image: &RgbaImage) -> Vec<GrayImage> {
    let (width, height) = image.dimensions();
    let total = u64::from(width) * u64::from(height);
    if total == 0 {
        return Vec::new();
    }
    let map = dilated_edges(&luma(image));
    let min_area = (total as f64 * MIN_REGION_AREA_FRACTION).max(1.0);
    let max_area = total as f64 * MAX_REGION_AREA_FRACTION;
    let mut regions: Vec<(u64, GrayImage)> = Vec::new();
    for component in components(&map) {
        let Component {
            bbox: [x0, y0, x1, y1],
            area,
        } = component;
        let (w, h) = (u64::from(x1 - x0 + 1), u64::from(y1 - y0 + 1));
        let box_area = (w * h) as f64;
        if box_area < min_area || box_area > max_area {
            continue;
        }
        if (w as f64) < h as f64 * MIN_ASPECT {
            continue;
        }
        if h as f64 > f64::from(height) * MAX_HEIGHT_FRACTION {
            continue;
        }
        if area as f64 / box_area < MIN_EDGE_DENSITY {
            continue;
        }
        let mut mask = GrayImage::new(width, height);
        for y in y0..=y1 {
            for x in x0..=x1 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        regions.push((w * h, mask));
    }
    regions.sort_by(|a, b| b.0.cmp(&a.0));
    regions.truncate(MAX_TEXT_REGIONS);
    regions.into_iter().map(|(_, mask)| mask).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Paint a row of small black "glyph" strokes on the white canvas.
    fn paint_text_line(image: &mut RgbaImage, x0: u32, y0: u32, glyphs: u32) {
        for g in 0..glyphs {
            let gx = x0 + g * 4;
            for y in y0..y0 + 5 {
                for x in gx..gx + 2 {
                    image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
                }
            }
        }
    }

    #[test]
    fn finds_a_text_line_and_ignores_a_plain_canvas() {
        let mut image = RgbaImage::from_pixel(100, 60, Rgba([245, 245, 245, 255]));
        paint_text_line(&mut image, 10, 20, 15);
        let regions = text_region_masks(&image);
        assert_eq!(regions.len(), 1);
        let bbox = crate::studio::layer_split::mask_bbox(&regions[0]);
        // The region tracks the painted line (glyphs span x 10..=69, y 20..=24)
        // modulo the horizontal dilation radius.
        assert!(bbox[1] >= 19 && bbox[3] <= 26, "bbox {bbox:?}");
        assert!(bbox[0] <= 10 && bbox[2] >= 60, "bbox {bbox:?}");

        let plain = RgbaImage::from_pixel(100, 60, Rgba([245, 245, 245, 255]));
        assert!(text_region_masks(&plain).is_empty());
    }

    #[test]
    fn rejects_a_large_solid_block() {
        // A big filled square has edges only at its outline: density under the
        // bbox stays far below MIN_EDGE_DENSITY, so it is not text.
        let mut image = RgbaImage::from_pixel(100, 100, Rgba([245, 245, 245, 255]));
        for y in 20..80 {
            for x in 20..80 {
                image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        assert!(text_region_masks(&image).is_empty());
    }
}
