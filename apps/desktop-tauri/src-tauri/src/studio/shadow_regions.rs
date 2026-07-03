//! Heuristic shadow candidate detection for `smartLayerSplit`
//! (docs/plans/active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Phase 3 文字/logo/阴影).
//!
//! Deterministic, weight-free CPU detector: a cast shadow is a background
//! region markedly darker than the background's own baseline that sits next
//! to the subject. Dark background components touching the (expanded)
//! subject bbox are unioned into one shadow candidate mask so the Review
//! Editor can keep it, drop it, or hand it to a regenerator. A learned
//! detector can replace this behind the same interface later.

use image::{GrayImage, Luma, RgbaImage};

/// How far below the background's median luminance (0–255) a pixel must sit
/// to count as shadow-dark.
const DARKNESS_MARGIN: u8 = 40;

/// A dark component must touch the subject bbox expanded by this fraction of
/// the canvas diagonal — cast shadows sit next to their caster.
const NEAR_SUBJECT_FRACTION: f64 = 0.05;

/// The unioned shadow mask must cover at least this fraction of the canvas…
const MIN_AREA_FRACTION: f64 = 0.002;
/// …and at most this fraction (larger means the background is simply dark).
const MAX_AREA_FRACTION: f64 = 0.4;

fn luma_of(pixel: &image::Rgba<u8>) -> u8 {
    let [r, g, b, _] = pixel.0;
    ((u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000) as u8
}

/// Detect a cast-shadow candidate: background pixels at least
/// [`DARKNESS_MARGIN`] below the background's median luminance, kept only in
/// connected components near `subject_bbox`, unioned into one mask. `None`
/// when the union is empty or fails the area sanity bounds.
pub(crate) fn shadow_region_mask(
    image: &RgbaImage,
    background_mask: &GrayImage,
    subject_bbox: [u32; 4],
) -> Option<GrayImage> {
    let (width, height) = image.dimensions();
    let total = u64::from(width) * u64::from(height);
    if total == 0 || background_mask.dimensions() != (width, height) {
        return None;
    }

    let mut histogram = [0u64; 256];
    let mut background_pixels = 0u64;
    for (x, y, pixel) in image.enumerate_pixels() {
        if background_mask.get_pixel(x, y).0[0] >= 128 {
            histogram[luma_of(pixel) as usize] += 1;
            background_pixels += 1;
        }
    }
    if background_pixels == 0 {
        return None;
    }
    let mut median = 0u8;
    let mut seen = 0u64;
    for (level, count) in histogram.iter().enumerate() {
        seen += count;
        if seen * 2 >= background_pixels {
            median = level as u8;
            break;
        }
    }
    let threshold = median.saturating_sub(DARKNESS_MARGIN);
    if threshold == 0 {
        return None;
    }

    let mut dark = GrayImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels() {
        if background_mask.get_pixel(x, y).0[0] >= 128 && luma_of(pixel) < threshold {
            dark.put_pixel(x, y, Luma([255]));
        }
    }

    // Keep only dark components whose bbox touches the expanded subject bbox.
    let diagonal = f64::from(width).hypot(f64::from(height));
    let reach = (diagonal * NEAR_SUBJECT_FRACTION).ceil() as u32;
    let [sx0, sy0, sx1, sy1] = subject_bbox;
    let (nx0, ny0) = (sx0.saturating_sub(reach), sy0.saturating_sub(reach));
    let (nx1, ny1) = (
        (sx1 + reach).min(width.saturating_sub(1)),
        (sy1 + reach).min(height.saturating_sub(1)),
    );

    let index = |x: u32, y: u32| (y * width + x) as usize;
    let mut seen = vec![false; total as usize];
    let mut shadow = GrayImage::new(width, height);
    let mut area = 0u64;
    let mut stack: Vec<(u32, u32)> = Vec::new();
    let mut component: Vec<(u32, u32)> = Vec::new();
    for y in 0..height {
        for x in 0..width {
            if dark.get_pixel(x, y).0[0] == 0 || seen[index(x, y)] {
                continue;
            }
            component.clear();
            let (mut cx0, mut cy0, mut cx1, mut cy1) = (x, y, x, y);
            seen[index(x, y)] = true;
            stack.push((x, y));
            while let Some((cx, cy)) = stack.pop() {
                component.push((cx, cy));
                cx0 = cx0.min(cx);
                cy0 = cy0.min(cy);
                cx1 = cx1.max(cx);
                cy1 = cy1.max(cy);
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
                        && dark.get_pixel(nx, ny).0[0] > 0
                    {
                        seen[index(nx, ny)] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            let near_subject = cx0 <= nx1 && cx1 >= nx0 && cy0 <= ny1 && cy1 >= ny0;
            if near_subject {
                for &(px, py) in &component {
                    shadow.put_pixel(px, py, Luma([255]));
                }
                area += component.len() as u64;
            }
        }
    }

    let fraction = area as f64 / total as f64;
    if fraction < MIN_AREA_FRACTION || fraction > MAX_AREA_FRACTION {
        return None;
    }
    Some(shadow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Light canvas, a dark subject block, and a mid-dark "shadow" patch next
    /// to it; the background mask excludes the subject block.
    fn scene() -> (RgbaImage, GrayImage, [u32; 4]) {
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        let mut background = GrayImage::from_pixel(64, 64, Luma([255]));
        for y in 20..40 {
            for x in 20..32 {
                image.put_pixel(x, y, Rgba([200, 40, 40, 255]));
                background.put_pixel(x, y, Luma([0]));
            }
        }
        // Shadow patch to the subject's right, on the background.
        for y in 34..42 {
            for x in 33..48 {
                image.put_pixel(x, y, Rgba([110, 110, 110, 255]));
            }
        }
        (image, background, [20, 20, 31, 39])
    }

    #[test]
    fn finds_the_dark_patch_beside_the_subject() {
        let (image, background, subject_bbox) = scene();
        let shadow = shadow_region_mask(&image, &background, subject_bbox).unwrap();
        assert_eq!(
            crate::studio::layer_split::mask_bbox(&shadow),
            [33, 34, 47, 41]
        );
    }

    #[test]
    fn ignores_dark_patches_far_from_the_subject_and_plain_scenes() {
        let (mut image, background, subject_bbox) = scene();
        // Repaint the shadow patch back to canvas grey and darken a far corner
        // instead: nothing near the subject remains.
        for y in 34..42 {
            for x in 33..48 {
                image.put_pixel(x, y, Rgba([220, 220, 220, 255]));
            }
        }
        for y in 60..64 {
            for x in 60..64 {
                image.put_pixel(x, y, Rgba([110, 110, 110, 255]));
            }
        }
        assert!(shadow_region_mask(&image, &background, subject_bbox).is_none());

        let plain = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        let all_background = GrayImage::from_pixel(64, 64, Luma([255]));
        assert!(shadow_region_mask(&plain, &all_background, [0, 0, 0, 0]).is_none());
    }
}
