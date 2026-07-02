// The HSL qualifier — the secondary-grading gate. Selects pixels by
// hue/saturation/lightness range with a smoothstep falloff ("softness")
// outside each range, producing a per-pixel 0..=1 gate from the layer's
// *input* (the accumulated result below it). The gate multiplies with the
// layer's static mask, so windows and qualifiers compose like in Resolve.

use serde::{Deserialize, Serialize};

use crate::ops::rgb_to_hsl;
use crate::surface::GradeSurface;

/// Hue is a circular band `hue_center ± hue_range` (degrees) with
/// `hue_soft` degrees of falloff beyond it; saturation and lightness are
/// plain `[lo, hi]` bands (`0..=1`) with their own falloff widths. A range
/// covering everything (e.g. `hue_range >= 180`, `[0, 1]` bands) passes 1
/// for that dimension, so each dimension is opt-in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HslQualifier {
    pub hue_center: f32,
    pub hue_range: f32,
    pub hue_soft: f32,
    pub sat_range: [f32; 2],
    pub sat_soft: f32,
    pub lum_range: [f32; 2],
    pub lum_soft: f32,
    #[serde(default)]
    pub invert: bool,
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// 1 inside `[lo, hi]`, smoothstep falloff over `soft` outside, 0 beyond.
fn band_weight(v: f32, lo: f32, hi: f32, soft: f32) -> f32 {
    if v >= lo && v <= hi {
        return 1.0;
    }
    if soft <= 0.0 {
        return 0.0;
    }
    let d = if v < lo { lo - v } else { v - hi };
    1.0 - smoothstep(d / soft)
}

impl HslQualifier {
    /// The gate for one encoded RGB pixel.
    pub fn weight(&self, rgb: [f32; 3]) -> f32 {
        let (h, s, l) = rgb_to_hsl([
            rgb[0].clamp(0.0, 1.0),
            rgb[1].clamp(0.0, 1.0),
            rgb[2].clamp(0.0, 1.0),
        ]);
        // Circular hue distance to the band centre.
        let d = (h - self.hue_center).rem_euclid(360.0);
        let d = d.min(360.0 - d);
        let hue_w = if d <= self.hue_range {
            1.0
        } else if self.hue_soft <= 0.0 {
            0.0
        } else {
            1.0 - smoothstep((d - self.hue_range) / self.hue_soft)
        };
        let sat_w = band_weight(s, self.sat_range[0], self.sat_range[1], self.sat_soft);
        let lum_w = band_weight(l, self.lum_range[0], self.lum_range[1], self.lum_soft);
        let w = hue_w * sat_w * lum_w;
        if self.invert {
            1.0 - w
        } else {
            w
        }
    }

    /// The per-pixel gate over a whole surface (`w * h` f32s).
    pub fn gate(&self, surface: &GradeSurface) -> Vec<f32> {
        let n = (surface.w as usize) * (surface.h as usize);
        (0..n)
            .map(|px| {
                let i = px * 4;
                self.weight([surface.data[i], surface.data[i + 1], surface.data[i + 2]])
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red_qualifier() -> HslQualifier {
        HslQualifier {
            hue_center: 0.0,
            hue_range: 20.0,
            hue_soft: 20.0,
            sat_range: [0.2, 1.0],
            sat_soft: 0.1,
            lum_range: [0.0, 1.0],
            lum_soft: 0.0,
            invert: false,
        }
    }

    #[test]
    fn selects_reds_and_rejects_greens() {
        let q = red_qualifier();
        assert_eq!(q.weight([1.0, 0.0, 0.0]), 1.0);
        assert_eq!(q.weight([0.0, 1.0, 0.0]), 0.0);
        // Grey fails the saturation band even though hue defaults to 0.
        assert_eq!(q.weight([0.5, 0.5, 0.5]), 0.0);
    }

    #[test]
    fn softness_falls_off_smoothly_and_invert_flips() {
        let q = red_qualifier();
        // Orange (~30°) sits inside the falloff: strictly between 0 and 1.
        let w = q.weight([1.0, 0.5, 0.0]);
        assert!(w > 0.0 && w < 1.0, "got {w}");
        let inv = HslQualifier { invert: true, ..q };
        assert!((inv.weight([1.0, 0.5, 0.0]) - (1.0 - w)).abs() < 1e-6);
    }

    #[test]
    fn wide_open_qualifier_passes_everything() {
        let q = HslQualifier {
            hue_center: 0.0,
            hue_range: 180.0,
            hue_soft: 0.0,
            sat_range: [0.0, 1.0],
            sat_soft: 0.0,
            lum_range: [0.0, 1.0],
            lum_soft: 0.0,
            invert: false,
        };
        for rgb in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.3, 0.7, 0.2]] {
            assert_eq!(q.weight(rgb), 1.0);
        }
    }
}
