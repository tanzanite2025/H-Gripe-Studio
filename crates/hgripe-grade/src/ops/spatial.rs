// Spatial ops (G4): unlike every other op these read *neighbouring* pixels
// (sharpen / denoise) or the pixel's frame position (film grain), so they
// only run on a full frame — `apply_parallel` schedules any layer containing
// one serially instead of splitting it into bands (see `GradeOp::is_spatial`
// and `doc.rs`). All three work on the encoded signal, clamped to `0..=1`.

use crate::surface::GradeSurface;

// 3×3 neighbourhood of (x, y) with coordinates clamped to the frame edges,
// yielding the pixel index of each tap.
fn taps_3x3(x: usize, y: usize, w: usize, h: usize) -> [usize; 9] {
    let mut out = [0usize; 9];
    let mut k = 0;
    for dy in -1i64..=1 {
        for dx in -1i64..=1 {
            let ty = (y as i64 + dy).clamp(0, h as i64 - 1) as usize;
            let tx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
            out[k] = ty * w + tx;
            k += 1;
        }
    }
    out
}

/// Unsharp mask on encoded values: `out = v + amount × (v − blur3×3(v))`,
/// clamped to `0..=1`. `blur` is the 3×3 box mean with edge-clamped taps.
/// Neutral is `amount = 0`; non-finite amounts read as 0.
pub(super) fn sharpen(surface: &mut GradeSurface, amount: f32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 10.0)
    } else {
        0.0
    };
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    let src: Vec<f32> = surface.data.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    for y in 0..h {
        for x in 0..w {
            let taps = taps_3x3(x, y, w, h);
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let mut sum = 0.0f32;
                for t in taps {
                    sum += src[t * 4 + c];
                }
                let blur = sum / 9.0;
                let v = src[i + c];
                surface.data[i + c] = (v + a * (v - blur)).clamp(0.0, 1.0);
            }
        }
    }
}

// Binomial 3×3 spatial weights (1-2-1 ⊗ 1-2-1), row-major like `taps_3x3`.
const BILATERAL_SPATIAL: [f32; 9] = [1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 1.0, 2.0, 1.0];

/// Edge-preserving 3×3 bilateral denoise on encoded values, per channel:
/// each tap is weighted by the binomial spatial kernel × a Gaussian range
/// weight `exp(−((u − v)/σ)²)` (σ = 0.1), then the result is blended with
/// the original by `amount` (`0..=1`; neutral 0, non-finite reads as 0).
pub(super) fn denoise(surface: &mut GradeSurface, amount: f32) {
    let a = if amount.is_finite() {
        amount.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (w, h) = (surface.w as usize, surface.h as usize);
    if w == 0 || h == 0 {
        return;
    }
    const SIGMA: f32 = 0.1;
    let src: Vec<f32> = surface.data.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    for y in 0..h {
        for x in 0..w {
            let taps = taps_3x3(x, y, w, h);
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let v = src[i + c];
                let mut sum = 0.0f32;
                let mut weight = 0.0f32;
                for (k, t) in taps.iter().enumerate() {
                    let u = src[t * 4 + c];
                    let d = (u - v) / SIGMA;
                    let wgt = BILATERAL_SPATIAL[k] * (-d * d).exp();
                    sum += wgt * u;
                    weight += wgt;
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

#[cfg(test)]
mod tests {
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
            GradeOp::Sharpen { amount: 0.0 },
            GradeOp::Denoise { amount: 0.0 },
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
        apply_op(&mut s, &GradeOp::Sharpen { amount: 1.0 });
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
        apply_op(&mut s, &GradeOp::Denoise { amount: 1.0 });
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
}
