use std::path::Path;

use image::GrayImage;

use super::super::{pixel_ops, working_image::WorkingImage};
use super::SELECTED_THRESHOLD;

pub(super) fn mask_coverage(mask: &GrayImage) -> f64 {
    let total = mask.pixels().len();
    if total == 0 {
        return 0.0;
    }
    let on = mask
        .pixels()
        .filter(|p| p.0[0] >= SELECTED_THRESHOLD)
        .count();
    on as f64 / total as f64
}

pub(super) fn compose_alpha(image: &WorkingImage, mask: &GrayImage) -> WorkingImage {
    // Full-resolution "cutout" on the 16-bit canonical surface: keep the RGB at
    // full precision, take alpha from the mask (widened to 16-bit). The space /
    // ICC tag carries through so a ProPhoto surface stays wide-gamut. Shared
    // (rayon-parallel) with the rest of the compute lane via `pixel_ops`.
    pixel_ops::apply_alpha_mask_working(image, mask)
}

pub(super) fn cutout_to_bbox(alpha_image: &WorkingImage, mask: &GrayImage) -> WorkingImage {
    match selection_bbox(mask) {
        Some((x0, y0, x1, y1)) => {
            pixel_ops::crop_working(alpha_image, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
        }
        // Empty selection: a valid 1x1 transparent cutout (never panic). Keep
        // the source space / ICC so it egresses like every other output.
        None => WorkingImage {
            width: 1,
            height: 1,
            pixels: vec![0u16; 4],
            space: alpha_image.space,
            icc: alpha_image.icc.clone(),
        },
    }
}

fn selection_bbox(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (width, height) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut any = false;
    for y in 0..height {
        for x in 0..width {
            if mask.get_pixel(x, y).0[0] >= SELECTED_THRESHOLD {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    any.then_some((x0, y0, x1, y1))
}

/// A thin wrapper so a `GrayImage` saves through the same `.save()` path as the
/// RGBA surfaces without an extra `DynamicImage` clone elsewhere.
pub(super) struct DynamicGray<'a>(pub(super) &'a GrayImage);

pub(super) fn save_png(gray: &DynamicGray, path: &Path) -> Result<(), String> {
    gray.0
        .save(path)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::working_image::WorkingSpace;
    use image::{Luma, Rgba, RgbaImage};

    #[test]
    fn parallel_compose_alpha_matches_serial_reference() {
        // Deterministic LCG fills so the check needs no RNG dependency.
        let mut state: u32 = 0x0bad_c0de;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        };
        let (w, h) = (13u32, 11u32);
        let mut image = RgbaImage::new(w, h);
        for p in image.pixels_mut() {
            p.0 = [next(), next(), next(), next()];
        }
        let mut mask = GrayImage::new(w, h);
        for p in mask.pixels_mut() {
            p.0[0] = next();
        }
        // compose_alpha now walks the 16-bit surface; widen/narrow round-trips
        // 8-bit values exactly, so narrowing back reproduces the 8-bit contract.
        let working = WorkingImage::from_rgba8(&image, WorkingSpace::Srgb, None);
        let got = compose_alpha(&working, &mask).to_rgba8();
        // Serial reference: RGB preserved, alpha taken from the mask.
        for y in 0..h {
            for x in 0..w {
                let src = image.get_pixel(x, y).0;
                let a = mask.get_pixel(x, y).0[0];
                assert_eq!(got.get_pixel(x, y).0, [src[0], src[1], src[2], a]);
            }
        }
    }

    #[test]
    fn empty_selection_yields_transparent_cutout() {
        let image = RgbaImage::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
        let mask = GrayImage::from_pixel(4, 4, Luma([0]));
        let working = WorkingImage::from_rgba8(&image, WorkingSpace::Srgb, None);
        let alpha = compose_alpha(&working, &mask);
        // Alpha is the (16-bit) mask sample: fully off -> fully transparent.
        assert_eq!(alpha.pixels[3], 0);
        let cutout = cutout_to_bbox(&alpha, &mask);
        assert_eq!((cutout.width, cutout.height), (1, 1));
        assert_eq!(cutout.pixels[3], 0);
        assert_eq!(mask_coverage(&mask), 0.0);
    }
}
