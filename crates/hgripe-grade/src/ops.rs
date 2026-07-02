// The grading operations (G2 core set + G3 video set). Each op declares
// whether its maths runs on gamma-encoded or linear-light values;
// `apply_op` decodes/re-encodes
// around linear ops using the surface's TRC (`trc.rs`). Alpha never passes
// through an op — coverage is already linear and grading is colour-only.
//
// Behaviour is pinned by `goldens/ops_core.json`, executed by both this
// crate's tests and the studio-ui mirror.

use serde::{Deserialize, Serialize};

use crate::surface::GradeSurface;
use crate::trc::{trc_decode, trc_encode};

/// Rec.709 luma weights (the design-doc choice for saturation).
const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Which channels a curve drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CurveChannel {
    Master,
    Red,
    Green,
    Blue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GradeOp {
    /// Photographic exposure: linear light × 2^ev. HDR headroom above 1.0
    /// survives until the next clamp (compositing or egress).
    Exposure { ev: f32 },
    /// Channel gains in linear light: R × 2^temp, B × 2^−temp (warm/cool),
    /// G × 2^tint (magenta/green). Nominal range ±1.
    WhiteBalance { temp: f32, tint: f32 },
    /// PS-style levels on encoded values, master channel:
    /// `out = lerp(out_black, out_white, ((v − in_black)/(in_white − in_black))^(1/gamma))`.
    Levels {
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
    },
    /// Tone curve on encoded values: control points (sorted by x, `0..=1`)
    /// interpolated with the Fritsch–Carlson monotone cubic — no overshoot,
    /// flat extrapolation outside the endpoints.
    Curves { channel: CurveChannel, points: Vec<[f32; 2]> },
    /// Saturation about the Rec.709 luma axis in linear light:
    /// `c = luma + (c − luma) × (1 + amount)`; `amount = −1` is grayscale.
    Saturation { amount: f32 },
    /// Resolve-style colour wheels, per channel in linear light:
    /// `v = ((v + lift × (1 − v)) × gain) ^ (1/gamma)`.
    /// Neutral is `lift = [0;3]`, `gamma = [1;3]`, `gain = [1;3]`.
    LiftGammaGain {
        lift: [f32; 3],
        gamma: [f32; 3],
        gain: [f32; 3],
    },
    /// Global hue/saturation/lightness shift on encoded values (like PS
    /// Hue/Saturation master): hue rotates in degrees, saturation and
    /// lightness scale by `1 + amount` in HSL space.
    HslAdjust { hue: f32, saturation: f32, lightness: f32 },
    /// 3D LUT on encoded values with tetrahedral interpolation (the same
    /// sampling the ICC engine uses). `table` is
    /// `size³ × 3` RGB triples with red varying fastest (the `.cube`
    /// convention); build one from a file with [`parse_cube`].
    Lut3d { size: u32, table: Vec<f32> },
    /// Resolve-style hue-vs-hue curve on encoded values: `x` is hue in
    /// degrees (`0..360`, periodic), `y` is the hue shift in degrees at
    /// that hue. No points is identity.
    HueVsHue { points: Vec<[f32; 2]> },
    /// Hue-vs-sat: `x` is hue in degrees (periodic), `y` is a saturation
    /// multiplier (1 = unchanged). No points is identity.
    HueVsSat { points: Vec<[f32; 2]> },
    /// Lum-vs-sat: `x` is HSL lightness (`0..=1`), `y` a saturation
    /// multiplier — e.g. desaturate shadows only. Flat outside endpoints.
    LumVsSat { points: Vec<[f32; 2]> },
    /// Sat-vs-sat: `x` is HSL saturation (`0..=1`), `y` a saturation
    /// multiplier — e.g. boost only muted colours. Flat outside endpoints.
    SatVsSat { points: Vec<[f32; 2]> },
    /// Resolve log-style zoned offsets on encoded values: shadows /
    /// midtones / highlights each add a per-channel offset weighted by a
    /// smoothstep zone split at `low_pivot` and `high_pivot`
    /// (Resolve defaults: 0.33 / 0.55). Neutral is all-zero offsets.
    LogWheels {
        shadows: [f32; 3],
        midtones: [f32; 3],
        highlights: [f32; 3],
        low_pivot: f32,
        high_pivot: f32,
    },
    /// Contrast about a pivot on encoded values:
    /// `v = pivot + (v − pivot) × amount`, clamped to `0..=1`.
    /// `amount = 1` is neutral; Resolve's default pivot is 0.435.
    Contrast { amount: f32, pivot: f32 },
}

/// Apply one op to every pixel's RGB (alpha untouched).
pub fn apply_op(surface: &mut GradeSurface, op: &GradeOp) {
    let n = (surface.w as usize) * (surface.h as usize);
    match op {
        GradeOp::Exposure { ev } => {
            let gain = 2f32.powf(*ev);
            for_each_rgb_linear(surface, n, |rgb| {
                for c in rgb.iter_mut() {
                    *c *= gain;
                }
            });
        }
        GradeOp::WhiteBalance { temp, tint } => {
            let gains = [2f32.powf(*temp), 2f32.powf(*tint), 2f32.powf(-*temp)];
            for_each_rgb_linear(surface, n, |rgb| {
                for (c, g) in rgb.iter_mut().zip(gains) {
                    *c *= g;
                }
            });
        }
        GradeOp::Levels {
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
        } => {
            let span = (in_white - in_black).max(1e-6);
            let inv_gamma = 1.0 / gamma.max(1e-6);
            for px in 0..n {
                let i = px * 4;
                for c in 0..3 {
                    let v = ((surface.data[i + c].clamp(0.0, 1.0) - in_black) / span).clamp(0.0, 1.0);
                    surface.data[i + c] = out_black + (out_white - out_black) * v.powf(inv_gamma);
                }
            }
        }
        GradeOp::Curves { channel, points } => {
            let spline = MonotoneSpline::new(points);
            let channels: &[usize] = match channel {
                CurveChannel::Master => &[0, 1, 2],
                CurveChannel::Red => &[0],
                CurveChannel::Green => &[1],
                CurveChannel::Blue => &[2],
            };
            for px in 0..n {
                let i = px * 4;
                for &c in channels {
                    surface.data[i + c] = spline.eval(surface.data[i + c].clamp(0.0, 1.0));
                }
            }
        }
        GradeOp::Saturation { amount } => {
            let k = 1.0 + amount;
            for_each_rgb_linear(surface, n, |rgb| {
                let luma = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
                for c in rgb.iter_mut() {
                    *c = luma + (*c - luma) * k;
                }
            });
        }
        GradeOp::LiftGammaGain { lift, gamma, gain } => {
            let inv_gamma = [
                1.0 / gamma[0].max(1e-6),
                1.0 / gamma[1].max(1e-6),
                1.0 / gamma[2].max(1e-6),
            ];
            for_each_rgb_linear(surface, n, |rgb| {
                for c in 0..3 {
                    let v = ((rgb[c] + lift[c] * (1.0 - rgb[c])) * gain[c]).max(0.0);
                    rgb[c] = v.powf(inv_gamma[c]);
                }
            });
        }
        GradeOp::HslAdjust {
            hue,
            saturation,
            lightness,
        } => {
            for px in 0..n {
                let i = px * 4;
                let rgb = [
                    surface.data[i].clamp(0.0, 1.0),
                    surface.data[i + 1].clamp(0.0, 1.0),
                    surface.data[i + 2].clamp(0.0, 1.0),
                ];
                let (h, s, l) = rgb_to_hsl(rgb);
                let out = hsl_to_rgb(
                    (h + hue).rem_euclid(360.0),
                    (s * (1.0 + saturation)).clamp(0.0, 1.0),
                    (l * (1.0 + lightness)).clamp(0.0, 1.0),
                );
                surface.data[i] = out[0];
                surface.data[i + 1] = out[1];
                surface.data[i + 2] = out[2];
            }
        }
        GradeOp::HueVsHue { points } => {
            let curve = PeriodicSpline::new(points, 0.0);
            for_each_hsl(surface, n, |h, s, l| ((h + curve.eval(h)).rem_euclid(360.0), s, l));
        }
        GradeOp::HueVsSat { points } => {
            let curve = PeriodicSpline::new(points, 1.0);
            for_each_hsl(surface, n, |h, s, l| (h, (s * curve.eval(h)).clamp(0.0, 1.0), l));
        }
        GradeOp::LumVsSat { points } => {
            let curve = MultiplierSpline::new(points);
            for_each_hsl(surface, n, |h, s, l| (h, (s * curve.eval(l)).clamp(0.0, 1.0), l));
        }
        GradeOp::SatVsSat { points } => {
            let curve = MultiplierSpline::new(points);
            for_each_hsl(surface, n, |h, s, l| (h, (s * curve.eval(s)).clamp(0.0, 1.0), l));
        }
        GradeOp::LogWheels {
            shadows,
            midtones,
            highlights,
            low_pivot,
            high_pivot,
        } => {
            let low = low_pivot.max(1e-6);
            let high_span = (1.0 - high_pivot).max(1e-6);
            for px in 0..n {
                let i = px * 4;
                for c in 0..3 {
                    let v = surface.data[i + c].clamp(0.0, 1.0);
                    let w_s = 1.0 - smoothstep(v / low);
                    let w_h = smoothstep((v - high_pivot) / high_span);
                    let w_m = (1.0 - w_s - w_h).max(0.0);
                    surface.data[i + c] =
                        (v + w_s * shadows[c] + w_m * midtones[c] + w_h * highlights[c]).clamp(0.0, 1.0);
                }
            }
        }
        GradeOp::Contrast { amount, pivot } => {
            for px in 0..n {
                let i = px * 4;
                for c in 0..3 {
                    let v = surface.data[i + c].clamp(0.0, 1.0);
                    surface.data[i + c] = (pivot + (v - pivot) * amount).clamp(0.0, 1.0);
                }
            }
        }
        GradeOp::Lut3d { size, table } => {
            let lut = Lut3d::new(*size, table);
            for px in 0..n {
                let i = px * 4;
                let out = lut.sample([
                    surface.data[i].clamp(0.0, 1.0),
                    surface.data[i + 1].clamp(0.0, 1.0),
                    surface.data[i + 2].clamp(0.0, 1.0),
                ]);
                surface.data[i] = out[0];
                surface.data[i + 1] = out[1];
                surface.data[i + 2] = out[2];
            }
        }
    }
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// Convert each pixel to HSL, map it, convert back (alpha untouched).
fn for_each_hsl(surface: &mut GradeSurface, n: usize, f: impl Fn(f32, f32, f32) -> (f32, f32, f32)) {
    for px in 0..n {
        let i = px * 4;
        let (h, s, l) = rgb_to_hsl([
            surface.data[i].clamp(0.0, 1.0),
            surface.data[i + 1].clamp(0.0, 1.0),
            surface.data[i + 2].clamp(0.0, 1.0),
        ]);
        let (h, s, l) = f(h, s, l);
        let out = hsl_to_rgb(h, s, l);
        surface.data[i] = out[0];
        surface.data[i + 1] = out[1];
        surface.data[i + 2] = out[2];
    }
}

/// A hue-domain curve (period 360): the control points are replicated one
/// period below and above before building the spline, so evaluation wraps
/// seamlessly. No points evaluates to `neutral` everywhere.
struct PeriodicSpline {
    spline: MonotoneSpline,
    neutral: f32,
    empty: bool,
}

impl PeriodicSpline {
    fn new(points: &[[f32; 2]], neutral: f32) -> Self {
        let mut base: Vec<[f32; 2]> = points.iter().map(|p| [p[0].rem_euclid(360.0), p[1]]).collect();
        base.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut wrapped: Vec<[f32; 2]> = Vec::with_capacity(base.len() * 3);
        for shift in [-360.0, 0.0, 360.0] {
            wrapped.extend(base.iter().map(|p| [p[0] + shift, p[1]]));
        }
        Self {
            spline: MonotoneSpline::new(&wrapped),
            neutral,
            empty: points.is_empty(),
        }
    }

    fn eval(&self, hue: f32) -> f32 {
        if self.empty {
            return self.neutral;
        }
        self.spline.eval(hue.rem_euclid(360.0))
    }
}

/// A `0..=1`-domain multiplier curve: no points is the identity
/// multiplier 1; otherwise the monotone spline (flat outside endpoints).
struct MultiplierSpline {
    spline: MonotoneSpline,
    empty: bool,
}

impl MultiplierSpline {
    fn new(points: &[[f32; 2]]) -> Self {
        Self {
            spline: MonotoneSpline::new(points),
            empty: points.is_empty(),
        }
    }

    fn eval(&self, x: f32) -> f32 {
        if self.empty {
            return 1.0;
        }
        self.spline.eval(x)
    }
}

/// RGB (`0..=1`) → HSL with hue in degrees (`0..360`).
pub(crate) fn rgb_to_hsl(rgb: [f32; 3]) -> (f32, f32, f32) {
    let max = rgb[0].max(rgb[1]).max(rgb[2]);
    let min = rgb[0].min(rgb[1]).min(rgb[2]);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d <= 0.0 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == rgb[0] {
        60.0 * ((rgb[1] - rgb[2]) / d).rem_euclid(6.0)
    } else if max == rgb[1] {
        60.0 * ((rgb[2] - rgb[0]) / d + 2.0)
    } else {
        60.0 * ((rgb[0] - rgb[1]) / d + 4.0)
    };
    (h, s, l)
}

/// HSL (hue in degrees) → RGB (`0..=1`).
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}

/// A 3D LUT view over a `.cube`-layout table (red varies fastest), sampled
/// with trilinear interpolation.
struct Lut3d<'a> {
    size: usize,
    table: &'a [f32],
}

