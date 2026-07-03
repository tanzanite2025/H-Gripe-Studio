// Spatial ops (G4): unlike every other op these read *neighbouring* pixels
// (sharpen / denoise) or the pixel's frame position (film grain), so they
// only run on a full frame — `apply_parallel` schedules any layer containing
// one serially instead of splitting it into bands (see `GradeOp::is_spatial`
// and `doc.rs`). All three work on the encoded signal, clamped to `0..=1`.

use crate::surface::GradeSurface;

/// Largest supported kernel radius (7×7). Radii are clamped to `1..=MAX_RADIUS`.
pub const MAX_RADIUS: u32 = 3;

pub(super) fn clamp_radius(radius: u32) -> i64 {
    i64::from(radius.clamp(1, MAX_RADIUS))
}

// Pixel index of the (x + dx, y + dy) tap with coordinates clamped to the
// frame edges.
fn tap(x: usize, y: usize, dx: i64, dy: i64, w: usize, h: usize) -> usize {
    let ty = (y as i64 + dy).clamp(0, h as i64 - 1) as usize;
    let tx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
    ty * w + tx
}

// C(n, k) as f32 — the binomial spatial weights for the bilateral kernel
// (row 2r of Pascal's triangle; 1-2-1 at radius 1, 1-4-6-4-1 at radius 2).
pub(super) fn binomial(n: i64, k: i64) -> f32 {
    let mut out = 1.0f64;
    for j in 0..k {
        out = out * (n - j) as f64 / (j + 1) as f64;
    }
    out as f32
}

/// Unsharp mask on encoded values: `out = v + amount × (v − blur(v))`,
/// clamped to `0..=1`. `blur` is the (2×radius+1)² box mean with
/// edge-clamped taps (radius clamped to `1..=3`, i.e. 3×3 / 5×5 / 7×7).
/// Neutral is `amount = 0`; non-finite amounts read as 0.
pub(super) fn sharpen(surface: &mut GradeSurface, amount: f32, radius: u32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 10.0)
    } else {
        0.0
    };
    let r = clamp_radius(radius);
    let count = ((2 * r + 1) * (2 * r + 1)) as f32;
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    let src: Vec<f32> = surface.data.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let mut sum = 0.0f32;
                for dy in -r..=r {
                    for dx in -r..=r {
                        sum += src[tap(x, y, dx, dy, w, h) * 4 + c];
                    }
                }
                let blur = sum / count;
                let v = src[i + c];
                surface.data[i + c] = (v + a * (v - blur)).clamp(0.0, 1.0);
            }
        }
    }
}

/// Edge-preserving bilateral denoise on encoded values, per channel: each
/// tap of the (2×radius+1)² neighbourhood (radius clamped to `1..=3`) is
/// weighted by the binomial spatial kernel (`C(2r, r+dx) × C(2r, r+dy)`;
/// 1-2-1 ⊗ 1-2-1 at radius 1) × a Gaussian range weight
/// `exp(−((u − v)/σ)²)` (σ = 0.1), then the result is blended with the
/// original by `amount` (`0..=1`; neutral 0, non-finite reads as 0).
pub(super) fn denoise(surface: &mut GradeSurface, amount: f32, radius: u32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let r = clamp_radius(radius);
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    const SIGMA: f32 = 0.1;
    let src: Vec<f32> = surface.data.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let v = src[i + c];
                let mut sum = 0.0f32;
                let mut weight = 0.0f32;
                for dy in -r..=r {
                    for dx in -r..=r {
                        let u = src[tap(x, y, dx, dy, w, h) * 4 + c];
                        let spatial = binomial(2 * r, r + dx) * binomial(2 * r, r + dy);
                        let d = (u - v) / SIGMA;
                        let wgt = spatial * (-d * d).exp();
                        sum += wgt * u;
                        weight += wgt;
                    }
                }
                let filtered = sum / weight;
                surface.data[i + c] = (v + a * (filtered - v)).clamp(0.0, 1.0);
            }
        }
    }
}

