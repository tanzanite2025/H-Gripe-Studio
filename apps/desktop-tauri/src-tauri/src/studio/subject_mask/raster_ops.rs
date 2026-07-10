use std::collections::VecDeque;

use image::{GrayImage, Luma, RgbaImage};
use rayon::prelude::*;
use serde_json::Value;

use super::{json_f32, MASK_OFF, MASK_ON, SELECTED_THRESHOLD};

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

/// How a rasterised pen / lasso path combines with the mask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PathMode {
    Add,
    Subtract,
    Intersect,
}

impl PathMode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            PathMode::Add => "add",
            PathMode::Subtract => "subtract",
            PathMode::Intersect => "intersect",
        }
    }
}

/// A parsed pen / lasso vector path, flattened to a closed polygon.
#[derive(Debug)]
pub(super) struct MaskPath {
    pub(super) mode: PathMode,
    pub(super) tool: String,
    pub(super) polygon: Vec<(f32, f32)>,
}

/// One anchor of a pen path: the point plus optional bezier control handles.
#[derive(Debug, Clone, Copy)]
struct PathAnchor {
    x: f32,
    y: f32,
    /// Incoming control handle (the curve arrives through this point).
    handle_in: Option<(f32, f32)>,
    /// Outgoing control handle (the curve leaves through this point).
    handle_out: Option<(f32, f32)>,
}

/// Parse one pen / lasso vector path entry into a flattened closed polygon
/// ready to rasterise. A path needs at least 3 anchors to enclose an area; the
/// polygon is always closed for the fill (a lasso releases into a closed loop,
/// a pen path closes back to its first anchor).
pub(super) fn parse_mask_path(path: &Value) -> Option<MaskPath> {
    let anchors: Vec<PathAnchor> = path
        .get("points")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_path_anchor)
        .collect();
    if anchors.len() < 3 {
        return None;
    }
    let mode = match path.get("mode").and_then(Value::as_str) {
        Some("subtract") => PathMode::Subtract,
        Some("intersect") => PathMode::Intersect,
        _ => PathMode::Add,
    };
    let tool = path
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("pen")
        .to_string();
    Some(MaskPath {
        mode,
        tool,
        polygon: flatten_path(&anchors),
    })
}

fn parse_path_anchor(value: &Value) -> Option<PathAnchor> {
    let x = json_f32(value.get("x"))?;
    let y = json_f32(value.get("y"))?;
    let handle = |key: &str| -> Option<(f32, f32)> {
        let pair = value.get(key)?.as_array()?;
        Some((json_f32(pair.first())?, json_f32(pair.get(1))?))
    };
    Some(PathAnchor {
        x,
        y,
        handle_in: handle("in"),
        handle_out: handle("out"),
    })
}

/// Flatten the anchor loop into a polygon. A segment whose endpoints carry
/// bezier control handles (`out` on the start / `in` on the end) is sampled as
/// a cubic bezier; a handle-less segment is a straight line. The closing
/// segment (last anchor back to the first) is included so the fill always sees
/// a closed loop.
fn flatten_path(anchors: &[PathAnchor]) -> Vec<(f32, f32)> {
    let mut polygon = Vec::new();
    for i in 0..anchors.len() {
        let a = anchors[i];
        let b = anchors[(i + 1) % anchors.len()];
        polygon.push((a.x, a.y));
        if a.handle_out.is_none() && b.handle_in.is_none() {
            continue;
        }
        let c1 = a.handle_out.unwrap_or((a.x, a.y));
        let c2 = b.handle_in.unwrap_or((b.x, b.y));
        let chord = ((b.x - a.x).hypot(b.y - a.y)
            + (c1.0 - a.x).hypot(c1.1 - a.y)
            + (c2.0 - b.x).hypot(c2.1 - b.y)) as usize;
        let steps = chord.clamp(8, 128);
        for s in 1..steps {
            let t = s as f32 / steps as f32;
            polygon.push(cubic_bezier(a, c1, c2, b, t));
        }
    }
    polygon
}