impl<'a> Lut3d<'a> {
    fn new(size: u32, table: &'a [f32]) -> Self {
        let size = size as usize;
        assert!(size >= 2, "LUT size must be at least 2");
        assert_eq!(table.len(), size * size * size * 3, "LUT table length");
        Self { size, table }
    }

    fn entry(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let i = ((b * self.size + g) * self.size + r) * 3;
        [self.table[i], self.table[i + 1], self.table[i + 2]]
    }

    // Tetrahedral interpolation — the design doc's single LUT-sampling
    // definition (same choice as the ICC engine): pick one of six
    // tetrahedra by the ordering of the fractional offsets, blend its
    // four vertices.
    fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = (self.size - 1) as f32;
        let pos = [rgb[0] * n, rgb[1] * n, rgb[2] * n];
        let i0 = [
            (pos[0] as usize).min(self.size - 2),
            (pos[1] as usize).min(self.size - 2),
            (pos[2] as usize).min(self.size - 2),
        ];
        let f = [pos[0] - i0[0] as f32, pos[1] - i0[1] as f32, pos[2] - i0[2] as f32];
        let v = |dr: usize, dg: usize, db: usize| self.entry(i0[0] + dr, i0[1] + dg, i0[2] + db);
        let (fr, fg, fb) = (f[0], f[1], f[2]);
        // (w1, vertex1), (w2, vertex2), (w3, vertex3) between c000 and c111.
        let (w1, e1, w2, e2, w3, e3) = if fr > fg {
            if fg > fb {
                (fr, v(1, 0, 0), fg, v(1, 1, 0), fb, v(1, 1, 1))
            } else if fr > fb {
                (fr, v(1, 0, 0), fb, v(1, 0, 1), fg, v(1, 1, 1))
            } else {
                (fb, v(0, 0, 1), fr, v(1, 0, 1), fg, v(1, 1, 1))
            }
        } else if fb > fg {
            (fb, v(0, 0, 1), fg, v(0, 1, 1), fr, v(1, 1, 1))
        } else if fb > fr {
            (fg, v(0, 1, 0), fb, v(0, 1, 1), fr, v(1, 1, 1))
        } else {
            (fg, v(0, 1, 0), fr, v(1, 1, 0), fb, v(1, 1, 1))
        };
        let e0 = v(0, 0, 0);
        let mut out = [0.0f32; 3];
        for c in 0..3 {
            out[c] = e0[c] + w1 * (e1[c] - e0[c]) + w2 * (e2[c] - e1[c]) + w3 * (e3[c] - e2[c]);
        }
        out
    }
}

