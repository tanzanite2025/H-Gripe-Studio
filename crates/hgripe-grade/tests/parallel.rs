// The design doc's determinism rule: an optional parallel path must produce
// bit-identical results to the reference path or it does not ship. This
// compares `apply_parallel` against `apply` bit-for-bit over a surface and
// document that exercise every kind of op, blend family, mask and odd band
// splits (height not divisible by the thread count).

#![cfg(feature = "parallel")]

use hgripe_grade::{apply, apply_parallel, BlendMode, CurveChannel, GradeDoc, GradeLayer, GradeOp, GradeSpace, GradeSurface};

fn test_surface(w: u32, h: u32) -> GradeSurface {
    let n = (w as usize) * (h as usize);
    let mut data = Vec::with_capacity(n * 4);
    for px in 0..n {
        let t = px as f32 / n as f32;
        data.extend([t, (t * 7.3).fract(), 1.0 - t, (t * 3.1).fract()]);
    }
    GradeSurface { w, h, data, space: GradeSpace::Srgb }
}

fn test_doc(n_px: usize) -> GradeDoc {
    let mask: Vec<f32> = (0..n_px).map(|px| ((px as f32) * 0.37).fract()).collect();
    let identity_lut: Vec<f32> = (0..8)
        .flat_map(|i| [(i & 1) as f32, ((i >> 1) & 1) as f32, ((i >> 2) & 1) as f32])
        .collect();
    GradeDoc {
        layers: vec![
            GradeLayer {
                blend: BlendMode::Normal,
                opacity: 1.0,
                visible: true,
                mask: None,
                ops: vec![
                    GradeOp::Exposure { ev: 0.5 },
                    GradeOp::Curves {
                        channel: CurveChannel::Master,
                        points: vec![[0.0, 0.05], [0.5, 0.6], [1.0, 0.95]],
                    },
                ],
            },
            GradeLayer {
                blend: BlendMode::SoftLight,
                opacity: 0.8,
                visible: true,
                mask: Some(mask),
                ops: vec![
                    GradeOp::LiftGammaGain {
                        lift: [0.05, 0.0, -0.05],
                        gamma: [1.1, 1.0, 0.9],
                        gain: [1.05, 1.0, 0.95],
                    },
                    GradeOp::HslAdjust { hue: 30.0, saturation: 0.2, lightness: -0.1 },
                ],
            },
            GradeLayer {
                blend: BlendMode::Color,
                opacity: 0.6,
                visible: true,
                mask: None,
                ops: vec![GradeOp::Lut3d { size: 2, table: identity_lut }, GradeOp::Saturation { amount: 0.4 }],
            },
        ],
    }
}

#[test]
fn parallel_apply_is_bit_identical_to_serial() {
    // Odd sizes so bands don't divide evenly, plus a single-row surface.
    for (w, h) in [(31, 17), (64, 1), (7, 64)] {
        let doc = test_doc((w as usize) * (h as usize));
        let mut serial = test_surface(w, h);
        let mut parallel = serial.clone();
        apply(&doc, &mut serial);
        apply_parallel(&doc, &mut parallel);
        for (i, (a, b)) in serial.data.iter().zip(&parallel.data).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "sample {i} at {w}x{h}");
        }
    }
}
