// The grading operations (G2 core set + G3 video set + G4 spatial set),
// split by family: `spline` (curve primitives), `hsl` (colour model),
// `lut` (LUT sampling + `.cube` parsing), `wb` (Planckian white balance),
// `spatial` (neighbourhood / position ops). Each op declares whether its
// maths runs on gamma-encoded or linear-light values; `apply_op`
// decodes/re-encodes around linear ops using the surface's TRC (`trc.rs`).
// Alpha never passes through an op — coverage is already linear and grading
// is colour-only.
//
// Behaviour is pinned by `goldens/*.json`, executed by both this crate's
// tests and the studio-ui mirror.

mod hsl;
mod lut;
mod spatial;
mod spline;
mod wb;

use serde::{Deserialize, Serialize};

use crate::surface::GradeSurface;
use crate::trc::{trc_decode, trc_encode};

pub use lut::parse_cube;
pub use spatial::{temporal_denoise, MAX_BLUR_SIGMA, MAX_RADIUS};

#[cfg(feature = "gpu")]
pub(crate) use spatial::gaussian_weights;
pub use spline::MonotoneSpline;

pub(crate) use hsl::rgb_to_hsl;
pub(crate) use wb::planckian_gains;

use hsl::hsl_to_rgb;
use lut::{Lut1d, Lut3d};
use spline::{MultiplierSpline, PeriodicSpline};

/// Rec.709 luma weights (the design-doc choice for saturation).
pub(crate) const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Which channels a curve drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CurveChannel {
    Master,
    Red,
    Green,
    Blue,
}