/// Parse a `.cube` 3D LUT (Adobe/Resolve format) into a [`GradeOp::Lut3d`].
/// Supports `TITLE`, `LUT_3D_SIZE`, `DOMAIN_MIN`/`DOMAIN_MAX` (input is
/// rescaled from the domain to `0..1`… only the standard `0 0 0` / `1 1 1`
/// domain is accepted), comments, and blank lines. Written in-crate per the
/// design doc's dependency policy.
pub fn parse_cube(text: &str) -> Result<GradeOp, String> {
    let mut size: Option<u32> = None;
    let mut table: Vec<f32> = Vec::new();
    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let head = parts.next().expect("non-empty line");
        match head {
            "TITLE" => {}
            "LUT_3D_SIZE" => {
                let v: u32 = parts
                    .next()
                    .ok_or_else(|| format!("line {}: LUT_3D_SIZE missing value", lineno + 1))?
                    .parse()
                    .map_err(|e| format!("line {}: bad LUT_3D_SIZE: {e}", lineno + 1))?;
                if v < 2 {
                    return Err(format!("line {}: LUT_3D_SIZE must be >= 2", lineno + 1));
                }
                size = Some(v);
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let want = if head == "DOMAIN_MIN" { 0.0 } else { 1.0 };
                for _ in 0..3 {
                    let v: f32 = parts
                        .next()
                        .ok_or_else(|| format!("line {}: {head} missing values", lineno + 1))?
                        .parse()
                        .map_err(|e| format!("line {}: bad {head}: {e}", lineno + 1))?;
                    if v != want {
                        return Err(format!("line {}: only the standard 0..1 domain is supported", lineno + 1));
                    }
                }
            }
            "LUT_1D_SIZE" => return Err(format!("line {}: 1D LUTs are not supported", lineno + 1)),
            _ => {
                // A data row: three floats (red varies fastest).
                let mut row = [0.0f32; 3];
                row[0] = head
                    .parse()
                    .map_err(|e| format!("line {}: bad value: {e}", lineno + 1))?;
                for slot in row.iter_mut().skip(1) {
                    *slot = parts
                        .next()
                        .ok_or_else(|| format!("line {}: expected 3 values", lineno + 1))?
                        .parse()
                        .map_err(|e| format!("line {}: bad value: {e}", lineno + 1))?;
                }
                table.extend_from_slice(&row);
            }
        }
    }
    let size = size.ok_or("missing LUT_3D_SIZE")?;
    let expect = (size as usize).pow(3) * 3;
    if table.len() != expect {
        return Err(format!("expected {expect} table values, got {}", table.len()));
    }
    Ok(GradeOp::Lut3d { size, table })
}

