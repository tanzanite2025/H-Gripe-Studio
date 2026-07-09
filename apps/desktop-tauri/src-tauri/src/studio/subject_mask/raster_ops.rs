use std::collections::VecDeque;

use image::{GrayImage, Luma, RgbaImage};
use rayon::prelude::*;

use super::{MASK_OFF, MASK_ON, SELECTED_THRESHOLD};

/// Fill a marquee `rect` / `ellipse` region (`[x1, y1, x2, y2]` image-space).
pub(super) fn fill_marquee(mask: &mut GrayImage, kind: &str, region: &[f64]) {
    let (width, height) = mask.dimensions();
    let x1 = region[0].min(region[2]);
    let y1 = region[1].min(region[3]);
    let x2 = region[0].max(region[2]);
    let y2 = region[1].max(region[3]);
    let cx = (x1 + x2) / 2.0;
    let cy = (y1 + y2) / 2.0;
    let rx = ((x2 - x1) / 2.0).max(0.5);
    let ry = ((y2 - y1) / 2.0).max(0.5);
    let px0 = x1.floor().max(0.0) as u32;
    let py0 = y1.floor().max(0.0) as u32;
    let px1 = (x2.ceil() as i64).clamp(0, width as i64 - 1) as u32;
    let py1 = (y2.ceil() as i64).clamp(0, height as i64 - 1) as u32;
    for y in py0..=py1 {
        for x in px0..=px1 {
            if kind == "ellipse" {
                let nx = (x as f64 - cx) / rx;
                let ny = (y as f64 - cy) / ry;
                if nx * nx + ny * ny > 1.0 {
                    continue;
                }
            }
            mask.put_pixel(x, y, Luma([MASK_ON]));
        }
    }
}

/// Composite a linear gradient ramp (M10): full selection at the drag start
/// fading to none at the end (`region: [x1, y1, x2, y2]` image-space). `add`
/// unions the ramp into the mask; `subtract` cuts it away. Mirrors the proxy
/// `fillGradient` in `maskMorphology.ts`.
pub(super) fn fill_gradient(mask: &mut GrayImage, region: &[f64], subtract: bool) {
    let ax = region[0];
    let ay = region[1];
    let dx = region[2] - ax;
    let dy = region[3] - ay;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-6 {
        return;
    }
    let (w, h) = mask.dimensions();
    for y in 0..h {
        for x in 0..w {
            let t =
                (((x as f64 + 0.5 - ax) * dx + (y as f64 + 0.5 - ay) * dy) / len2).clamp(0.0, 1.0);
            let ramp = (255.0 * (1.0 - t)).round() as i32;
            let px = &mut mask.get_pixel_mut(x, y).0[0];
            let v = *px as i32;
            *px = if subtract {
                (v - ramp).max(0) as u8
            } else {
                v.max(ramp) as u8
            };
        }
    }
}

/// Clear the mask outside a `crop` region (`[x1, y1, x2, y2]` image-space).
pub(super) fn crop_mask(mask: &mut GrayImage, region: &[f64]) {
    let x1 = region[0].min(region[2]);
    let y1 = region[1].min(region[3]);
    let x2 = region[0].max(region[2]);
    let y2 = region[1].max(region[3]);
    for (x, y, p) in mask.enumerate_pixels_mut() {
        let cx = f64::from(x) + 0.5;
        let cy = f64::from(y) + 0.5;
        if cx < x1 || cx > x2 || cy < y1 || cy > y2 {
            p.0[0] = MASK_OFF;
        }
    }
}

/// Move / scale / rotate the mask about the image centre (M5 free transform):
/// inverse-mapped nearest-neighbour sampling, pixels mapping outside the
/// source read as background. `dx`/`dy` are px, `rotate` degrees clockwise,
/// `scale` a uniform factor. Mirrors the proxy `transformMask` in
/// `maskMorphology.ts`.
pub(super) fn transform_mask(
    mask: &GrayImage,
    dx: f64,
    dy: f64,
    scale: f64,
    rotate: f64,
) -> GrayImage {
    let (width, height) = mask.dimensions();
    let s = scale.max(1e-6);
    let rad = rotate.to_radians();
    let (sin, cos) = rad.sin_cos();
    let cx = f64::from(width) / 2.0;
    let cy = f64::from(height) / 2.0;
    let mut out = GrayImage::new(width, height);
    for (x, y, p) in out.enumerate_pixels_mut() {
        // Invert: un-translate, un-rotate, un-scale about the centre.
        let tx = f64::from(x) + 0.5 - dx - cx;
        let ty = f64::from(y) + 0.5 - dy - cy;
        let rx = (tx * cos + ty * sin) / s + cx;
        let ry = (-tx * sin + ty * cos) / s + cy;
        let sx = rx.floor();
        let sy = ry.floor();
        if sx < 0.0 || sy < 0.0 || sx >= f64::from(width) || sy >= f64::from(height) {
            continue;
        }
        p.0[0] = mask.get_pixel(sx as u32, sy as u32).0[0];
    }
    out
}

