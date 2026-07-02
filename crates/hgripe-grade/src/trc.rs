// Transfer-curve decode/encode for per-op linear-light maths. The working
// values stay gamma-encoded (colour-pipeline.md decision 2); ops whose maths
// assume light-linear values decode around the op via these curves.
//
// The sRGB curve matches the app's `studio/color/linear.rs` (IEC 61966-2-1);
// ProPhoto (ROMM) is the standard gamma-1.8 curve with its 1/512 linear toe.
// Alpha never passes through a TRC (coverage is already linear).

use crate::surface::GradeSpace;

/// Decode a gamma-encoded sample (`0..=1`) to linear light. The
/// scene-referred linear space is already linear: identity, no clamp.
pub fn trc_decode(space: GradeSpace, c: f32) -> f32 {
    match space {
        GradeSpace::LinearRec709 => c,
        GradeSpace::Srgb => {
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        }
        GradeSpace::ProPhoto => {
            if c < 0.031_25 {
                // 16 * Et, Et = 1/512
                c / 16.0
            } else {
                c.powf(1.8)
            }
        }
    }
}

/// Encode linear light back to a gamma-encoded sample. Clamps to `0..=1`
/// (negative linear values have no encoded representation) — except the
/// scene-referred linear space, which stays unbounded.
pub fn trc_encode(space: GradeSpace, l: f32) -> f32 {
    if space == GradeSpace::LinearRec709 {
        return l;
    }
    let l = l.clamp(0.0, 1.0);
    match space {
        GradeSpace::LinearRec709 => l,
        GradeSpace::Srgb => {
            if l <= 0.003_130_8 {
                12.92 * l
            } else {
                1.055 * l.powf(1.0 / 2.4) - 0.055
            }
        }
        GradeSpace::ProPhoto => {
            if l < 0.001_953_125 {
                16.0 * l
            } else {
                l.powf(1.0 / 1.8)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_matches_the_app_curve_goldens() {
        // The photometric midpoint golden from studio/color/linear.rs.
        assert_eq!(
            (trc_encode(GradeSpace::Srgb, 0.5) * 255.0).round() as u8,
            188
        );
        assert_eq!(trc_decode(GradeSpace::Srgb, 0.0), 0.0);
        assert!((trc_decode(GradeSpace::Srgb, 1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn round_trips_within_f32_precision() {
        for space in [GradeSpace::Srgb, GradeSpace::ProPhoto] {
            for i in 0..=1000 {
                let c = i as f32 / 1000.0;
                let rt = trc_encode(space, trc_decode(space, c));
                assert!((rt - c).abs() < 1e-5, "{space:?} {c}: {rt}");
            }
        }
    }
}
