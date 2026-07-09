use std::collections::VecDeque;

use image::{GrayImage, Luma};
use rayon::prelude::*;

use super::{neighbours, MASK_OFF, MASK_ON, SELECTED_THRESHOLD};

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
