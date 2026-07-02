// The kernel's working surface: f32 RGBA, straight alpha, gamma-encoded
// values in the tagged space. Ingress/egress is plain 16-bit RGBA — the app
// side owns `WorkingImage` and ICC; the kernel never sees a profile.

use serde::{Deserialize, Serialize};

/// The colour space a surface's samples are encoded in (TRC + primaries tag).
/// Mirrors the app's `WorkingSpace`; carried so per-op linear-light decode
/// (G2+) picks the right transfer curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GradeSpace {
    Srgb,
    ProPhoto,
}

/// An f32 RGBA working surface: interleaved `[R, G, B, A]`, row-major,
/// straight (un-premultiplied) alpha, nominally `0.0..=1.0` (HDR headroom
/// above 1.0 is allowed mid-chain and clamped at egress).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradeSurface {
    pub w: u32,
    pub h: u32,
    /// Interleaved RGBA, length `w * h * 4`.
    pub data: Vec<f32>,
    pub space: GradeSpace,
}

impl GradeSurface {
    /// Ingress: widen 16-bit RGBA samples to f32 `0..1` (`v / 65535`).
    pub fn from_rgba16(w: u32, h: u32, pixels: &[u16], space: GradeSpace) -> Self {
        assert_eq!(pixels.len(), (w as usize) * (h as usize) * 4, "rgba16 length");
        let data = pixels.iter().map(|&v| f32::from(v) / 65535.0).collect();
        Self { w, h, data, space }
    }

    /// Egress: quantise back to 16-bit RGBA. This is the kernel's *only*
    /// quantisation point; values are clamped to `0..1` here and nowhere
    /// earlier. Round-trips `from_rgba16` exactly.
    pub fn to_rgba16(&self) -> Vec<u16> {
        self.data
            .iter()
            .map(|&v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba16_round_trip_is_exact_for_every_sample_value() {
        // Every representable u16 must survive u16 → f32 → u16 unchanged.
        let pixels: Vec<u16> = (0..=65535).collect();
        let w = 128;
        let h = 128; // 128 * 128 * 4 = 65536
        let s = GradeSurface::from_rgba16(w, h, &pixels, GradeSpace::Srgb);
        assert_eq!(s.to_rgba16(), pixels);
    }

    #[test]
    fn egress_clamps_hdr_headroom() {
        let mut s = GradeSurface::from_rgba16(1, 1, &[0, 0, 0, 0], GradeSpace::ProPhoto);
        s.data = vec![1.5, -0.25, 1.0, 0.5];
        assert_eq!(s.to_rgba16(), vec![65535, 0, 65535, 32768]);
    }
}