fn default_radius() -> u32 {
    1
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
    Curves {
        channel: CurveChannel,
        points: Vec<[f32; 2]>,
    },
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
    HslAdjust {
        hue: f32,
        saturation: f32,
        lightness: f32,
    },
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
    /// Soft clip in linear light: values above `high_start` roll off
    /// asymptotically toward 1 (`v = hs + (1−hs)·t/(1+t)`,
    /// `t = (v−hs)/(1−hs)`), values below `low_start` roll off toward 0
    /// (`v = ls − ls·t/(1+t)`, `t = (ls−v)/ls`; `ls = 0` hard-clips
    /// negatives). C¹-continuous at both knees. This is how scene-referred
    /// HDR headroom is mapped back into display range without a hard clip.
    SoftClip { high_start: f32, low_start: f32 },
    /// Planckian-locus white balance in linear light: `temp_k` is a
    /// correlated colour temperature in Kelvin (1667..=25000), `tint` a
    /// nominal `±1` green–magenta offset (Δy = 0.05·tint on the xy
    /// chromaticity). Channel gains are the Rec.709 linear RGB of the
    /// blackbody chromaticity at `temp_k`, relative to the 6504 K neutral,
    /// normalised to preserve Rec.709 luma — so `temp_k < 6504` warms and
    /// `temp_k > 6504` cools. Neutral is `temp_k = 6504`, `tint = 0`.
    WhiteBalanceK { temp_k: f32, tint: f32 },
    /// Resolve-style RGB mixer in linear light: each output channel is a
    /// weighted sum of the input channels (`out_c = row_c · in`), rows are
    /// `[from_red, from_green, from_blue]`. Neutral is the identity matrix.
    /// `monochrome` uses the red row as a custom B&W mix for all three
    /// channels. Non-finite weights read as 0.
    RgbMixer {
        red: [f32; 3],
        green: [f32; 3],
        blue: [f32; 3],
        monochrome: bool,
    },
    /// 1D LUT on encoded values: per-channel linear interpolation over
    /// `size` RGB triples (the `.cube` `LUT_1D_SIZE` layout — row `i` is
    /// the output for input `i/(size−1)` on each channel). Used standalone
    /// as a tone LUT, or chained before a [`GradeOp::Lut3d`] as its shaper.
    /// Build one from a file with [`parse_cube`].
    Lut1d { size: u32, table: Vec<f32> },
    /// Resolve-style colour warper on encoded values: control points on the
    /// hue–saturation plane each pull nearby colours (`hue_shift` degrees,
    /// `sat_scale` multiplier) with a smoothstep falloff over an elliptical
    /// radius (`hue_radius` degrees × `sat_radius`). Shifts from multiple
    /// points accumulate. No points is identity; non-finite points are
    /// skipped.
    ColorWarper { points: Vec<WarpPoint> },
    /// Unified colour-range adjustment on encoded values (the one tool
    /// covering PS selective-colour / black-white / hue-saturation): each
    /// pixel gets a membership weight per named range (six 120°-wide hue
    /// triangles scaled by saturation, plus whites / neutrals / blacks
    /// gated by lightness and desaturation), and the per-range deltas
    /// accumulate weighted in HSL — `hue` shifts in degrees, `saturation`
    /// scales by `1 + w·amount`, `lightness` adds `w·amount`.
    /// `monochrome` drops saturation to 0 after the lightness deltas, so
    /// the per-range `lightness` sliders become a parametric B&W mix.
    /// Neutral is all-zero deltas with `monochrome = false`; ranges with
    /// non-finite values are skipped. The global 3×3 channel mixer stays a
    /// separate op ([`GradeOp::RgbMixer`]) — it is a linear matrix, not a
    /// range-weighted adjustment.
    ColorRanges {
        ranges: Vec<RangeAdjust>,
        #[serde(default)]
        monochrome: bool,
    },
    /// Unsharp mask on encoded values: `v + amount × (v − blur(v))`,
    /// clamped; `blur` is the (2×`radius`+1)² box mean (`radius` clamps to
    /// `1..=3`, i.e. 3×3 / 5×5 / 7×7; absent reads as 1). Spatial — see
    /// [`GradeOp::is_spatial`]. Neutral is `amount = 0`.
    Sharpen {
        amount: f32,
        #[serde(default = "default_radius")]
        radius: u32,
    },
    /// Edge-preserving bilateral denoise on encoded values over the
    /// (2×`radius`+1)² neighbourhood (`radius` clamps to `1..=3`; absent
    /// reads as 1), blended with the original by `amount` (`0..=1`).
    /// Spatial — see [`GradeOp::is_spatial`]. Neutral is `amount = 0`.
    Denoise {
        amount: f32,
        #[serde(default = "default_radius")]
        radius: u32,
    },
    /// Monochrome film grain on encoded values: deterministic per-pixel
    /// noise in `[-1, 1)` from an integer hash of (x, y, `seed`), scaled by
    /// `amount` (`0..=1`). Spatial (position-dependent) — see
    /// [`GradeOp::is_spatial`]. Neutral is `amount = 0`.
    FilmGrain { amount: f32, seed: u32 },
    /// Separable large-radius Gaussian blur on encoded values: two 1D
    /// passes (horizontal, vertical) over the normalised `exp(−k²/(2σ²))`
    /// kernel with radius `ceil(3σ)` and edge-clamped taps. `sigma` is in
    /// pixels, clamped to `0..=`[`MAX_BLUR_SIGMA`]. The blur primitive
    /// halation / bloom / glow / dehaze build on. Spatial — see
    /// [`GradeOp::is_spatial`]. Neutral is `sigma = 0`.
    Blur { sigma: f32 },
    /// Parametric vignette on encoded values: a radial gain over the
    /// frame's centred ellipse. With the corner distance normalised to 1,
    /// each channel scales by `1 + amount × smoothstep((d − midpoint) /
    /// feather)`, clamped. `amount` clamps to `−1..=1` (negative darkens
    /// the edges), `midpoint` to `0..=1`, `feather` to `1e-3..=1`. Spatial
    /// (position-dependent) — see [`GradeOp::is_spatial`]. Neutral is
    /// `amount = 0`.
    Vignette {
        amount: f32,
        #[serde(default = "default_midpoint")]
        midpoint: f32,
        #[serde(default = "default_feather")]
        feather: f32,
    },
}

fn default_midpoint() -> f32 {
    0.5
}

fn default_feather() -> f32 {
    0.5
}

impl GradeOp {
    /// Whether the op reads beyond the pixel being written — neighbouring
    /// pixels (sharpen / denoise) or the pixel's frame position (film
    /// grain). Spatial ops are only correct over a full frame, so
    /// band-parallel scheduling must run their layer serially.
    pub fn is_spatial(&self) -> bool {
        matches!(
            self,
            GradeOp::Sharpen { .. }
                | GradeOp::Denoise { .. }
                | GradeOp::FilmGrain { .. }
                | GradeOp::Blur { .. }
                | GradeOp::Vignette { .. }
        )
    }
}