fn cubic_bezier(
    a: PathAnchor,
    c1: (f32, f32),
    c2: (f32, f32),
    b: PathAnchor,
    t: f32,
) -> (f32, f32) {
    let u = 1.0 - t;
    let (uu, tt) = (u * u, t * t);
    let (uuu, ttt) = (uu * u, tt * t);
    (
        uuu * a.x + 3.0 * uu * t * c1.0 + 3.0 * u * tt * c2.0 + ttt * b.x,
        uuu * a.y + 3.0 * uu * t * c1.1 + 3.0 * u * tt * c2.1 + ttt * b.y,
    )
}

/// Rasterise the flattened polygon (even-odd scanline fill at pixel centres)
/// and boolean-combine it with the mask: `add` turns the interior on,
/// `subtract` turns it off, `intersect` keeps only what is already selected
/// inside it (everything outside goes off).
pub(super) fn apply_mask_path(mask: &mut GrayImage, path: &MaskPath) {
    let (width, height) = mask.dimensions();
    let polygon = &path.polygon;
    if polygon.len() < 3 {
        return;
    }
    for y in 0..height {
        let scan = y as f32 + 0.5;
        // Even-odd rule: collect the x-crossings of every polygon edge with
        // this scanline, sort them, and fill between alternating pairs.
        let mut crossings: Vec<f32> = Vec::new();
        for i in 0..polygon.len() {
            let (x0, y0) = polygon[i];
            let (x1, y1) = polygon[(i + 1) % polygon.len()];
            if (y0 <= scan) == (y1 <= scan) {
                continue;
            }
            crossings.push(x0 + (scan - y0) / (y1 - y0) * (x1 - x0));
        }
        crossings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut inside_spans: Vec<(u32, u32)> = Vec::new();
        for pair in crossings.chunks_exact(2) {
            let start = pair[0].max(0.0).round() as i64;
            let end = (pair[1].round() as i64 - 1).min(width as i64 - 1);
            if end >= start && start < width as i64 {
                inside_spans.push((start as u32, end as u32));
            }
        }
        match path.mode {
            PathMode::Add | PathMode::Subtract => {
                let value = if path.mode == PathMode::Add {
                    MASK_ON
                } else {
                    MASK_OFF
                };
                for &(start, end) in &inside_spans {
                    for x in start..=end {
                        mask.put_pixel(x, y, Luma([value]));
                    }
                }
            }
            PathMode::Intersect => {
                let mut inside = vec![false; width as usize];
                for &(start, end) in &inside_spans {
                    for x in start..=end {
                        inside[x as usize] = true;
                    }
                }
                for x in 0..width {
                    if !inside[x as usize] {
                        mask.put_pixel(x, y, Luma([MASK_OFF]));
                    }
                }
            }
        }
    }
}

/// Spot-heal (PS J on a mask): rebuild the mask inside `coverage` from its
/// surroundings by diffusion - iterative 4-neighbour averaging with the
/// boundary held fixed, converging toward the harmonic (smooth) fill.
/// Alternating forward / backward Gauss-Seidel sweeps over the coverage
/// bounding box; iterations scale with the region size under a fixed work
/// budget. Mirrors the proxy `healStroke` in `maskMorphology.ts`.
pub(super) fn heal_region(mask: &mut GrayImage, coverage: &GrayImage) {
    let (w, h) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w as i64, h as i64, -1i64, -1i64);
    let mut area: u64 = 0;
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            area += 1;
            x0 = x0.min(x as i64);
            x1 = x1.max(x as i64);
            y0 = y0.min(y as i64);
            y1 = y1.max(y as i64);
        }
    }
    if x1 < 0 {
        return;
    }
    let (x0, y0, x1, y1) = (x0 as u32, y0 as u32, x1 as u32, y1 as u32);
    // Diffusion converges in ~O(d²) sweeps for a region d pixels across;
    // clamped, and capped by a fixed total work budget for huge regions.
    let max_dim = (x1 - x0 + 1).max(y1 - y0 + 1) as u64;
    let iters = (max_dim * max_dim)
        .min(512)
        .min(400_000_000 / area.max(1))
        .max(16);
    let mut buf: Vec<f32> = mask.pixels().map(|p| f32::from(p.0[0])).collect();
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let relax = |buf: &mut Vec<f32>, x: u32, y: u32| {
        if coverage.get_pixel(x, y).0[0] == 0 {
            return;
        }
        let i = idx(x, y);
        let left = if x > 0 { buf[i - 1] } else { buf[i] };
        let right = if x < w - 1 { buf[i + 1] } else { buf[i] };
        let up = if y > 0 { buf[i - w as usize] } else { buf[i] };
        let down = if y < h - 1 {
            buf[i + w as usize]
        } else {
            buf[i]
        };
        buf[i] = (left + right + up + down) / 4.0;
    };
    for it in 0..iters {
        if it % 2 == 0 {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    relax(&mut buf, x, y);
                }
            }
        } else {
            for y in (y0..=y1).rev() {
                for x in (x0..=x1).rev() {
                    relax(&mut buf, x, y);
                }
            }
        }
    }
    for y in y0..=y1 {
        for x in x0..=x1 {
            if coverage.get_pixel(x, y).0[0] != 0 {
                mask.put_pixel(x, y, Luma([buf[idx(x, y)].round().clamp(0.0, 255.0) as u8]));
            }
        }
    }
}

