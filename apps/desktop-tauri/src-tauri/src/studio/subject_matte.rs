//! Deterministic continuous-alpha matting for Subject Mask and Refine Edge.
//!
//! A three-level trimap defines hard foreground/background and an unknown edge
//! band. The built-in guided filter resolves only that band and requires no
//! downloaded weights or inference runtime.

use image::{imageops::FilterType, GrayImage, Luma, RgbaImage};
use rayon::prelude::*;

use super::pixel_ops;

pub(super) const TRIMAP_FG: u8 = 255;
pub(super) const TRIMAP_UNKNOWN: u8 = 128;
pub(super) const TRIMAP_BG: u8 = 0;

const SELECTED_THRESHOLD: u8 = 128;
const BUILTIN_PROVIDER: &str = "builtin-cpu-matte";
const BUILTIN_MAX_EDGE: u32 = 2048;
const GUIDED_EPS: f32 = 1e-4;

pub(super) trait AlphaMatter {
    fn provider(&self) -> &str;
    fn matte(&self, image: &RgbaImage, trimap: &GrayImage) -> Result<GrayImage, String>;
}

pub(super) struct MatterSelection {
    pub(super) matter: Box<dyn AlphaMatter>,
    pub(super) fallback_reason: Option<String>,
}

pub(super) fn matter() -> MatterSelection {
    MatterSelection {
        matter: Box::new(BuiltinCpuMatter),
        fallback_reason: None,
    }
}

pub(super) fn trimap_from_mask(mask: &GrayImage, band: u32) -> GrayImage {
    let (width, height) = mask.dimensions();
    let inner = super::subject_mask::erode(mask, band);
    let outer = super::subject_mask::dilate(mask, band);
    let row_width = width as usize;
    let inner_buf = inner.as_raw();
    let outer_buf = outer.as_raw();
    let mut out_buf = vec![0u8; row_width * height as usize];
    out_buf
        .par_chunks_mut(row_width)
        .enumerate()
        .for_each(|(y, row)| {
            let base = y * row_width;
            for (x, slot) in row.iter_mut().enumerate() {
                *slot = if inner_buf[base + x] >= SELECTED_THRESHOLD {
                    TRIMAP_FG
                } else if outer_buf[base + x] >= SELECTED_THRESHOLD {
                    TRIMAP_UNKNOWN
                } else {
                    TRIMAP_BG
                };
            }
        });
    GrayImage::from_raw(width, height, out_buf).expect("trimap buffer matches dimensions")
}

pub(super) struct BuiltinCpuMatter;

impl AlphaMatter for BuiltinCpuMatter {
    fn provider(&self) -> &str {
        BUILTIN_PROVIDER
    }

    fn matte(&self, image: &RgbaImage, trimap: &GrayImage) -> Result<GrayImage, String> {
        let (width, height) = trimap.dimensions();
        if width == 0 || height == 0 {
            return Err("Subject Mask matting needs a non-empty image".to_string());
        }
        if image.dimensions() != trimap.dimensions() {
            return Err("Subject Mask image and trimap dimensions must match".to_string());
        }

        let (small_width, small_height) = bounded_size(width, height, BUILTIN_MAX_EDGE);
        let small_rgb = pixel_ops::resize_rgba(image, small_width, small_height);
        let small_trimap = if (small_width, small_height) == (width, height) {
            trimap.clone()
        } else {
            image::imageops::resize(trimap, small_width, small_height, FilterType::Nearest)
        };

        let count = (small_width * small_height) as usize;
        let mut guide = vec![0f32; count];
        let mut prior = vec![0f32; count];
        let mut unknown = 0usize;
        for (index, (rgb, level)) in small_rgb.pixels().zip(small_trimap.pixels()).enumerate() {
            let [red, green, blue, _] = rgb.0;
            guide[index] =
                (0.299 * red as f32 + 0.587 * green as f32 + 0.114 * blue as f32) / 255.0;
            prior[index] = match level.0[0] {
                TRIMAP_FG => 1.0,
                TRIMAP_BG => 0.0,
                _ => {
                    unknown += 1;
                    0.5
                }
            };
        }
        if unknown == 0 {
            return Ok(harden(trimap));
        }

        let radius = (((unknown as f64).sqrt() / 4.0).round() as usize).clamp(2, 64);
        let filtered = guided_filter(
            &guide,
            &prior,
            small_width as usize,
            small_height as usize,
            radius,
            GUIDED_EPS,
        );
        let mut soft = GrayImage::from_pixel(small_width, small_height, Luma([0]));
        for (pixel, value) in soft.pixels_mut().zip(filtered) {
            pixel.0[0] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        let soft = pixel_ops::resize_gray(&soft, width, height, FilterType::Triangle);
        Ok(pixel_ops::composite_trimap_alpha(
            trimap, &soft, TRIMAP_FG, TRIMAP_BG,
        ))
    }
}

fn bounded_size(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let scale = max_edge as f32 / longest as f32;
    (
        ((width as f32 * scale).round() as u32).max(1),
        ((height as f32 * scale).round() as u32).max(1),
    )
}

fn harden(trimap: &GrayImage) -> GrayImage {
    let (width, height) = trimap.dimensions();
    let mut out = GrayImage::from_pixel(width, height, Luma([0]));
    for (src, dst) in trimap.pixels().zip(out.pixels_mut()) {
        dst.0[0] = if src.0[0] == TRIMAP_FG { 255 } else { 0 };
    }
    out
}

fn box_filter(src: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let stride = width + 1;
    let mut integral = vec![0f64; stride * (height + 1)];
    for y in 0..height {
        let mut row_sum = 0f64;
        for x in 0..width {
            row_sum += src[y * width + x] as f64;
            integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + row_sum;
        }
    }
    let mut out = vec![0f32; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius + 1).min(height);
        for (x, slot) in row.iter_mut().enumerate() {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius + 1).min(width);
            let sum = integral[y1 * stride + x1]
                - integral[y0 * stride + x1]
                - integral[y1 * stride + x0]
                + integral[y0 * stride + x0];
            *slot = (sum / ((y1 - y0) * (x1 - x0)) as f64) as f32;
        }
    });
    out
}