/// One colour-warper control point (see [`GradeOp::ColorWarper`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WarpPoint {
    pub hue: f32,
    pub sat: f32,
    pub hue_shift: f32,
    pub sat_scale: f32,
    pub hue_radius: f32,
    pub sat_radius: f32,
}

/// The nine PS-style colour ranges (see [`GradeOp::ColorRanges`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorRange {
    Reds,
    Yellows,
    Greens,
    Cyans,
    Blues,
    Magentas,
    Whites,
    Neutrals,
    Blacks,
}

impl ColorRange {
    /// The pixel's membership weight in this range, from its HSL. Chromatic
    /// ranges are a triangular hue window (±60° about the range's primary /
    /// secondary hue) scaled by saturation; whites / neutrals / blacks are
    /// smoothstep lightness zones scaled by desaturation.
    pub(crate) fn weight(self, h: f32, s: f32, l: f32) -> f32 {
        let hue_weight = |center: f32| {
            let d = (h - center).rem_euclid(360.0);
            let dh = d.min(360.0 - d);
            (1.0 - dh / 60.0).max(0.0) * s
        };
        match self {
            ColorRange::Reds => hue_weight(0.0),
            ColorRange::Yellows => hue_weight(60.0),
            ColorRange::Greens => hue_weight(120.0),
            ColorRange::Cyans => hue_weight(180.0),
            ColorRange::Blues => hue_weight(240.0),
            ColorRange::Magentas => hue_weight(300.0),
            ColorRange::Whites => smoothstep(2.0 * l - 1.0) * (1.0 - s),
            ColorRange::Neutrals => (1.0 - smoothstep((2.0 * l - 1.0).abs())) * (1.0 - s),
            ColorRange::Blacks => smoothstep(1.0 - 2.0 * l) * (1.0 - s),
        }
    }
}