/// Per-stroke exposure of the dodge / burn tool: each pass moves the covered
/// pixels half-way toward on (dodge) or off (burn).
const DODGE_BURN_EXPOSURE: f64 = 0.5;

/// Dodge / burn (PS O on a mask): locally lighten (dodge) or darken (burn)
/// the mask inside `coverage` — each covered pixel is lerped toward 255 / 0
/// by the fixed exposure. Mirrors the proxy `dodgeBurnStroke` in
/// `maskMorphology.ts`.
pub(super) fn dodge_burn_region(mask: &mut GrayImage, coverage: &GrayImage, burn: bool) {
    for (m, c) in mask.pixels_mut().zip(coverage.pixels()) {
        if c.0[0] == 0 {
            continue;
        }
        let v = f64::from(m.0[0]);
        let out = if burn {
            v * (1.0 - DODGE_BURN_EXPOSURE)
        } else {
            v + (255.0 - v) * DODGE_BURN_EXPOSURE
        };
        m.0[0] = out.round().clamp(0.0, 255.0) as u8;
    }
}

/// History brush (PS Y on a mask): restore the mask inside `coverage` to the
/// layer's pre-edit state `base`. Mirrors the proxy `historyStroke` in
/// `maskMorphology.ts`.
pub(super) fn history_region(mask: &mut GrayImage, base: &GrayImage, coverage: &GrayImage) {
    for ((m, b), c) in mask.pixels_mut().zip(base.pixels()).zip(coverage.pixels()) {
        if c.0[0] != 0 {
            m.0[0] = b.0[0];
        }
    }
}

/// Clone stamp (PS S on a mask): copy the mask inside `coverage` from the
/// `dx`/`dy` source offset — each covered pixel `p` reads the pre-op mask at
/// `p + [dx, dy]` (out-of-bounds reads as empty). Mirrors the proxy
/// `cloneStroke` in `maskMorphology.ts`.
pub(super) fn clone_region(mask: &mut GrayImage, coverage: &GrayImage, dx: i64, dy: i64) {
    let (w, h) = mask.dimensions();
    let base = mask.clone();
    for y in 0..h {
        for x in 0..w {
            if coverage.get_pixel(x, y).0[0] == 0 {
                continue;
            }
            let sx = x as i64 + dx;
            let sy = y as i64 + dy;
            let v = if sx >= 0 && sx < w as i64 && sy >= 0 && sy < h as i64 {
                base.get_pixel(sx as u32, sy as u32).0[0]
            } else {
                0
            };
            mask.put_pixel(x, y, Luma([v]));
        }
    }
}