// Integer position hash (lowbias32-style avalanche over x, y and the seed):
// pure 32-bit integer maths, so both kernel ends produce the same bits and
// the grain field is fully deterministic per (position, seed).
fn grain_hash(x: u32, y: u32, seed: u32) -> u32 {
    let mut h =
        x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77) ^ seed.wrapping_mul(0xC2B2_AE3D);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^= h >> 16;
    h
}

/// Monochrome film grain on encoded values: a deterministic per-pixel noise
/// sample in `[-1, 1)` (from `grain_hash(x, y, seed)`) is added to all three
/// channels scaled by `amount` (`0..=1`; neutral 0, non-finite reads as 0),
/// then clamped. The grain field depends only on frame position and `seed`.
pub(super) fn film_grain(surface: &mut GradeSurface, amount: f32, seed: u32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (w, h) = (surface.w as usize, surface.h as usize);
    for y in 0..h {
        for x in 0..w {
            let noise = ((f64::from(grain_hash(x as u32, y as u32, seed)) / 4294967296.0) * 2.0
                - 1.0) as f32;
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let v = surface.data[i + c].clamp(0.0, 1.0);
                surface.data[i + c] = (v + a * noise).clamp(0.0, 1.0);
            }
        }
    }
}

/// Largest supported Gaussian blur sigma, in pixels. Sigmas are clamped to
/// `0..=MAX_BLUR_SIGMA`; the kernel radius is `ceil(3σ)` (up to
/// 3 × MAX_BLUR_SIGMA taps each side), covering ~99.7% of the Gaussian.
pub const MAX_BLUR_SIGMA: f32 = 32.0;

/// The separable Gaussian kernel for `sigma`: `(radius, weights)` where
/// `weights[k]` is the normalised weight of tap `k − radius`
/// (`k = 0..=2×radius`). Weights are computed in f64 and cast once, so the
/// CPU path and the WGSL codegen bake the same numbers. `None` when the
/// clamped sigma rounds to radius 0 (the blur is a no-op).
pub(crate) fn gaussian_weights(sigma: f32) -> Option<(i64, Vec<f32>)> {
    let s = if sigma.is_finite() {
        sigma.clamp(0.0, MAX_BLUR_SIGMA)
    } else {
        0.0
    };
    let r = (3.0 * f64::from(s)).ceil() as i64;
    if r == 0 {
        return None;
    }
    let s2 = 2.0 * f64::from(s) * f64::from(s);
    let raw: Vec<f64> = (-r..=r).map(|k| (-((k * k) as f64) / s2).exp()).collect();
    let sum: f64 = raw.iter().sum();
    Some((r, raw.iter().map(|w| (w / sum) as f32).collect()))
}

/// Separable large-radius Gaussian blur on encoded values, clamped to
/// `0..=1`: two 1D passes (horizontal, then vertical) over the normalised
/// kernel `exp(−k²/(2σ²))` with edge-clamped taps. `sigma` is in pixels,
/// clamped to `0..=MAX_BLUR_SIGMA` (non-finite reads as 0); neutral is
/// `sigma = 0`. This is the blur primitive halation / bloom / glow / dehaze
/// build on. Alpha is untouched.
pub(super) fn gaussian_blur(surface: &mut GradeSurface, sigma: f32) {
    let Some((r, weights)) = gaussian_weights(sigma) else {
        return;
    };
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    let src: Vec<f32> = surface.data.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    // Horizontal pass into a temporary plane…
    let mut tmp = src.clone();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let mut sum = 0.0f32;
                for (k, wgt) in weights.iter().enumerate() {
                    sum += wgt * src[tap(x, y, k as i64 - r, 0, w, h) * 4 + c];
                }
                tmp[i + c] = sum;
            }
        }
    }
    // …then the vertical pass back into the surface.
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let mut sum = 0.0f32;
                for (k, wgt) in weights.iter().enumerate() {
                    sum += wgt * tmp[tap(x, y, 0, k as i64 - r, w, h) * 4 + c];
                }
                surface.data[i + c] = sum.clamp(0.0, 1.0);
            }
        }
    }
}

