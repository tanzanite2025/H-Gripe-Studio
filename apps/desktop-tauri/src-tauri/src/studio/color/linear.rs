//! sRGB transfer-curve (TRC) helpers for linear-light pixel maths.
//!
//! The working space stays gamma-encoded (see `colour-pipeline.md`, open
//! decision 2): only operations whose maths assume light-linear values —
//! today, the enhance resample — decode to linear here, work in `f32`, and
//! re-encode. Averaging gamma-encoded values under-weights bright pixels
//! (a black/white edge resamples to sRGB 128 instead of the photometrically
//! correct 188), which shows up as dark fringing on high-contrast edges.
//!
//! The checked-in goldens pin these exact curves and prevent accidental
//! gamma-space regressions.

/// Decode one 8-bit sRGB sample to linear light in `0.0..=1.0` (IEC 61966-2-1).
pub(crate) fn srgb_u8_to_linear(v: u8) -> f32 {
    let c = f32::from(v) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Encode linear light back to an 8-bit sRGB sample (clamping to `0.0..=1.0`).
pub(crate) fn linear_to_srgb_u8(l: f32) -> u8 {
    let l = l.clamp(0.0, 1.0);
    let c = if l <= 0.003_130_8 {
        12.92 * l
    } else {
        1.055 * l.powf(1.0 / 2.4) - 0.055
    };
    (c * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_round_trips_all_256_codes() {
        for v in 0..=255u8 {
            assert_eq!(linear_to_srgb_u8(srgb_u8_to_linear(v)), v);
        }
    }

    #[test]
    fn linear_midpoint_encodes_to_188() {
        // The photometric midpoint of black and white is 188, not the
        // gamma-space midpoint 128.
        assert_eq!(linear_to_srgb_u8(0.5), 188);
        assert_eq!(srgb_u8_to_linear(0), 0.0);
        assert!((srgb_u8_to_linear(255) - 1.0).abs() < 1e-6);
    }
}