/// Background eraser (PS E flyout, on a mask): for each stamp along the
/// stroke, erase mask pixels inside the brush disc whose colour stays within
/// `tolerance` (max per-channel RGB distance) of the image colour under the
/// stamp's centre.
pub(super) fn background_erase(
    image: &RgbaImage,
    mask: &mut GrayImage,
    points: &[(f32, f32)],
    radius: u32,
    tolerance: i32,
) {
    let (width, height) = image.dimensions();
    let r = radius as i32;
    for &(px, py) in points {
        let cx = px.round() as i32;
        let cy = py.round() as i32;
        if cx < 0 || cy < 0 || cx as u32 >= width || cy as u32 >= height {
            continue;
        }
        let seed = image.get_pixel(cx as u32, cy as u32).0;
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy > r * r {
                    continue;
                }
                let x = cx + dx;
                let y = cy + dy;
                if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
                    continue;
                }
                let c = image.get_pixel(x as u32, y as u32).0;
                let dist = (0..3)
                    .map(|ch| (i32::from(c[ch]) - i32::from(seed[ch])).abs())
                    .max()
                    .unwrap_or(0);
                if dist <= tolerance {
                    mask.put_pixel(x as u32, y as u32, Luma([MASK_OFF]));
                }
            }
        }
    }
}

/// Separable box blur (one pass), clamped at the borders. Mirrors the proxy
/// `boxBlur` in `maskMorphology.ts` (round-half-up on positive values).
pub(super) fn box_blur(mask: &GrayImage, radius: u32) -> GrayImage {
    let (w, h) = mask.dimensions();
    if radius == 0 {
        return mask.clone();
    }
    let r = radius as i64;
    let win = (2 * r + 1) as f64;
    let at = |img: &GrayImage, x: i64, y: i64| {
        f64::from(
            img.get_pixel(
                x.clamp(0, i64::from(w) - 1) as u32,
                y.clamp(0, i64::from(h) - 1) as u32,
            )
            .0[0],
        )
    };
    let mut tmp = GrayImage::new(w, h);
    for y in 0..h {
        let mut sum = 0.0;
        for x in -r..=r {
            sum += at(mask, x, i64::from(y));
        }
        for x in 0..w {
            tmp.put_pixel(x, y, Luma([(sum / win).round() as u8]));
            sum += at(mask, i64::from(x) + r + 1, i64::from(y))
                - at(mask, i64::from(x) - r, i64::from(y));
        }
    }
    let mut out = GrayImage::new(w, h);
    for x in 0..w {
        let mut sum = 0.0;
        for y in -r..=r {
            sum += at(&tmp, i64::from(x), y);
        }
        for y in 0..h {
            out.put_pixel(x, y, Luma([(sum / win).round() as u8]));
            sum += at(&tmp, i64::from(x), i64::from(y) + r + 1)
                - at(&tmp, i64::from(x), i64::from(y) - r);
        }
    }
    out
}

/// Healing brush (PS J flyout, on a mask): copy the mask inside `coverage`
/// from the `dx`/`dy` source offset like `clone_region`, but blend through a
/// feathered (box-blurred) coverage so the patch's edges melt into the
/// surroundings. Mirrors the proxy `healingBrushStroke` in
/// `maskMorphology.ts`.
pub(super) fn healing_brush_region(
    mask: &mut GrayImage,
    coverage: &GrayImage,
    dx: i64,
    dy: i64,
    radius: u32,
) {
    let (w, h) = mask.dimensions();
    let soft = box_blur(coverage, ((f64::from(radius) / 2.0).round() as u32).max(1));
    let base = mask.clone();
    for y in 0..h {
        for x in 0..w {
            let weight = f64::from(soft.get_pixel(x, y).0[0]) / 255.0;
            if weight == 0.0 {
                continue;
            }
            let sx = x as i64 + dx;
            let sy = y as i64 + dy;
            let cloned = if sx >= 0 && sx < i64::from(w) && sy >= 0 && sy < i64::from(h) {
                f64::from(base.get_pixel(sx as u32, sy as u32).0[0])
            } else {
                0.0
            };
            let v = f64::from(base.get_pixel(x, y).0[0]);
            mask.put_pixel(
                x,
                y,
                Luma([(v * (1.0 - weight) + cloned * weight).round() as u8]),
            );
        }
    }
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