// Decode RGB to linear light, run `f`, re-encode. The encode clamps to
// `0..=1` (negative / >1 linear values have no encoded representation), which
// is where linear-op headroom lands back in range.
fn for_each_rgb_linear(surface: &mut GradeSurface, n: usize, mut f: impl FnMut(&mut [f32; 3])) {
    let space = surface.space;
    for px in 0..n {
        let i = px * 4;
        let mut rgb = [
            trc_decode(space, surface.data[i].clamp(0.0, 1.0)),
            trc_decode(space, surface.data[i + 1].clamp(0.0, 1.0)),
            trc_decode(space, surface.data[i + 2].clamp(0.0, 1.0)),
        ];
        f(&mut rgb);
        surface.data[i] = trc_encode(space, rgb[0]);
        surface.data[i + 1] = trc_encode(space, rgb[1]);
        surface.data[i + 2] = trc_encode(space, rgb[2]);
    }
}

/// Fritsch–Carlson monotone piecewise-cubic interpolation: passes through
/// every control point, never overshoots, and is flat outside the endpoints.
/// Fewer than 2 points degenerate to identity / a constant.
pub struct MonotoneSpline {
    xs: Vec<f32>,
    ys: Vec<f32>,
    tangents: Vec<f32>,
}

impl MonotoneSpline {
    pub fn new(points: &[[f32; 2]]) -> Self {
        let mut pts: Vec<[f32; 2]> = points.to_vec();
        pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).expect("finite control points"));
        let xs: Vec<f32> = pts.iter().map(|p| p[0]).collect();
        let ys: Vec<f32> = pts.iter().map(|p| p[1]).collect();
        let n = xs.len();
        let mut tangents = vec![0.0f32; n];
        if n >= 2 {
            // Secant slopes, then Fritsch–Carlson tangent limiting.
            let d: Vec<f32> = (0..n - 1)
                .map(|i| (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]).max(1e-6))
                .collect();
            tangents[0] = d[0];
            tangents[n - 1] = d[n - 2];
            for i in 1..n - 1 {
                tangents[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
            }
            for i in 0..n - 1 {
                if d[i] == 0.0 {
                    tangents[i] = 0.0;
                    tangents[i + 1] = 0.0;
                } else {
                    let a = tangents[i] / d[i];
                    let b = tangents[i + 1] / d[i];
                    let s = a * a + b * b;
                    if s > 9.0 {
                        let t = 3.0 / s.sqrt();
                        tangents[i] = t * a * d[i];
                        tangents[i + 1] = t * b * d[i];
                    }
                }
            }
        }
        Self { xs, ys, tangents }
    }

    pub fn eval(&self, x: f32) -> f32 {
        let n = self.xs.len();
        if n == 0 {
            return x; // identity when no points are set
        }
        if n == 1 || x <= self.xs[0] {
            return if x <= self.xs[0] { self.ys[0] } else { self.ys[n - 1] };
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        // The segment with xs[i] <= x < xs[i+1].
        let mut i = 0;
        while i + 2 < n && x >= self.xs[i + 1] {
            i += 1;
        }
        let h = (self.xs[i + 1] - self.xs[i]).max(1e-6);
        let t = (x - self.xs[i]) / h;
        let (t2, t3) = (t * t, t * t * t);
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        h00 * self.ys[i] + h10 * h * self.tangents[i] + h01 * self.ys[i + 1] + h11 * h * self.tangents[i + 1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface::GradeSpace;

    fn one_px(rgb: [f32; 3]) -> GradeSurface {
        GradeSurface {
            w: 1,
            h: 1,
            data: vec![rgb[0], rgb[1], rgb[2], 1.0],
            space: GradeSpace::Srgb,
        }
    }

    #[test]
    fn exposure_plus_one_ev_doubles_linear_light() {
        let mut s = one_px([0.5, 0.5, 0.5]);
        apply_op(&mut s, &GradeOp::Exposure { ev: 1.0 });
        let want = trc_encode(GradeSpace::Srgb, trc_decode(GradeSpace::Srgb, 0.5) * 2.0);
        assert!((s.data[0] - want).abs() < 1e-6);
        assert_eq!(s.data[3], 1.0); // alpha untouched
    }

    #[test]
    fn saturation_minus_one_is_grayscale() {
        let mut s = one_px([0.8, 0.3, 0.1]);
        apply_op(&mut s, &GradeOp::Saturation { amount: -1.0 });
        assert!((s.data[0] - s.data[1]).abs() < 1e-6);
        assert!((s.data[1] - s.data[2]).abs() < 1e-6);
    }

    #[test]
    fn identity_curve_and_identity_levels_are_no_ops() {
        let mut s = one_px([0.25, 0.5, 0.75]);
        let before = s.data.clone();
        apply_op(
            &mut s,
            &GradeOp::Curves {
                channel: CurveChannel::Master,
                points: vec![[0.0, 0.0], [1.0, 1.0]],
            },
        );
        apply_op(
            &mut s,
            &GradeOp::Levels {
                in_black: 0.0,
                in_white: 1.0,
                gamma: 1.0,
                out_black: 0.0,
                out_white: 1.0,
            },
        );
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-6);
        }
    }

    #[test]
    fn lift_gamma_gain_neutral_is_a_no_op() {
        let mut s = one_px([0.2, 0.5, 0.8]);
        let before = s.data.clone();
        apply_op(
            &mut s,
            &GradeOp::LiftGammaGain {
                lift: [0.0; 3],
                gamma: [1.0; 3],
                gain: [1.0; 3],
            },
        );
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-6);
        }
    }

    #[test]
    fn hsl_zero_shift_is_a_no_op_and_hue_180_twice_returns() {
        let mut s = one_px([0.7, 0.2, 0.4]);
        let before = s.data.clone();
        apply_op(&mut s, &GradeOp::HslAdjust { hue: 0.0, saturation: 0.0, lightness: 0.0 });
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-5);
        }
        apply_op(&mut s, &GradeOp::HslAdjust { hue: 180.0, saturation: 0.0, lightness: 0.0 });
        apply_op(&mut s, &GradeOp::HslAdjust { hue: 180.0, saturation: 0.0, lightness: 0.0 });
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-4);
        }
    }

    #[test]
    fn identity_lut_is_a_no_op() {
        let size = 3u32;
        let mut table = Vec::new();
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    table.extend([r as f32 / 2.0, g as f32 / 2.0, b as f32 / 2.0]);
                }
            }
        }
        let mut s = one_px([0.1, 0.55, 0.9]);
        let before = s.data.clone();
        apply_op(&mut s, &GradeOp::Lut3d { size, table });
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-6);
        }
    }

    #[test]
    fn parse_cube_reads_a_minimal_lut() {
        let text = "# comment\nTITLE \"t\"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
        let op = parse_cube(text).expect("parse");
        match &op {
            GradeOp::Lut3d { size, table } => {
                assert_eq!(*size, 2);
                assert_eq!(table.len(), 24);
            }
            other => panic!("unexpected op {other:?}"),
        }
        let mut s = one_px([0.25, 0.5, 0.75]);
        let before = s.data.clone();
        apply_op(&mut s, &op); // this LUT is identity at the corners + trilinear
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-6);
        }
    }

    #[test]
    fn parse_cube_rejects_bad_input() {
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err()); // short table
        assert!(parse_cube("0 0 0\n").is_err()); // no size
        assert!(parse_cube("LUT_1D_SIZE 2\n").is_err()); // 1D unsupported
    }

    #[test]
    fn monotone_spline_passes_through_points_and_never_overshoots() {
        let pts = vec![[0.0, 0.0], [0.25, 0.6], [0.5, 0.65], [1.0, 1.0]];
        let sp = MonotoneSpline::new(&pts);
        for p in &pts {
            assert!((sp.eval(p[0]) - p[1]).abs() < 1e-6);
        }
        let mut prev = -1.0;
        for i in 0..=1000 {
            let y = sp.eval(i as f32 / 1000.0);
            assert!(y >= prev - 1e-6, "monotone");
            assert!((0.0..=1.0).contains(&y), "no overshoot");
            prev = y;
        }
    }
}
