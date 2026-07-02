// The grading operations (G2 core set). Each op declares whether its maths
// runs on gamma-encoded or linear-light values; `apply_op` decodes/re-encodes
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
    }
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