fn guided_filter(
    guide: &[f32],
    src: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let mean_guide = box_filter(guide, width, height, radius);
    let mean_src = box_filter(src, width, height, radius);
    let guide_src: Vec<f32> = guide.iter().zip(src).map(|(a, b)| a * b).collect();
    let mean_guide_src = box_filter(&guide_src, width, height, radius);
    let guide_squared: Vec<f32> = guide.iter().map(|value| value * value).collect();
    let mean_guide_squared = box_filter(&guide_squared, width, height, radius);

    let mut slope = vec![0f32; width * height];
    let mut intercept = vec![0f32; width * height];
    for index in 0..slope.len() {
        let variance = mean_guide_squared[index] - mean_guide[index] * mean_guide[index];
        let covariance = mean_guide_src[index] - mean_guide[index] * mean_src[index];
        slope[index] = covariance / (variance + eps);
        intercept[index] = mean_src[index] - slope[index] * mean_guide[index];
    }
    let mean_slope = box_filter(&slope, width, height, radius);
    let mean_intercept = box_filter(&intercept, width, height, radius);
    mean_slope
        .iter()
        .zip(mean_intercept)
        .zip(guide)
        .map(|((a, b), value)| a * value + b)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn trimap_has_three_levels() {
        let mut mask = GrayImage::from_pixel(9, 9, Luma([0]));
        for y in 2..7 {
            for x in 2..7 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        let trimap = trimap_from_mask(&mask, 1);
        assert!(trimap.pixels().any(|pixel| pixel.0[0] == TRIMAP_FG));
        assert!(trimap.pixels().any(|pixel| pixel.0[0] == TRIMAP_UNKNOWN));
        assert!(trimap.pixels().any(|pixel| pixel.0[0] == TRIMAP_BG));
    }

    #[test]
    fn builtin_preserves_hard_regions_and_softens_unknown_band() {
        let mut image = RgbaImage::from_pixel(9, 9, Rgba([30, 30, 30, 255]));
        for y in 2..7 {
            for x in 2..7 {
                image.put_pixel(x, y, Rgba([220, 220, 220, 255]));
            }
        }
        let mut mask = GrayImage::from_pixel(9, 9, Luma([0]));
        for y in 2..7 {
            for x in 2..7 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        let trimap = trimap_from_mask(&mask, 1);
        let matte = BuiltinCpuMatter.matte(&image, &trimap).unwrap();
        assert_eq!(matte.get_pixel(4, 4).0[0], 255);
        assert_eq!(matte.get_pixel(0, 0).0[0], 0);
        assert!(matte
            .pixels()
            .zip(trimap.pixels())
            .any(|(alpha, level)| level.0[0] == TRIMAP_UNKNOWN
                && alpha.0[0] > 0
                && alpha.0[0] < 255));
    }
}
