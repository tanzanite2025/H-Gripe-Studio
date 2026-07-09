//! CPU reference raster for the clip property pipeline
//! (CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md Phase 2): apply a clip's resolved
//! transform / crop / opacity to a decoded frame as a single inverse-mapped
//! affine pass over the working surface. This function defines the pixel
//! semantics the Phase 3 wgpu kernel must reproduce:
//! - the canvas keeps the source frame's size; uncovered pixels are
//!   transparent black;
//! - crop removes source edges (percentages of the source size) before the
//!   transform;
//! - the pivot is the source centre plus `anchor` (source pixels); the pivot
//!   lands at the canvas centre plus `position` (canvas pixels); scale and
//!   rotation apply around the pivot;
//! - sampling is bilinear with neighbours clamped to the crop rectangle;
//!   `opacity` multiplies the sampled alpha.

use image::RgbaImage;

use super::clip_props::ResolvedClipProps;
use super::working_image::{narrow, widen, WorkingImage, WorkingSpace};

/// Apply `props` to `image`, producing a same-size canvas. Identity documents
/// must be skipped by the caller ([`ResolvedClipProps::is_identity`]); a zero
/// scale or a fully-cropped frame yields a transparent canvas.
pub(super) fn apply_clip_props(image: &WorkingImage, props: &ResolvedClipProps) -> WorkingImage {
    let w = image.width as f64;
    let h = image.height as f64;
    let t = &props.transform;
    let c = &props.crop;

    // Crop rectangle in source pixels (continuous coordinates).
    let crop_x0 = w * c.left_pct / 100.0;
    let crop_x1 = w * (1.0 - c.right_pct / 100.0);
    let crop_y0 = h * c.top_pct / 100.0;
    let crop_y1 = h * (1.0 - c.bottom_pct / 100.0);

    let scale = t.scale_pct / 100.0;
    let opacity = t.opacity_pct / 100.0;
    let mut out = WorkingImage {
        width: image.width,
        height: image.height,
        pixels: vec![0u16; image.pixels.len()],
        space: image.space,
        icc: image.icc.clone(),
    };
    if scale <= 0.0 || opacity <= 0.0 || crop_x0 >= crop_x1 || crop_y0 >= crop_y1 {
        return out;
    }

    // Inverse map: source = pivot + (1/s) * R(-theta) * (canvas - centre - position).
    let pivot_x = w / 2.0 + t.anchor.x;
    let pivot_y = h / 2.0 + t.anchor.y;
    let offset_x = w / 2.0 + t.position.x;
    let offset_y = h / 2.0 + t.position.y;
    let theta = -t.rotation_deg.to_radians();
    let (sin, cos) = theta.sin_cos();
    let inv_scale = 1.0 / scale;

    let stride = image.width as usize * 4;
    for y in 0..image.height {
        let qy = y as f64 + 0.5 - offset_y;
        for x in 0..image.width {
            let qx = x as f64 + 0.5 - offset_x;
            let sx = pivot_x + inv_scale * (cos * qx - sin * qy);
            let sy = pivot_y + inv_scale * (sin * qx + cos * qy);
            if sx < crop_x0 || sx >= crop_x1 || sy < crop_y0 || sy >= crop_y1 {
                continue;
            }
            let rgba = sample_bilinear(image, sx, sy, (crop_x0, crop_y0, crop_x1, crop_y1));
            let i = y as usize * stride + x as usize * 4;
            out.pixels[i] = rgba[0];
            out.pixels[i + 1] = rgba[1];
            out.pixels[i + 2] = rgba[2];
            out.pixels[i + 3] = (rgba[3] as f64 * opacity).round() as u16;
        }
    }
    out
}