/// Parametric vignette on encoded values: a radial gain over the frame's
/// centred ellipse. With normalised coordinates `nx, ny ∈ −1..=1` across
/// the frame, `d = √(nx² + ny²) / √2` (0 at the centre, 1 in the corners),
/// the falloff weight is `smoothstep((d − midpoint) / feather)` and each
/// channel is scaled by `1 + amount × weight`, clamped to `0..=1`.
/// `amount` clamps to `−1..=1` (negative darkens the edges; neutral 0,
/// non-finite reads as 0), `midpoint` to `0..=1` (non-finite reads as 0.5),
/// `feather` to `1e-3..=1` (non-finite reads as 0.5). Alpha is untouched.
pub(super) fn vignette(surface: &mut GradeSurface, amount: f32, midpoint: f32, feather: f32) {
    let a = if amount.is_finite() {
        amount.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let m = if midpoint.is_finite() {
        midpoint.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let f = if feather.is_finite() {
        feather.clamp(1e-3, 1.0)
    } else {
        0.5
    };
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    for y in 0..h {
        let ny = (y as f32 + 0.5) / h as f32 * 2.0 - 1.0;
        for x in 0..w {
            let nx = (x as f32 + 0.5) / w as f32 * 2.0 - 1.0;
            let d = (nx * nx + ny * ny).sqrt() / std::f32::consts::SQRT_2;
            let gain = 1.0 + a * super::smoothstep((d - m) / f);
            let i = (y * w + x) * 4;
            for c in 0..3 {
                surface.data[i + c] = (surface.data[i + c].clamp(0.0, 1.0) * gain).clamp(0.0, 1.0);
            }
        }
    }
}

/// Motion-adaptive temporal denoise for video: blend the current frame
/// toward the previous *graded* frame per channel, weighting each pixel by
/// a Gaussian range term `exp(−((u − v)/σ)²)` (σ = 0.1) so large
/// frame-to-frame differences (motion) keep the current value and avoid
/// ghosting: `out = v + amount × w × (u − v)`, clamped to `0..=1`.
///
/// This is not a [`crate::GradeOp`] — the op graph is stateless per frame —
/// but a video-pipeline stage the caller runs *after* [`crate::apply`],
/// feeding back its own output as `prev` for the next frame. Neutral is
/// `amount = 0` (non-finite reads as 0); if `prev` has a different shape or
/// space the frame is left untouched. Alpha is untouched.
pub fn temporal_denoise(current: &mut GradeSurface, prev: &GradeSurface, amount: f32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 1.0)
    } else {
        0.0
    };
    if current.w != prev.w
        || current.h != prev.h
        || current.space != prev.space
        || current.data.len() != prev.data.len()
    {
        return;
    }
    const SIGMA: f32 = 0.1;
    for (i, v) in current.data.iter_mut().enumerate() {
        if i % 4 == 3 {
            continue;
        }
        let cur = v.clamp(0.0, 1.0);
        let u = prev.data[i].clamp(0.0, 1.0);
        let d = (u - cur) / SIGMA;
        let w = (-d * d).exp();
        *v = (cur + a * w * (u - cur)).clamp(0.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::temporal_denoise;
    use crate::ops::{apply_op, GradeOp};
    use crate::surface::{GradeSpace, GradeSurface};

    fn gradient(w: u32, h: u32) -> GradeSurface {
        let n = (w * h) as usize;
        let mut data = Vec::with_capacity(n * 4);
        for px in 0..n {
            let t = px as f32 / n as f32;
            data.extend([t, (t * 5.0).fract(), 1.0 - t, 1.0]);
        }
        GradeSurface {
            w,
            h,
            data,
            space: GradeSpace::Srgb,
        }
    }

    #[test]
    fn spatial_neutral_amounts_are_no_ops() {
        for op in [
            GradeOp::Sharpen {
                amount: 0.0,
                radius: 1,
            },
            GradeOp::Denoise {
                amount: 0.0,
                radius: 2,
            },
            GradeOp::FilmGrain {
                amount: 0.0,
                seed: 7,
            },
        ] {
            let mut s = gradient(5, 4);
            let before = s.data.clone();
            apply_op(&mut s, &op);
            for (got, want) in s.data.iter().zip(&before) {
                assert!((got - want).abs() < 1e-6, "{op:?}");
            }
        }
    }

    #[test]
    fn sharpen_increases_local_contrast_at_an_edge() {
        // A vertical step edge: sharpening pushes the dark side darker and
        // the bright side brighter.
        let mut s = GradeSurface {
            w: 4,
            h: 1,
            data: vec![
                0.2, 0.2, 0.2, 1.0, 0.2, 0.2, 0.2, 1.0, 0.8, 0.8, 0.8, 1.0, 0.8, 0.8, 0.8, 1.0,
            ],
            space: GradeSpace::Srgb,
        };
        apply_op(
            &mut s,
            &GradeOp::Sharpen {
                amount: 1.0,
                radius: 1,
            },
        );
        assert!(s.data[4] < 0.2, "dark side of the edge got darker");
        assert!(s.data[8] > 0.8, "bright side of the edge got brighter");
        assert_eq!(s.data[7], 1.0, "alpha untouched");
    }

    #[test]
    fn denoise_pulls_an_outlier_toward_its_neighbours() {
        // A flat field with one bright speck: denoising shrinks the speck
        // but leaves the flat field (nearly) alone.
        let mut data = vec![0.5f32; 9 * 4];
        for i in (3..9 * 4).step_by(4) {
            data[i] = 1.0;
        }
        data[4 * 4] = 0.9; // centre pixel red channel speck
        let mut s = GradeSurface {
            w: 3,
            h: 3,
            data,
            space: GradeSpace::Srgb,
        };
        apply_op(
            &mut s,
            &GradeOp::Denoise {
                amount: 1.0,
                radius: 1,
            },
        );
        assert!(s.data[4 * 4] < 0.9, "speck shrank");
        assert!((s.data[0] - 0.5).abs() < 0.05, "flat field kept");
    }

    #[test]
    fn film_grain_is_deterministic_and_seed_dependent() {
        let mut a = gradient(6, 3);
        let mut b = gradient(6, 3);
        let op = GradeOp::FilmGrain {
            amount: 0.2,
            seed: 42,
        };
        apply_op(&mut a, &op);
        apply_op(&mut b, &op);
        assert_eq!(a.data, b.data, "same seed, same grain");

        let mut c = gradient(6, 3);
        apply_op(
            &mut c,
            &GradeOp::FilmGrain {
                amount: 0.2,
                seed: 43,
            },
        );
        assert_ne!(a.data, c.data, "different seed, different grain");
    }

    #[test]
    fn wider_radius_blurs_more() {
        // Sharpening a step edge with a wider radius overshoots further:
        // the wider box mean is flatter, so v − blur grows at the edge.
        let edge = |radius| {
            let mut s = gradient(9, 7);
            apply_op(
                &mut s,
                &GradeOp::Sharpen {
                    amount: 1.0,
                    radius,
                },
            );
            s
        };
        let r1 = edge(1);
        let r3 = edge(3);
        assert_ne!(r1.data, r3.data, "radius changes the result");
        // Out-of-range radii clamp instead of misbehaving.
        let r9 = edge(9);
        assert_eq!(r3.data, r9.data, "radius clamps to 3");
    }

    #[test]
    fn blur_zero_sigma_is_a_no_op_and_wider_sigma_flattens_more() {
        let mut s = gradient(9, 7);
        let before = s.data.clone();
        apply_op(&mut s, &GradeOp::Blur { sigma: 0.0 });
        assert_eq!(s.data, before, "sigma 0 is a no-op");

        let spread = |sigma| {
            let mut s = gradient(9, 7);
            apply_op(&mut s, &GradeOp::Blur { sigma });
            let vals: Vec<f32> = s.data.iter().step_by(4).copied().collect();
            let max = vals.iter().cloned().fold(f32::MIN, f32::max);
            let min = vals.iter().cloned().fold(f32::MAX, f32::min);
            max - min
        };
        let s1 = spread(1.0);
        let s4 = spread(4.0);
        assert!(s4 < s1, "wider sigma flattens the gradient more");

        // Out-of-range sigmas clamp instead of misbehaving.
        let mut a = gradient(9, 7);
        apply_op(&mut a, &GradeOp::Blur { sigma: 32.0 });
        let mut b = gradient(9, 7);
        apply_op(&mut b, &GradeOp::Blur { sigma: 1e9 });
        assert_eq!(a.data, b.data, "sigma clamps to MAX_BLUR_SIGMA");
    }

    #[test]
    fn blur_preserves_a_flat_field_and_alpha() {
        let mut s = GradeSurface {
            w: 5,
            h: 4,
            data: [0.3f32, 0.6, 0.9, 0.5].repeat(20),
            space: GradeSpace::Srgb,
        };
        apply_op(&mut s, &GradeOp::Blur { sigma: 2.5 });
        for px in s.data.chunks(4) {
            assert!((px[0] - 0.3).abs() < 1e-5, "flat field kept");
            assert!((px[1] - 0.6).abs() < 1e-5);
            assert!((px[2] - 0.9).abs() < 1e-5);
            assert_eq!(px[3], 0.5, "alpha untouched");
        }
    }

    #[test]
    fn vignette_darkens_corners_and_keeps_the_centre() {
        let mut s = GradeSurface {
            w: 9,
            h: 9,
            data: [0.8f32, 0.8, 0.8, 1.0].repeat(81),
            space: GradeSpace::Srgb,
        };
        let before = s.data.clone();
        apply_op(
            &mut s,
            &GradeOp::Vignette {
                amount: 0.0,
                midpoint: 0.5,
                feather: 0.5,
            },
        );
        assert_eq!(s.data, before, "amount 0 is a no-op");

        apply_op(
            &mut s,
            &GradeOp::Vignette {
                amount: -0.8,
                midpoint: 0.3,
                feather: 0.4,
            },
        );
        let centre = s.data[(4 * 9 + 4) * 4];
        let corner = s.data[0];
        assert!(corner < centre, "corners darker than the centre");
        assert!((centre - 0.8).abs() < 1e-3, "centre inside midpoint kept");
        assert_eq!(s.data[3], 1.0, "alpha untouched");
    }

    #[test]
    fn temporal_denoise_converges_and_keeps_motion() {
        let mut cur = gradient(4, 3);
        let before = cur.data.clone();
        let mut prev = gradient(4, 3);
        // Small noise-like offset converges toward prev…
        prev.data[0] = before[0] + 0.02;
        // …while a large (motion-like) change is mostly kept.
        prev.data[4] = 0.0;
        let far_before = cur.data[4];
        temporal_denoise(&mut cur, &prev, 1.0);
        assert!(
            (cur.data[0] - prev.data[0]).abs() < 0.005,
            "noise pulled in"
        );
        assert!(
            (cur.data[4] - far_before).abs() < (far_before - 0.0).abs() * 0.5,
            "motion kept"
        );
        assert_eq!(cur.data[3], before[3], "alpha untouched");

        // Mismatched shapes are a no-op.
        let mut cur2 = gradient(4, 3);
        let before2 = cur2.data.clone();
        temporal_denoise(&mut cur2, &gradient(5, 3), 1.0);
        assert_eq!(cur2.data, before2);
    }
}