/// One range's HSL deltas (see [`GradeOp::ColorRanges`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RangeAdjust {
    pub range: ColorRange,
    pub hue: f32,
    pub saturation: f32,
    pub lightness: f32,
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
                    let v =
                        ((surface.data[i + c].clamp(0.0, 1.0) - in_black) / span).clamp(0.0, 1.0);
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
            for_each_hsl(surface, n, |h, s, l| {
                ((h + curve.eval(h)).rem_euclid(360.0), s, l)
            });
        }
        GradeOp::HueVsSat { points } => {
            let curve = PeriodicSpline::new(points, 1.0);
            for_each_hsl(surface, n, |h, s, l| {
                (h, (s * curve.eval(h)).clamp(0.0, 1.0), l)
            });
        }
        GradeOp::LumVsSat { points } => {
            let curve = MultiplierSpline::new(points);
            for_each_hsl(surface, n, |h, s, l| {
                (h, (s * curve.eval(l)).clamp(0.0, 1.0), l)
            });
        }
        GradeOp::SatVsSat { points } => {
            let curve = MultiplierSpline::new(points);
            for_each_hsl(surface, n, |h, s, l| {
                (h, (s * curve.eval(s)).clamp(0.0, 1.0), l)
            });
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
                        (v + w_s * shadows[c] + w_m * midtones[c] + w_h * highlights[c])
                            .clamp(0.0, 1.0);
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
        GradeOp::SoftClip {
            high_start,
            low_start,
        } => {
            let hs = high_start.clamp(0.0, 1.0 - 1e-4);
            let ls = low_start.clamp(0.0, hs);
            for_each_rgb_linear(surface, n, |rgb| {
                for c in rgb.iter_mut() {
                    *c = soft_clip(*c, hs, ls);
                }
            });
        }
        GradeOp::WhiteBalanceK { temp_k, tint } => {
            let gains = planckian_gains(*temp_k, *tint);
            for_each_rgb_linear(surface, n, |rgb| {
                for (c, g) in rgb.iter_mut().zip(gains) {
                    *c *= g;
                }
            });
        }
        GradeOp::RgbMixer {
            red,
            green,
            blue,
            monochrome,
        } => {
            let sane = |w: &[f32; 3]| w.map(|v| if v.is_finite() { v } else { 0.0 });
            let rows = if *monochrome {
                [sane(red), sane(red), sane(red)]
            } else {
                [sane(red), sane(green), sane(blue)]
            };
            for_each_rgb_linear(surface, n, |rgb| {
                let src = *rgb;
                for c in 0..3 {
                    rgb[c] = rows[c][0] * src[0] + rows[c][1] * src[1] + rows[c][2] * src[2];
                }
            });
        }
        GradeOp::ColorWarper { points } => {
            let points: Vec<WarpPoint> = points
                .iter()
                .copied()
                .filter(|p| {
                    [
                        p.hue,
                        p.sat,
                        p.hue_shift,
                        p.sat_scale,
                        p.hue_radius,
                        p.sat_radius,
                    ]
                    .iter()
                    .all(|v| v.is_finite())
                })
                .collect();
            for_each_hsl(surface, n, |h, s, l| {
                let mut hue_shift = 0.0f32;
                let mut sat_factor = 1.0f32;
                for p in &points {
                    let dh = {
                        let d = (h - p.hue).rem_euclid(360.0);
                        d.min(360.0 - d)
                    };
                    let ds = s - p.sat.clamp(0.0, 1.0);
                    let d = ((dh / p.hue_radius.max(1e-3)).powi(2)
                        + (ds / p.sat_radius.max(1e-3)).powi(2))
                    .sqrt();
                    let w = smoothstep(1.0 - d);
                    hue_shift += w * p.hue_shift;
                    sat_factor *= 1.0 + w * (p.sat_scale - 1.0);
                }
                (
                    (h + hue_shift).rem_euclid(360.0),
                    (s * sat_factor.max(0.0)).clamp(0.0, 1.0),
                    l,
                )
            });
        }
        GradeOp::ColorRanges { ranges, monochrome } => {
            let ranges: Vec<RangeAdjust> = ranges
                .iter()
                .copied()
                .filter(|r| {
                    [r.hue, r.saturation, r.lightness]
                        .iter()
                        .all(|v| v.is_finite())
                })
                .collect();
            let monochrome = *monochrome;
            for_each_hsl(surface, n, |h, s, l| {
                let mut hue_shift = 0.0f32;
                let mut sat_factor = 1.0f32;
                let mut lum_shift = 0.0f32;
                for r in &ranges {
                    let w = r.range.weight(h, s, l);
                    hue_shift += w * r.hue;
                    sat_factor *= 1.0 + w * r.saturation;
                    lum_shift += w * r.lightness;
                }
                let out_s = if monochrome {
                    0.0
                } else {
                    (s * sat_factor.max(0.0)).clamp(0.0, 1.0)
                };
                (
                    (h + hue_shift).rem_euclid(360.0),
                    out_s,
                    (l + lum_shift).clamp(0.0, 1.0),
                )
            });
        }
        GradeOp::Lut1d { size, table } => {
            let lut = Lut1d::new(*size, table);
            for px in 0..n {
                let i = px * 4;
                for c in 0..3 {
                    surface.data[i + c] = lut.sample(c, surface.data[i + c].clamp(0.0, 1.0));
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
        GradeOp::Sharpen { amount, radius } => spatial::sharpen(surface, *amount, *radius),
        GradeOp::Denoise { amount, radius } => spatial::denoise(surface, *amount, *radius),
        GradeOp::FilmGrain { amount, seed } => spatial::film_grain(surface, *amount, *seed),
        GradeOp::Blur { sigma } => spatial::gaussian_blur(surface, *sigma),
        GradeOp::Vignette {
            amount,
            midpoint,
            feather,
        } => spatial::vignette(surface, *amount, *midpoint, *feather),
    }
}

fn soft_clip(v: f32, hs: f32, ls: f32) -> f32 {
    if v > hs {
        let t = (v - hs) / (1.0 - hs);
        hs + (1.0 - hs) * t / (1.0 + t)
    } else if v < ls {
        if ls <= 0.0 {
            return 0.0;
        }
        let t = (ls - v) / ls;
        ls - ls * t / (1.0 + t)
    } else {
        v
    }
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// Convert each pixel to HSL, map it, convert back (alpha untouched).
fn for_each_hsl(
    surface: &mut GradeSurface,
    n: usize,
    f: impl Fn(f32, f32, f32) -> (f32, f32, f32),
) {
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

// Decode RGB to linear light, run `f`, re-encode. The encode clamps to
// `0..=1` (negative / >1 linear values have no encoded representation), which
// is where linear-op headroom lands back in range — except the scene-referred
// linear space, whose values pass through unclamped and unbounded.
fn for_each_rgb_linear(surface: &mut GradeSurface, n: usize, mut f: impl FnMut(&mut [f32; 3])) {
    let space = surface.space;
    let clamp_in = space != crate::surface::GradeSpace::LinearRec709;
    let load = |v: f32| if clamp_in { v.clamp(0.0, 1.0) } else { v };
    for px in surface.data[..n * 4].chunks_exact_mut(4) {
        let mut rgb = [
            trc_decode(space, load(px[0])),
            trc_decode(space, load(px[1])),
            trc_decode(space, load(px[2])),
        ];
        f(&mut rgb);
        px[0] = trc_encode(space, rgb[0]);
        px[1] = trc_encode(space, rgb[1]);
        px[2] = trc_encode(space, rgb[2]);
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
        apply_op(
            &mut s,
            &GradeOp::HslAdjust {
                hue: 0.0,
                saturation: 0.0,
                lightness: 0.0,
            },
        );
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-5);
        }
        apply_op(
            &mut s,
            &GradeOp::HslAdjust {
                hue: 180.0,
                saturation: 0.0,
                lightness: 0.0,
            },
        );
        apply_op(
            &mut s,
            &GradeOp::HslAdjust {
                hue: 180.0,
                saturation: 0.0,
                lightness: 0.0,
            },
        );
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-4);
        }
    }

    #[test]
    fn color_ranges_neutral_is_a_no_op_and_monochrome_desaturates() {
        let ranges: Vec<RangeAdjust> = [
            ColorRange::Reds,
            ColorRange::Yellows,
            ColorRange::Greens,
            ColorRange::Cyans,
            ColorRange::Blues,
            ColorRange::Magentas,
            ColorRange::Whites,
            ColorRange::Neutrals,
            ColorRange::Blacks,
        ]
        .into_iter()
        .map(|range| RangeAdjust {
            range,
            hue: 0.0,
            saturation: 0.0,
            lightness: 0.0,
        })
        .collect();
        let mut s = one_px([0.7, 0.2, 0.4]);
        let before = s.data.clone();
        apply_op(
            &mut s,
            &GradeOp::ColorRanges {
                ranges: ranges.clone(),
                monochrome: false,
            },
        );
        for (got, want) in s.data.iter().zip(&before) {
            assert!((got - want).abs() < 1e-5);
        }
        apply_op(
            &mut s,
            &GradeOp::ColorRanges {
                ranges,
                monochrome: true,
            },
        );
        assert!((s.data[0] - s.data[1]).abs() < 1e-6);
        assert!((s.data[1] - s.data[2]).abs() < 1e-6);
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
    fn parse_cube_reads_a_1d_lut() {
        let text = "TITLE \"shaper\"\nLUT_1D_SIZE 3\n0 0 0\n0.4 0.5 0.6\n1 1 1\n";
        let op = parse_cube(text).expect("parse");
        match &op {
            GradeOp::Lut1d { size, table } => {
                assert_eq!(*size, 3);
                assert_eq!(table.len(), 9);
            }
            other => panic!("unexpected op {other:?}"),
        }
        let mut s = one_px([0.25, 0.5, 0.75]);
        apply_op(&mut s, &op);
        assert!((s.data[0] - 0.2).abs() < 1e-6); // lerp(0, 0.4, 0.5)
        assert!((s.data[1] - 0.5).abs() < 1e-6); // exactly the middle row
        assert!((s.data[2] - 0.8).abs() < 1e-6); // lerp(0.6, 1, 0.5)
    }

    #[test]
    fn parse_cube_rejects_bad_input() {
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err()); // short table
        assert!(parse_cube("0 0 0\n").is_err()); // no size
        assert!(parse_cube("LUT_1D_SIZE 2\n0 0 0\n").is_err()); // short 1D table
        assert!(parse_cube("LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n").is_err()); // both sizes
    }
}
