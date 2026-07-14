use std::sync::Arc;

use serde::Deserialize;

use super::{parse_id, viewports, ViewportView};

/// A single-channel mask the host tints over rendered frames. The buffer is
/// proxy resolution (the image editor's working scale) and covers the full
/// document; compositing samples it bilinearly at the view window, so the
/// tint follows zoom instead of upscaling a document-size canvas.
pub(super) struct MaskOverlay {
    pub(super) w: u32,
    pub(super) h: u32,
    /// Row-major `w * h` coverage bytes (0..255).
    pub(super) data: Vec<u8>,
    /// Tint colour (sRGB).
    pub(super) rgb: [u8; 3],
    /// Peak overlay opacity (0..=1) at full coverage.
    pub(super) alpha: f32,
    /// Tint where coverage is *low* instead of high (quick-mask ruby: the
    /// unselected area reads red, the selection reads clear).
    pub(super) invert: bool,
}

impl MaskOverlay {
    /// Bilinear coverage sample at normalized document coordinates.
    fn coverage(&self, nx: f32, ny: f32) -> f32 {
        let fx = (nx * self.w as f32 - 0.5).clamp(0.0, (self.w - 1) as f32);
        let fy = (ny * self.h as f32 - 0.5).clamp(0.0, (self.h - 1) as f32);
        let x0 = fx.floor() as u32;
        let y0 = fy.floor() as u32;
        let x1 = (x0 + 1).min(self.w - 1);
        let y1 = (y0 + 1).min(self.h - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let at = |x: u32, y: u32| f32::from(self.data[(y * self.w + x) as usize]) / 255.0;
        let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
        let bot = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
        top * (1.0 - ty) + bot * ty
    }
}

/// Composite the mask overlay over a graded surface. `proxy_dims` is the
/// full source proxy the surface was cropped from and `view` the crop, so
/// each surface pixel maps back to normalized document coordinates (the
/// overlay covers the whole document).
pub(super) fn composite_mask_overlay(
    surface: &mut hgripe_grade::GradeSurface,
    overlay: &MaskOverlay,
    proxy_dims: (u32, u32),
    view: ViewportView,
) {
    let (pw, ph) = proxy_dims;
    let (sw, sh) = (surface.w, surface.h);
    if sw == 0 || sh == 0 || pw == 0 || ph == 0 || overlay.w == 0 || overlay.h == 0 {
        return;
    }
    // Recompute the crop rect exactly as `crop_view` placed it.
    let zoom = view.zoom.max(1.0);
    let vw = ((pw as f32 / zoom).round() as u32).clamp(1, pw);
    let vh = ((ph as f32 / zoom).round() as u32).clamp(1, ph);
    let x0 = ((view.pan_x * pw as f32).round() as i64).clamp(0, (pw - vw) as i64) as f32;
    let y0 = ((view.pan_y * ph as f32).round() as i64).clamp(0, (ph - vh) as i64) as f32;
    let tint = [
        f32::from(overlay.rgb[0]) / 255.0,
        f32::from(overlay.rgb[1]) / 255.0,
        f32::from(overlay.rgb[2]) / 255.0,
    ];
    for py in 0..sh {
        let ny = (y0 + (py as f32 + 0.5) / sh as f32 * vh as f32) / ph as f32;
        for px in 0..sw {
            let nx = (x0 + (px as f32 + 0.5) / sw as f32 * vw as f32) / pw as f32;
            let mut c = overlay.coverage(nx, ny);
            if overlay.invert {
                c = 1.0 - c;
            }
            let a = (c * overlay.alpha).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let base = ((py * sw + px) * 4) as usize;
            for ch in 0..3 {
                surface.data[base + ch] = tint[ch] * a + surface.data[base + ch] * (1.0 - a);
            }
        }
    }
}

/// Composite a document-sized mask into an arbitrary retained scene window.
/// Pixels outside the document stay untouched, including inverted quick-mask
/// overlays; the pasteboard is not part of the document mask.
pub(super) fn composite_document_mask_overlay(
    surface: &mut hgripe_grade::GradeSurface,
    overlay: &MaskOverlay,
    document_dims: (u32, u32),
    visible_frame: [f32; 4],
) {
    let (dw, dh) = document_dims;
    let (sw, sh) = (surface.w, surface.h);
    let [frame_x, frame_y, frame_w, frame_h] = visible_frame;
    if sw == 0
        || sh == 0
        || dw == 0
        || dh == 0
        || overlay.w == 0
        || overlay.h == 0
        || !frame_w.is_finite()
        || !frame_h.is_finite()
        || frame_w <= 0.0
        || frame_h <= 0.0
    {
        return;
    }
    let tint = [
        f32::from(overlay.rgb[0]) / 255.0,
        f32::from(overlay.rgb[1]) / 255.0,
        f32::from(overlay.rgb[2]) / 255.0,
    ];
    for py in 0..sh {
        let document_y = frame_y + (py as f32 + 0.5) / sh as f32 * frame_h;
        let ny = document_y / dh as f32;
        if !(0.0..=1.0).contains(&ny) {
            continue;
        }
        for px in 0..sw {
            let document_x = frame_x + (px as f32 + 0.5) / sw as f32 * frame_w;
            let nx = document_x / dw as f32;
            if !(0.0..=1.0).contains(&nx) {
                continue;
            }
            let mut c = overlay.coverage(nx, ny);
            if overlay.invert {
                c = 1.0 - c;
            }
            let a = (c * overlay.alpha).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let base = ((py * sw + px) * 4) as usize;
            for ch in 0..3 {
                surface.data[base + ch] = tint[ch] * a + surface.data[base + ch] * (1.0 - a);
            }
        }
    }
}

/// One primitive of a vector overlay scene, in normalized document
/// coordinates (0..=1 over the full document, view-independent).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum OverlayItem {
    /// Dashed rect / ellipse outline — the marquee selection's marching ants.
    Marquee {
        /// `[x1, y1, x2, y2]` corners, normalized.
        region: [f32; 4],
        #[serde(default)]
        ellipse: bool,
    },
    /// A closed polygon — a committed pen / lasso path's outline, flattened
    /// to straight segments by the sender (beziers are subdivided up front).
    Polygon {
        /// `[x, y]` vertices, normalized; the loop closes implicitly.
        points: Vec<[f32; 2]>,
        /// Outline colour, premul-free `[r, g, b, a]` in 0..=1.
        stroke: [f32; 4],
        /// Even-odd interior fill colour, when the shape reads as a region.
        #[serde(default)]
        fill: Option<[f32; 4]>,
        /// Dash the outline (6-on/4-off) instead of a solid stroke.
        #[serde(default)]
        dash: bool,
    },
    /// An open polyline — the ruler measurement line.
    Polyline {
        /// `[x, y]` vertices, normalized; the loop does not close.
        points: Vec<[f32; 2]>,
        /// Stroke colour `[r, g, b, a]` in 0..=1.
        stroke: [f32; 4],
        #[serde(default)]
        dash: bool,
    },
    /// A fixed screen-size marker anchored to a document point — ruler end
    /// ticks, colour-sampler pins, SAM point prompts. `size` is in surface
    /// pixels (a radius / half-extent), so markers read the same at any zoom.
    Marker {
        /// `[x, y]` anchor, normalized.
        center: [f32; 2],
        shape: MarkerShape,
        size: f32,
        stroke: [f32; 4],
        #[serde(default)]
        fill: Option<[f32; 4]>,
    },
    /// A round-capped brush-stroke band — the advisory overlay for committed
    /// paint / matte strokes. Unlike the fixed screen-size items, the band's
    /// width is document-space (normalized against the document width), so it
    /// scales with zoom like the stroke it stands for.
    Band {
        /// `[x, y]` centreline vertices, normalized; a single point is a dot.
        points: Vec<[f32; 2]>,
        /// Band radius as a fraction of the document width.
        radius: f32,
        /// Band colour `[r, g, b, a]` in 0..=1 (alpha applied once over the
        /// whole band, however the centreline self-overlaps).
        color: [f32; 4],
    },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MarkerShape {
    /// A circle: filled when `fill` is set, ring-outlined by `stroke`.
    Disc,
    /// A `+` crosshair (SAM include points).
    Cross,
    /// A `−` horizontal bar (SAM exclude points).
    Minus,
}

/// A vector overlay the host strokes over rendered frames after grading and
/// the mask tint. Primitives are document-space geometry; stroking happens in
/// surface pixels, so outlines stay one screen pixel wide at any zoom.
#[derive(Deserialize)]
pub(crate) struct OverlayScene {
    pub(crate) items: Vec<OverlayItem>,
    /// Dash-phase offset in surface pixels for the marching ants — the
    /// sender advances it over time so the ants flow along the outline.
    #[serde(default)]
    pub(crate) phase: f32,
}

/// Marquee outline styling, matching the editor's canvas painter
/// (`paintMarquee`): high-contrast marching ants — a solid white underlay
/// stroke with black 6-on/4-off dashes on top, readable over any background.
const OVERLAY_DASH_ON: f32 = 6.0;
const OVERLAY_DASH_PERIOD: f32 = 10.0;
const OVERLAY_ANTS_UNDER: [f32; 4] = [1.0, 1.0, 1.0, 0.95];
const OVERLAY_ANTS_DASH: [f32; 4] = [0.0, 0.0, 0.0, 0.9];

/// Stroke a polyline over a graded surface, in surface pixel coordinates,
/// optionally dashed. The dash phase runs along the whole polyline so
/// corners do not restart the pattern.
fn stroke_polyline(
    surface: &mut hgripe_grade::GradeSurface,
    pts: &[(f32, f32)],
    rgba: [f32; 4],
    dash: bool,
    phase: f32,
) {
    let (sw, sh) = (surface.w as i64, surface.h as i64);
    let alpha = rgba[3];
    let mut travelled = 0.0f32;
    for seg in pts.windows(2) {
        let (ax, ay) = seg[0];
        let (bx, by) = seg[1];
        let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
        if !len.is_finite() {
            continue;
        }
        let steps = (len.ceil() as u32).clamp(1, 1 << 15);
        for i in 0..steps {
            let t = i as f32 / steps as f32;
            let d = travelled + len * t;
            if dash && (d + phase).rem_euclid(OVERLAY_DASH_PERIOD) >= OVERLAY_DASH_ON {
                continue;
            }
            let xi = (ax + (bx - ax) * t).round() as i64;
            let yi = (ay + (by - ay) * t).round() as i64;
            if xi < 0 || yi < 0 || xi >= sw || yi >= sh {
                continue;
            }
            let base = ((yi * sw + xi) * 4) as usize;
            for ch in 0..3 {
                surface.data[base + ch] =
                    rgba[ch] * alpha + surface.data[base + ch] * (1.0 - alpha);
            }
        }
        travelled += len;
    }
}

/// Even-odd scanline fill of a closed polygon over a graded surface, in
/// surface pixel coordinates — the same rule the canvas painter's
/// `fill("evenodd")` applies to committed paths.
fn fill_polygon_evenodd(
    surface: &mut hgripe_grade::GradeSurface,
    pts: &[(f32, f32)],
    rgba: [f32; 4],
) {
    if pts.len() < 3 {
        return;
    }
    let (sw, sh) = (surface.w, surface.h);
    let alpha = rgba[3];
    let mut xs: Vec<f32> = Vec::new();
    for py in 0..sh {
        let y = py as f32 + 0.5;
        xs.clear();
        for i in 0..pts.len() {
            let (x0, y0) = pts[i];
            let (x1, y1) = pts[(i + 1) % pts.len()];
            if (y0 <= y) == (y1 <= y) {
                continue;
            }
            xs.push(x0 + (y - y0) / (y1 - y0) * (x1 - x0));
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        for pair in xs.chunks(2) {
            let [a, b] = *pair else { continue };
            let from = (a.round().max(0.0)) as u32;
            let to = (b.round().min(sw as f32)) as u32;
            for px in from..to.min(sw) {
                let base = ((py * sw + px) * 4) as usize;
                for ch in 0..3 {
                    surface.data[base + ch] =
                        rgba[ch] * alpha + surface.data[base + ch] * (1.0 - alpha);
                }
            }
        }
    }
}

/// Stroke the overlay scene over a graded surface. `proxy_dims`/`view` map
/// normalized document coordinates to surface pixels with the same crop rect
/// arithmetic as [`composite_mask_overlay`], so the outline lands exactly on
/// the pixels it selects.
pub(super) fn composite_overlay_scene(
    surface: &mut hgripe_grade::GradeSurface,
    scene: &OverlayScene,
    proxy_dims: (u32, u32),
    view: ViewportView,
) {
    let (pw, ph) = proxy_dims;
    let (sw, sh) = (surface.w, surface.h);
    if sw == 0 || sh == 0 || pw == 0 || ph == 0 {
        return;
    }
    let zoom = view.zoom.max(1.0);
    let vw = ((pw as f32 / zoom).round() as u32).clamp(1, pw);
    let vh = ((ph as f32 / zoom).round() as u32).clamp(1, ph);
    let x0 = ((view.pan_x * pw as f32).round() as i64).clamp(0, (pw - vw) as i64) as f32;
    let y0 = ((view.pan_y * ph as f32).round() as i64).clamp(0, (ph - vh) as i64) as f32;
    let map = |nx: f32, ny: f32| -> (f32, f32) {
        (
            (nx * pw as f32 - x0) / vw as f32 * sw as f32 - 0.5,
            (ny * ph as f32 - y0) / vh as f32 * sh as f32 - 0.5,
        )
    };
    composite_overlay_scene_projected(surface, scene, map, pw as f32 * sw as f32 / vw as f32);
}

/// Stroke document-normalized vector overlays into an arbitrary retained
/// scene window without reinterpreting the pasteboard as the document.
pub(super) fn composite_document_overlay_scene(
    surface: &mut hgripe_grade::GradeSurface,
    scene: &OverlayScene,
    document_dims: (u32, u32),
    visible_frame: [f32; 4],
) {
    let (dw, dh) = document_dims;
    let (sw, sh) = (surface.w, surface.h);
    let [frame_x, frame_y, frame_w, frame_h] = visible_frame;
    if sw == 0
        || sh == 0
        || dw == 0
        || dh == 0
        || !frame_w.is_finite()
        || !frame_h.is_finite()
        || frame_w <= 0.0
        || frame_h <= 0.0
    {
        return;
    }
    let map = |nx: f32, ny: f32| -> (f32, f32) {
        (
            (nx * dw as f32 - frame_x) / frame_w * sw as f32 - 0.5,
            (ny * dh as f32 - frame_y) / frame_h * sh as f32 - 0.5,
        )
    };
    composite_overlay_scene_projected(surface, scene, map, dw as f32 * sw as f32 / frame_w);
}

fn composite_overlay_scene_projected(
    surface: &mut hgripe_grade::GradeSurface,
    scene: &OverlayScene,
    map: impl Fn(f32, f32) -> (f32, f32),
    document_width_scale: f32,
) {
    for item in &scene.items {
        match item {
            OverlayItem::Marquee { region, ellipse } => {
                let pts: Vec<(f32, f32)> = if *ellipse {
                    let cx = (region[0] + region[2]) / 2.0;
                    let cy = (region[1] + region[3]) / 2.0;
                    let rx = (region[2] - region[0]).abs() / 2.0;
                    let ry = (region[3] - region[1]).abs() / 2.0;
                    // Sample density follows the on-surface radius so the
                    // outline stays smooth at any zoom.
                    let (cxs, cys) = map(cx, cy);
                    let (exs, _) = map(cx + rx, cy);
                    let (_, eys) = map(cx, cy + ry);
                    let r_s = (exs - cxs).abs().max((eys - cys).abs());
                    let n = ((std::f32::consts::TAU * r_s) as u32).clamp(64, 4096);
                    (0..=n)
                        .map(|i| {
                            let t = i as f32 / n as f32 * std::f32::consts::TAU;
                            map(cx + rx * t.cos(), cy + ry * t.sin())
                        })
                        .collect()
                } else {
                    let (x1, y1) = (region[0].min(region[2]), region[1].min(region[3]));
                    let (x2, y2) = (region[0].max(region[2]), region[1].max(region[3]));
                    vec![
                        map(x1, y1),
                        map(x2, y1),
                        map(x2, y2),
                        map(x1, y2),
                        map(x1, y1),
                    ]
                };
                stroke_polyline(surface, &pts, OVERLAY_ANTS_UNDER, false, 0.0);
                // The ants flow: the scene's phase shifts the dash pattern
                // backwards so dashes march forward along the outline.
                stroke_polyline(surface, &pts, OVERLAY_ANTS_DASH, true, -scene.phase);
            }
            OverlayItem::Polygon {
                points,
                stroke,
                fill,
                dash,
            } => {
                if points.len() < 2 {
                    continue;
                }
                let mut pts: Vec<(f32, f32)> = points.iter().map(|p| map(p[0], p[1])).collect();
                if let Some(fill) = fill {
                    fill_polygon_evenodd(surface, &pts, *fill);
                }
                // Close the loop for the outline.
                pts.push(pts[0]);
                stroke_polyline(surface, &pts, *stroke, *dash, 0.0);
            }
            OverlayItem::Polyline {
                points,
                stroke,
                dash,
            } => {
                if points.len() < 2 {
                    continue;
                }
                let pts: Vec<(f32, f32)> = points.iter().map(|p| map(p[0], p[1])).collect();
                stroke_polyline(surface, &pts, *stroke, *dash, 0.0);
            }
            OverlayItem::Band {
                points,
                radius,
                color,
            } => {
                if points.is_empty() {
                    continue;
                }
                let pts: Vec<(f32, f32)> = points.iter().map(|p| map(p[0], p[1])).collect();
                // The document-space radius on the surface: normalized doc
                // width times the x scale of `map`.
                let r = (radius * document_width_scale).max(0.5);
                fill_band(surface, &pts, r, *color);
            }
            OverlayItem::Marker {
                center,
                shape,
                size,
                stroke,
                fill,
            } => {
                let (cx, cy) = map(center[0], center[1]);
                let r = size.clamp(1.0, 64.0);
                match shape {
                    MarkerShape::Disc => {
                        if let Some(fill) = fill {
                            fill_disc(surface, (cx, cy), r, *fill);
                        }
                        let n = ((std::f32::consts::TAU * r) as u32).clamp(16, 512);
                        let ring: Vec<(f32, f32)> = (0..=n)
                            .map(|i| {
                                let t = i as f32 / n as f32 * std::f32::consts::TAU;
                                (cx + r * t.cos(), cy + r * t.sin())
                            })
                            .collect();
                        stroke_polyline(surface, &ring, *stroke, false, 0.0);
                    }
                    MarkerShape::Cross => {
                        stroke_polyline(
                            surface,
                            &[(cx - r, cy), (cx + r, cy)],
                            *stroke,
                            false,
                            0.0,
                        );
                        stroke_polyline(
                            surface,
                            &[(cx, cy - r), (cx, cy + r)],
                            *stroke,
                            false,
                            0.0,
                        );
                    }
                    MarkerShape::Minus => {
                        stroke_polyline(
                            surface,
                            &[(cx - r, cy), (cx + r, cy)],
                            *stroke,
                            false,
                            0.0,
                        );
                    }
                }
            }
        }
    }
}

/// Fill a round-capped band around a polyline over a graded surface, in
/// surface pixel coordinates. Coverage is collected into a mask first so the
/// blend applies once however the centreline self-overlaps — the same read a
/// translucent canvas stroke gives.
fn fill_band(surface: &mut hgripe_grade::GradeSurface, pts: &[(f32, f32)], r: f32, rgba: [f32; 4]) {
    let (sw, sh) = (surface.w as i64, surface.h as i64);
    if sw == 0 || sh == 0 {
        return;
    }
    let r = r.min(sw.max(sh) as f32);
    let alpha = rgba[3];
    let mut mask = vec![false; (sw * sh) as usize];
    let mut stamp = |cx: f32, cy: f32| {
        let (x0, x1) = (
            ((cx - r).floor() as i64).max(0),
            ((cx + r).ceil() as i64).min(sw - 1),
        );
        let (y0, y1) = (
            ((cy - r).floor() as i64).max(0),
            ((cy + r).ceil() as i64).min(sh - 1),
        );
        for yi in y0..=y1 {
            for xi in x0..=x1 {
                let dx = xi as f32 - cx;
                let dy = yi as f32 - cy;
                if dx * dx + dy * dy <= r * r {
                    mask[(yi * sw + xi) as usize] = true;
                }
            }
        }
    };
    // Stamp discs along the centreline; half-radius spacing keeps the edge
    // sag under r/32 of a pixel-radius, visually round.
    let spacing = (r * 0.5).max(1.0);
    stamp(pts[0].0, pts[0].1);
    for seg in pts.windows(2) {
        let (ax, ay) = seg[0];
        let (bx, by) = seg[1];
        let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
        if !len.is_finite() {
            continue;
        }
        let steps = ((len / spacing).ceil() as u32).clamp(1, 1 << 15);
        for i in 1..=steps {
            let t = i as f32 / steps as f32;
            stamp(ax + (bx - ax) * t, ay + (by - ay) * t);
        }
    }
    for (i, covered) in mask.iter().enumerate() {
        if !covered {
            continue;
        }
        let base = i * 4;
        for ch in 0..3 {
            surface.data[base + ch] = rgba[ch] * alpha + surface.data[base + ch] * (1.0 - alpha);
        }
    }
}

/// Fill a disc over a graded surface, in surface pixel coordinates.
fn fill_disc(
    surface: &mut hgripe_grade::GradeSurface,
    (cx, cy): (f32, f32),
    r: f32,
    rgba: [f32; 4],
) {
    let (sw, sh) = (surface.w as i64, surface.h as i64);
    let alpha = rgba[3];
    let (x0, x1) = (
        ((cx - r).floor() as i64).max(0),
        ((cx + r).ceil() as i64).min(sw - 1),
    );
    let (y0, y1) = (
        ((cy - r).floor() as i64).max(0),
        ((cy + r).ceil() as i64).min(sh - 1),
    );
    for yi in y0..=y1 {
        for xi in x0..=x1 {
            let dx = xi as f32 - cx;
            let dy = yi as f32 - cy;
            if dx * dx + dy * dy > r * r {
                continue;
            }
            let base = ((yi * sw + xi) * 4) as usize;
            for ch in 0..3 {
                surface.data[base + ch] =
                    rgba[ch] * alpha + surface.data[base + ch] * (1.0 - alpha);
            }
        }
    }
}

/// The feedback state temporal denoise needs across renders: the previous
/// *graded* frame (inside the accumulator) plus which source frame it was,
/// so a seek, a backwards step or a source change restarts the chain instead
/// of blending across a cut.
/// Wire form of a mask overlay: coverage bytes cross as base64 (they are
/// proxy resolution — a few hundred pixels wide — so the payload stays small).
#[derive(Deserialize)]
pub(crate) struct MaskOverlayArg {
    pub(crate) w: u32,
    pub(crate) h: u32,
    /// Base64 of row-major `w * h` coverage bytes.
    pub(crate) data: String,
    pub(crate) rgb: [u8; 3],
    pub(crate) alpha: f32,
    #[serde(default)]
    pub(crate) invert: bool,
}

/// Largest accepted overlay buffer. Overlays are working-scale proxies; a
/// document-resolution buffer through this path is a caller bug.
const MAX_MASK_OVERLAY_PIXELS: u64 = 4096 * 4096;

/// Set (or clear) the mask overlay an image-edit viewport composites over
/// rendered frames: the image editor's selection tint (morphology preview,
/// quick mask), presented by the host at the view window's detail instead of
/// an upscaled document-size canvas overlay.
#[tauri::command]
pub(crate) fn viewport_set_mask_overlay(
    viewport_id: String,
    overlay: Option<MaskOverlayArg>,
) -> Result<(), String> {
    let parsed = match overlay {
        None => None,
        Some(arg) => {
            if arg.w == 0 || arg.h == 0 {
                return Err("mask overlay dimensions must be positive".to_string());
            }
            if u64::from(arg.w) * u64::from(arg.h) > MAX_MASK_OVERLAY_PIXELS {
                return Err(format!(
                    "mask overlay too large: {}x{} (max {MAX_MASK_OVERLAY_PIXELS} pixels)",
                    arg.w, arg.h
                ));
            }
            if !arg.alpha.is_finite() || !(0.0..=1.0).contains(&arg.alpha) {
                return Err(format!(
                    "mask overlay alpha must be between 0 and 1, got {}",
                    arg.alpha
                ));
            }
            let data = crate::commands::thumbnails::base64_decode(&arg.data)?;
            if data.len() != (arg.w as usize) * (arg.h as usize) {
                return Err(format!(
                    "mask overlay buffer is {} bytes, expected {}",
                    data.len(),
                    (arg.w as usize) * (arg.h as usize)
                ));
            }
            Some(Arc::new(MaskOverlay {
                w: arg.w,
                h: arg.h,
                data,
                rgb: arg.rgb,
                alpha: arg.alpha,
                invert: arg.invert,
            }))
        }
    };
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.kind != "image_edit" {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept a mask overlay",
            state.kind
        ));
    }
    state.mask_overlay = parsed;
    state.bump_render_generation();
    Ok(())
}

