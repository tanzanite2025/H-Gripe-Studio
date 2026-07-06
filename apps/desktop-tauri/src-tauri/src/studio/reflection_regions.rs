//! Heuristic reflection candidate detection for `smartLayerSplit`
//! (docs/plans/completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Phase 3 文字/logo/阴影).
//!
//! Deterministic, weight-free CPU detector: a reflection is a dimmer,
//! vertically mirrored copy of the subject on the surface directly below it
//! (product packshots on glossy tables). Background pixels in the band under
//! the subject bbox that track the mirrored subject's luminance at one
//! consistent attenuation are collected into one reflection candidate mask so
//! the Review Editor can keep it, drop it, or hand it to a regenerator. A
//! learned detector can replace this behind the same interface later.

use image::{GrayImage, Luma, RgbaImage};

/// The mirrored copy must be dimmer than the subject: the median attenuation
/// ratio (reflection luminance / mirrored subject luminance) stays below this…
const MAX_ATTENUATION: f64 = 0.95;
/// …and above this (near-zero means the band is simply dark, not a mirror).
const MIN_ATTENUATION: f64 = 0.2;

/// A band pixel counts as reflection when its luminance is within this many
/// levels (0–255) of the attenuated mirrored subject luminance.
const MATCH_TOLERANCE: u8 = 12;

/// A reflection pixel must also sit at least this far from the background's
/// median luminance — otherwise a plain backdrop trivially "matches".
const DISTINCT_MARGIN: u8 = 20;

/// At least this fraction of the comparable band pixels must match for the
/// band to read as a mirror rather than as noise.
const MIN_BAND_COVERAGE: f64 = 0.25;

/// The reflection mask must cover at least this fraction of the canvas.
const MIN_AREA_FRACTION: f64 = 0.002;

fn luma_of(pixel: &image::Rgba<u8>) -> u8 {
    let [r, g, b, _] = pixel.0;
    ((u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000) as u8
}

/// Detect a reflection candidate: background pixels in the band directly
/// below `subject_bbox` whose luminance tracks the vertically mirrored
/// subject at one consistent attenuation in `MIN_ATTENUATION..MAX_ATTENUATION`.
/// `None` when the band is empty, the attenuation is implausible, or the
/// match fails the coverage / area sanity bounds.
pub(crate) fn reflection_region_mask(
    image: &RgbaImage,
    background_mask: &GrayImage,
    subject_bbox: [u32; 4],
) -> Option<GrayImage> {
    let (width, height) = image.dimensions();
    let total = u64::from(width) * u64::from(height);
    if total == 0 || background_mask.dimensions() != (width, height) {
        return None;
    }
    let [sx0, sy0, sx1, sy1] = subject_bbox;
    if sx1 <= sx0 || sy1 <= sy0 || sy1 + 1 >= height {
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

    // Pair each band pixel below the subject with its mirror across the
    // subject's bottom edge; keep only background-below / subject-above pairs.
    let subject_height = sy1 - sy0 + 1;
    let band_bottom = (sy1 + subject_height).min(height - 1);
    let mut pairs: Vec<(u32, u32, u8, u8)> = Vec::new();
    let mut ratios: Vec<f64> = Vec::new();
    for y in (sy1 + 1)..=band_bottom {
        let mirror_y = match (2 * sy1 + 1).checked_sub(y) {
            Some(m) if m >= sy0 => m,
            _ => continue,
        };
        for x in sx0..=sx1 {
            if background_mask.get_pixel(x, y).0[0] < 128
                || background_mask.get_pixel(x, mirror_y).0[0] >= 128
            {
                continue;
            }
            let below = luma_of(image.get_pixel(x, y));
            let mirror = luma_of(image.get_pixel(x, mirror_y));
            if mirror == 0 {
                continue;
            }
            pairs.push((x, y, below, mirror));
            ratios.push(f64::from(below) / f64::from(mirror));
        }
    }
    if pairs.is_empty() {
        return None;
    }
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let attenuation = ratios[ratios.len() / 2];
    if !(MIN_ATTENUATION..MAX_ATTENUATION).contains(&attenuation) {
        return None;
    }

    let mut reflection = GrayImage::new(width, height);
    let mut matched = 0u64;
    for &(x, y, below, mirror) in &pairs {
        let expected = (attenuation * f64::from(mirror)).round();
        let delta = (f64::from(below) - expected).abs();
        if delta <= f64::from(MATCH_TOLERANCE) && below.abs_diff(median) >= DISTINCT_MARGIN {
            reflection.put_pixel(x, y, Luma([255]));
            matched += 1;
        }
    }
    if (matched as f64) < pairs.len() as f64 * MIN_BAND_COVERAGE
        || (matched as f64) < total as f64 * MIN_AREA_FRACTION
    {
        return None;
    }
    Some(reflection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Light canvas, a red subject block, and a dimmer mirrored copy of it
    /// directly below; the background mask excludes the subject block.
    fn scene() -> (RgbaImage, GrayImage, [u32; 4]) {
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        let mut background = GrayImage::from_pixel(64, 64, Luma([255]));
        for y in 10..30 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([200, 40, 40, 255]));
                background.put_pixel(x, y, Luma([0]));
            }
        }
        // Mirrored copy at ~60% brightness on the surface below the subject.
        for y in 30..50 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([120, 24, 24, 255]));
            }
        }
        (image, background, [20, 10, 39, 29])
    }

    #[test]
    fn finds_the_dimmer_mirrored_copy_below_the_subject() {
        let (image, background, subject_bbox) = scene();
        let reflection = reflection_region_mask(&image, &background, subject_bbox).unwrap();
        let [x0, y0, x1, y1] = crate::studio::layer_split::mask_bbox(&reflection);
        assert_eq!([x0, x1], [20, 39]);
        assert_eq!(y0, 30);
        assert!(y1 >= 45, "bbox bottom {y1}");
    }

    #[test]
    fn ignores_plain_surfaces_and_unmirrored_dark_bands() {
        // Plain backdrop below the subject: nothing tracks the mirror.
        let (mut image, background, subject_bbox) = scene();
        for y in 30..50 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([220, 220, 220, 255]));
            }
        }
        assert!(reflection_region_mask(&image, &background, subject_bbox).is_none());

        // A near-black band is darkness, not a mirror (attenuation too low).
        for y in 30..50 {
            for x in 20..40 {
                image.put_pixel(x, y, Rgba([10, 2, 2, 255]));
            }
        }
        assert!(reflection_region_mask(&image, &background, subject_bbox).is_none());

        let plain = RgbaImage::from_pixel(64, 64, Rgba([220, 220, 220, 255]));
        let all_background = GrayImage::from_pixel(64, 64, Luma([255]));
        assert!(reflection_region_mask(&plain, &all_background, [0, 0, 0, 0]).is_none());
    }
}