/// Flood-fill from a seed, painting `fill` over the contiguous region whose
/// colour stays within `tolerance` (max per-channel RGB distance) of the seed
/// colour — `MASK_ON` selects (wand / paint bucket), `MASK_OFF` erases (magic
/// eraser).
pub(super) fn wand_select(
    image: &RgbaImage,
    mask: &mut GrayImage,
    seed_x: u32,
    seed_y: u32,
    tolerance: i32,
    fill: u8,
) {
    let (width, height) = image.dimensions();
    if seed_x >= width || seed_y >= height {
        return;
    }
    let seed = image.get_pixel(seed_x, seed_y).0;
    let mut visited = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    queue.push_back((seed_x, seed_y));
    visited[(seed_y * width + seed_x) as usize] = true;

    while let Some((x, y)) = queue.pop_front() {
        let px = image.get_pixel(x, y).0;
        let dist = (0..3)
            .map(|c| (i32::from(px[c]) - i32::from(seed[c])).abs())
            .max()
            .unwrap_or(0);
        if dist > tolerance {
            continue;
        }
        mask.put_pixel(x, y, Luma([fill]));
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !visited[idx] {
                visited[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
}

/// Minimum redness (`r − max(g, b)`) for a pixel to read as part of a red
/// reflection.
const RED_EYE_MIN: i32 = 32;

/// How red-dominant a pixel is: the red channel's excess over the stronger
/// of green / blue.
fn redness(px: [u8; 4]) -> i32 {
    i32::from(px[0]) - i32::from(px[1]).max(i32::from(px[2]))
}

/// Red eye (PS J flyout, on a mask): flood-fill from the click over the
/// contiguous red-dominant region (`redness ≥ RED_EYE_MIN`), selecting it
/// into the mask. A click on a non-red pixel is a no-op.
pub(super) fn red_eye_select(image: &RgbaImage, mask: &mut GrayImage, seed_x: u32, seed_y: u32) {
    let (width, height) = image.dimensions();
    if seed_x >= width || seed_y >= height {
        return;
    }
    if redness(image.get_pixel(seed_x, seed_y).0) < RED_EYE_MIN {
        return;
    }
    let mut visited = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    queue.push_back((seed_x, seed_y));
    visited[(seed_y * width + seed_x) as usize] = true;
    while let Some((x, y)) = queue.pop_front() {
        if redness(image.get_pixel(x, y).0) < RED_EYE_MIN {
            continue;
        }
        mask.put_pixel(x, y, Luma([MASK_ON]));
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !visited[idx] {
                visited[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
}

fn neighbours(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(4);
    if x > 0 {
        out.push((x - 1, y));
    }
    if x + 1 < width {
        out.push((x + 1, y));
    }
    if y > 0 {
        out.push((x, y - 1));
    }
    if y + 1 < height {
        out.push((x, y + 1));
    }
    out
}

/// Stamp filled discs of `radius` along a polyline, writing `value`.
pub(super) fn stamp_stroke(mask: &mut GrayImage, points: &[(f32, f32)], radius: u32, value: u8) {
    for &(px, py) in points {
        stamp_disc(mask, px, py, radius, value);
    }
}

pub(super) fn stamp_disc(mask: &mut GrayImage, cx: f32, cy: f32, radius: u32, value: u8) {
    let (width, height) = mask.dimensions();
    let r = radius as i32;
    let cxi = cx.round() as i32;
    let cyi = cy.round() as i32;
    for dy in -r..=r {
        for dx in -r..=r {
            if dx * dx + dy * dy > r * r {
                continue;
            }
            let x = cxi + dx;
            let y = cyi + dy;
            if x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                mask.put_pixel(x as u32, y as u32, Luma([value]));
            }
        }
    }
}

/// Stamp soft discs along a polyline at `spacing * diameter` intervals
/// (resampling between the recorded points so sparse polylines still read as
/// a continuous band).
pub(super) fn stamp_stroke_soft(
    mask: &mut GrayImage,
    points: &[(f32, f32)],
    radius: u32,
    hardness: f32,
    flow: f32,
    spacing: f32,
    subtract: bool,
) {
    let step = (spacing * 2.0 * radius.max(1) as f32).max(1.0);
    if points.len() == 1 {
        stamp_disc_soft(
            mask,
            points[0].0,
            points[0].1,
            radius,
            hardness,
            flow,
            subtract,
        );
        return;
    }
    for pair in points.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        let dist = (x1 - x0).hypot(y1 - y0);
        let steps = (dist / step).ceil().max(1.0) as u32;
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let x = x0 + (x1 - x0) * t;
            let y = y0 + (y1 - y0) * t;
            stamp_disc_soft(mask, x, y, radius, hardness, flow, subtract);
        }
    }
}

/// Stamp one soft disc: full coverage inside `hardness * r` falling linearly
/// to 0 at the rim, capped by `flow`. Add max-composites the coverage up;
/// subtract multiplies the mask down - so overlapping stamps don't build
/// past the flow cap (mirrors the proxy stamp in `maskMorphology.ts`).
pub(super) fn stamp_disc_soft(
    mask: &mut GrayImage,
    cx: f32,
    cy: f32,
    radius: u32,
    hardness: f32,
    flow: f32,
    subtract: bool,
) {
    let (width, height) = mask.dimensions();
    let r = (radius.max(1)) as f32;
    let hard = hardness.clamp(0.0, 1.0) * r;
    let ri = r.ceil() as i32;
    let cxi = cx.round() as i32;
    let cyi = cy.round() as i32;
    for dy in -ri..=ri {
        for dx in -ri..=ri {
            let d = ((dx * dx + dy * dy) as f32).sqrt();
            if d > r {
                continue;
            }
            let x = cxi + dx;
            let y = cyi + dy;
            if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
                continue;
            }
            let falloff = if d <= hard {
                1.0
            } else {
                (r - d) / (r - hard).max(1e-6)
            };
            let cov = (flow.clamp(0.0, 1.0) * falloff).clamp(0.0, 1.0);
            let p = mask.get_pixel_mut(x as u32, y as u32);
            let v = f32::from(p.0[0]);
            p.0[0] = if subtract {
                (v * (1.0 - cov)).round().clamp(0.0, 255.0) as u8
            } else {
                v.max((cov * 255.0).round()) as u8
            };
        }
    }
}

pub(super) fn invert(mask: &mut GrayImage) {
    for p in mask.pixels_mut() {
        p.0[0] = 255 - p.0[0];
    }
}

/// Fill interior holes: flood the background inward from the borders, then any
/// off pixel the flood never reached is an enclosed hole and is turned on.
pub(super) fn fill_holes(mask: &mut GrayImage) {
    let (width, height) = mask.dimensions();
    let mut reachable = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    let mut seed = |x: u32, y: u32, queue: &mut VecDeque<(u32, u32)>| {
        let idx = (y * width + x) as usize;
        if !reachable[idx] && mask.get_pixel(x, y).0[0] < SELECTED_THRESHOLD {
            reachable[idx] = true;
            queue.push_back((x, y));
        }
    };
    for x in 0..width {
        seed(x, 0, &mut queue);
        seed(x, height - 1, &mut queue);
    }
    for y in 0..height {
        seed(0, y, &mut queue);
        seed(width - 1, y, &mut queue);
    }
    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in neighbours(x, y, width, height) {
            let idx = (ny * width + nx) as usize;
            if !reachable[idx] && mask.get_pixel(nx, ny).0[0] < SELECTED_THRESHOLD {
                reachable[idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            if !reachable[idx] && mask.get_pixel(x, y).0[0] < SELECTED_THRESHOLD {
                mask.put_pixel(x, y, Luma([MASK_ON]));
            }
        }
    }
}

/// Separable max filter: grow the matte outward by `radius` px. Also used by
/// [`subject_matte`](super::super::subject_matte) to build trimaps.
pub(in crate::studio) fn dilate(mask: &GrayImage, radius: u32) -> GrayImage {
    morphology(mask, radius, true)
}

/// Separable min filter: bite the matte inward by `radius` px. Also used by
/// [`subject_matte`](super::super::subject_matte) to build trimaps.
pub(in crate::studio) fn erode(mask: &GrayImage, radius: u32) -> GrayImage {
    morphology(mask, radius, false)
}

pub(super) fn morphology(mask: &GrayImage, radius: u32, grow: bool) -> GrayImage {
    if radius == 0 {
        return mask.clone();
    }
    let (width, height) = mask.dimensions();
    let (w, h) = (width as usize, height as usize);
    let r = radius as usize;
    let init = if grow { MASK_OFF } else { MASK_ON };
    let pick = |acc: u8, v: u8| if grow { acc.max(v) } else { acc.min(v) };
    let src = mask.as_raw();

    // Horizontal pass: each output row depends only on the matching source row,
    // so rows are independent and processed in parallel across CPU workers.
    let mut tmp = vec![0u8; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let base = y * w;
        for (x, slot) in row.iter_mut().enumerate() {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            let mut acc = init;
            for sx in lo..=hi {
                acc = pick(acc, src[base + sx]);
            }
            *slot = acc;
        }
    });

    // Vertical pass: each output row reads a column window from `tmp`; the rows
    // are still independent, so the same row-parallel split applies.
    let mut out = vec![0u8; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        for (x, slot) in row.iter_mut().enumerate() {
            let mut acc = init;
            for sy in lo..=hi {
                acc = pick(acc, tmp[sy * w + x]);
            }
            *slot = acc;
        }
    });

    GrayImage::from_raw(width, height, out).expect("morphology buffer matches dimensions")
}