/// Largest accepted overlay scene: scenes are a handful of selection
/// outlines; anything bigger through this path is a caller bug.
const MAX_OVERLAY_SCENE_ITEMS: usize = 256;

/// Largest accepted flattened polygon: committed paths flatten their bezier
/// segments sender-side, so a loop is at most a few thousand vertices.
const MAX_OVERLAY_POLYGON_POINTS: usize = 16384;

/// Set (or clear) the vector overlay an image-edit or video-preview viewport
/// strokes over rendered frames: the image editor's marquee marching ants,
/// the program monitor's safe-area guides, presented by the host at the
/// view window's detail instead of a document-size canvas overlay (WGPU
/// migration: overlays on the live surface).
#[tauri::command]
pub(crate) fn viewport_set_overlay_scene(
    viewport_id: String,
    scene: Option<OverlayScene>,
) -> Result<(), String> {
    let parsed = match scene {
        None => None,
        Some(scene) => {
            if !scene.phase.is_finite() {
                return Err("overlay scene coordinates must be finite".to_string());
            }
            if scene.items.len() > MAX_OVERLAY_SCENE_ITEMS {
                return Err(format!(
                    "overlay scene has {} items (max {MAX_OVERLAY_SCENE_ITEMS})",
                    scene.items.len()
                ));
            }
            for item in &scene.items {
                match item {
                    OverlayItem::Marquee { region, .. } => {
                        if region.iter().any(|v| !v.is_finite()) {
                            return Err("overlay scene coordinates must be finite".to_string());
                        }
                    }
                    OverlayItem::Polygon {
                        points,
                        stroke,
                        fill,
                        ..
                    } => {
                        if points.len() > MAX_OVERLAY_POLYGON_POINTS {
                            return Err(format!(
                                "overlay polygon has {} points (max {MAX_OVERLAY_POLYGON_POINTS})",
                                points.len()
                            ));
                        }
                        if points.iter().flatten().any(|v| !v.is_finite()) {
                            return Err("overlay scene coordinates must be finite".to_string());
                        }
                        let colours = stroke.iter().chain(fill.iter().flatten());
                        if colours.into_iter().any(|v| !(0.0..=1.0).contains(v)) {
                            return Err("overlay colours must be between 0 and 1".to_string());
                        }
                    }
                    OverlayItem::Polyline { points, stroke, .. } => {
                        if points.len() > MAX_OVERLAY_POLYGON_POINTS {
                            return Err(format!(
                                "overlay polyline has {} points (max {MAX_OVERLAY_POLYGON_POINTS})",
                                points.len()
                            ));
                        }
                        if points.iter().flatten().any(|v| !v.is_finite()) {
                            return Err("overlay scene coordinates must be finite".to_string());
                        }
                        if stroke.iter().any(|v| !(0.0..=1.0).contains(v)) {
                            return Err("overlay colours must be between 0 and 1".to_string());
                        }
                    }
                    OverlayItem::Band {
                        points,
                        radius,
                        color,
                    } => {
                        if points.len() > MAX_OVERLAY_POLYGON_POINTS {
                            return Err(format!(
                                "overlay band has {} points (max {MAX_OVERLAY_POLYGON_POINTS})",
                                points.len()
                            ));
                        }
                        if points.iter().flatten().any(|v| !v.is_finite()) || !radius.is_finite() {
                            return Err("overlay scene coordinates must be finite".to_string());
                        }
                        if !(0.0..=1.0).contains(radius) {
                            return Err(format!(
                                "overlay band radius must be between 0 and 1, got {radius}"
                            ));
                        }
                        if color.iter().any(|v| !(0.0..=1.0).contains(v)) {
                            return Err("overlay colours must be between 0 and 1".to_string());
                        }
                    }
                    OverlayItem::Marker {
                        center,
                        size,
                        stroke,
                        fill,
                        ..
                    } => {
                        if center.iter().any(|v| !v.is_finite()) || !size.is_finite() {
                            return Err("overlay scene coordinates must be finite".to_string());
                        }
                        let colours = stroke.iter().chain(fill.iter().flatten());
                        if colours.into_iter().any(|v| !(0.0..=1.0).contains(v)) {
                            return Err("overlay colours must be between 0 and 1".to_string());
                        }
                    }
                }
            }
            Some(Arc::new(scene))
        }
    };
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.kind != "image_edit" && state.kind != "video_preview" {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept an overlay scene",
            state.kind
        ));
    }
    state.overlay_scene = parsed;
    state.bump_render_generation();
    Ok(())
}