/// Apply `props` to an 8-bit sRGB display proxy — the preview host's frame
/// format. The proxy widens to the canonical 16-bit working surface, runs
/// the same [`apply_clip_props`] kernel the export path uses, and narrows
/// back; widen/narrow round-trip exactly, so preview equals export up to the
/// proxy's own downscale.
pub(crate) fn apply_clip_props_srgb_proxy(
    proxy: &RgbaImage,
    props: &ResolvedClipProps,
) -> RgbaImage {
    let (w, h) = proxy.dimensions();
    let working = WorkingImage {
        width: w,
        height: h,
        pixels: proxy.as_raw().iter().map(|&v| widen(v)).collect(),
        space: WorkingSpace::Srgb,
        icc: None,
    };
    let out = apply_clip_props(&working, props);
    let bytes: Vec<u8> = out.pixels.iter().map(|&v| narrow(v)).collect();
    RgbaImage::from_raw(w, h, bytes).expect("same-size canvas")
}

/// Bilinear sample at continuous source coordinates (pixel centres at .5),
/// neighbours clamped to the crop rectangle so cropped-away pixels never
/// bleed into the edge.
fn sample_bilinear(image: &WorkingImage, sx: f64, sy: f64, crop: (f64, f64, f64, f64)) -> [u16; 4] {
    let (x0f, y0f, x1f, y1f) = crop;
    // Integer texel range allowed by the crop rectangle.
    let min_x = x0f.floor() as i64;
    let max_x = (x1f.ceil() as i64 - 1).max(min_x);
    let min_y = y0f.floor() as i64;
    let max_y = (y1f.ceil() as i64 - 1).max(min_y);
    let clamp_x = |v: i64| v.clamp(min_x, max_x).clamp(0, image.width as i64 - 1) as usize;
    let clamp_y = |v: i64| v.clamp(min_y, max_y).clamp(0, image.height as i64 - 1) as usize;

    let fx = sx - 0.5;
    let fy = sy - 0.5;
    let ix = fx.floor();
    let iy = fy.floor();
    let ax = fx - ix;
    let ay = fy - iy;
    let x0 = clamp_x(ix as i64);
    let x1 = clamp_x(ix as i64 + 1);
    let y0 = clamp_y(iy as i64);
    let y1 = clamp_y(iy as i64 + 1);

    let stride = image.width as usize * 4;
    let texel = |x: usize, y: usize| -> [f64; 4] {
        let i = y * stride + x * 4;
        [
            image.pixels[i] as f64,
            image.pixels[i + 1] as f64,
            image.pixels[i + 2] as f64,
            image.pixels[i + 3] as f64,
        ]
    };
    let p00 = texel(x0, y0);
    let p10 = texel(x1, y0);
    let p01 = texel(x0, y1);
    let p11 = texel(x1, y1);
    let mut out = [0u16; 4];
    for ch in 0..4 {
        let top = p00[ch] + (p10[ch] - p00[ch]) * ax;
        let bottom = p01[ch] + (p11[ch] - p01[ch]) * ax;
        out[ch] = (top + (bottom - top) * ay).round().clamp(0.0, 65535.0) as u16;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::clip_props::{parse_clip_props_doc, resolve_clip_props_at};
    use crate::studio::working_image::WorkingSpace;

    fn resolved(json: &str, t: f64) -> ResolvedClipProps {
        resolve_clip_props_at(&parse_clip_props_doc(json).expect("doc parses"), t)
    }

    fn doc_with(transform: &str, crop: &str) -> String {
        format!(r#"{{"transform": {transform}, "crop": {crop}}}"#)
    }

    const IDENTITY_TRANSFORM: &str = r#"{"position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 100, "rotationDeg": 0, "opacityPct": 100}"#;
    const NO_CROP: &str = r#"{"leftPct": 0, "topPct": 0, "rightPct": 0, "bottomPct": 0}"#;

    /// A 4x4 frame: solid grey with a distinct top-left quadrant.
    fn frame() -> WorkingImage {
        let mut pixels = vec![0u16; 4 * 4 * 4];
        for y in 0..4usize {
            for x in 0..4usize {
                let i = (y * 4 + x) * 4;
                let v = if x < 2 && y < 2 { 65535 } else { 32768 };
                pixels[i] = v;
                pixels[i + 1] = v;
                pixels[i + 2] = v;
                pixels[i + 3] = 65535;
            }
        }
        WorkingImage {
            width: 4,
            height: 4,
            pixels,
            space: WorkingSpace::Srgb,
            icc: None,
        }
    }

    fn px(img: &WorkingImage, x: usize, y: usize) -> [u16; 4] {
        let i = (y * img.width as usize + x) * 4;
        [
            img.pixels[i],
            img.pixels[i + 1],
            img.pixels[i + 2],
            img.pixels[i + 3],
        ]
    }

    #[test]
    fn identity_props_reproduce_the_frame() {
        let props = resolved(&doc_with(IDENTITY_TRANSFORM, NO_CROP), 0.0);
        assert!(props.is_identity());
        let src = frame();
        let out = apply_clip_props(&src, &props);
        assert_eq!(out.pixels, src.pixels);
    }

    #[test]
    fn opacity_scales_alpha_only() {
        let transform = r#"{"position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 100, "rotationDeg": 0, "opacityPct": 50}"#;
        let out = apply_clip_props(&frame(), &resolved(&doc_with(transform, NO_CROP), 0.0));
        assert_eq!(px(&out, 0, 0), [65535, 65535, 65535, 32768]);
        assert_eq!(px(&out, 3, 3), [32768, 32768, 32768, 32768]);
    }

    #[test]
    fn crop_clears_the_removed_edges() {
        let crop = r#"{"leftPct": 50, "topPct": 0, "rightPct": 0, "bottomPct": 50}"#;
        let out = apply_clip_props(
            &frame(),
            &resolved(&doc_with(IDENTITY_TRANSFORM, crop), 0.0),
        );
        // Left half and bottom half cleared; the surviving quadrant intact.
        assert_eq!(px(&out, 0, 0), [0, 0, 0, 0]);
        assert_eq!(px(&out, 1, 3), [0, 0, 0, 0]);
        assert_eq!(px(&out, 2, 0), [32768, 32768, 32768, 65535]);
        assert_eq!(px(&out, 3, 1), [32768, 32768, 32768, 65535]);
    }

    #[test]
    fn position_translates_the_frame() {
        let transform = r#"{"position": {"x": 2, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 100, "rotationDeg": 0, "opacityPct": 100}"#;
        let src = frame();
        let out = apply_clip_props(&src, &resolved(&doc_with(transform, NO_CROP), 0.0));
        // Shifted right by 2: column 2 shows source column 0; columns 0-1 empty.
        assert_eq!(px(&out, 0, 0), [0, 0, 0, 0]);
        assert_eq!(px(&out, 2, 0), px(&src, 0, 0));
        assert_eq!(px(&out, 3, 3), px(&src, 1, 3));
    }

    #[test]
    fn rotation_180_flips_the_frame() {
        let transform = r#"{"position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 100, "rotationDeg": 180, "opacityPct": 100}"#;
        let src = frame();
        let out = apply_clip_props(&src, &resolved(&doc_with(transform, NO_CROP), 0.0));
        for y in 0..4usize {
            for x in 0..4usize {
                assert_eq!(px(&out, x, y), px(&src, 3 - x, 3 - y), "at ({x},{y})");
            }
        }
    }

    #[test]
    fn zero_scale_yields_a_transparent_canvas() {
        let transform = r#"{"position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 0, "rotationDeg": 0, "opacityPct": 100}"#;
        let out = apply_clip_props(&frame(), &resolved(&doc_with(transform, NO_CROP), 0.0));
        assert!(out.pixels.iter().all(|&v| v == 0));
    }

    #[test]
    fn scale_50_shrinks_around_the_centre() {
        let transform = r#"{"position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0}, "scalePct": 50, "rotationDeg": 0, "opacityPct": 100}"#;
        let out = apply_clip_props(&frame(), &resolved(&doc_with(transform, NO_CROP), 0.0));
        // The 4x4 frame shrinks to the centre 2x2; corners are empty.
        assert_eq!(px(&out, 0, 0), [0, 0, 0, 0]);
        assert_eq!(px(&out, 3, 3), [0, 0, 0, 0]);
        assert_eq!(px(&out, 1, 1)[3], 65535);
        assert_eq!(px(&out, 2, 2)[3], 65535);
    }
}
