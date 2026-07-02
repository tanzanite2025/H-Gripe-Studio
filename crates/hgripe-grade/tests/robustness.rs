// Hardening sweep: every op and blend mode is run over hostile inputs
// (HDR overshoot, negatives, zero alpha, degenerate parameters) and must
// produce only finite samples with alpha in `0..=1`. This is the kernel's
// "never NaN, never panic" contract — the golden vectors pin exact values,
// this pins graceful degradation.

use hgripe_grade::{apply_op, composite_over, BlendMode, CurveChannel, GradeOp, GradeSpace, GradeSurface, HslQualifier};

fn hostile_surface(space: GradeSpace) -> GradeSurface {
    GradeSurface {
        w: 3,
        h: 2,
        data: vec![
            -0.5, 2.0, 0.5, 1.0, // out-of-range colour
            1.0e6, -1.0e6, 0.0, 1.0, // extreme HDR
            0.0, 0.0, 0.0, 0.0, // fully transparent black
            1.0, 1.0, 1.0, 2.0, // out-of-range alpha
            0.5, 0.5, 0.5, -1.0, // negative alpha
            0.3, 0.7, 0.15, 0.5,
        ],
        space,
    }
}

fn all_ops() -> Vec<GradeOp> {
    let identity_lut: Vec<f32> = (0..8)
        .flat_map(|i| {
            [
                (i & 1) as f32,
                ((i >> 1) & 1) as f32,
                ((i >> 2) & 1) as f32,
            ]
        })
        .collect();
    vec![
        GradeOp::Exposure { ev: 20.0 },
        GradeOp::Exposure { ev: -20.0 },
        GradeOp::WhiteBalance { temp: 1.0, tint: -1.0 },
        // Degenerate levels: zero input span, inverted output, zero gamma.
        GradeOp::Levels {
            in_black: 0.5,
            in_white: 0.5,
            gamma: 0.0,
            out_black: 1.0,
            out_white: 0.0,
        },
        // Degenerate curves: empty, single point, duplicate x.
        GradeOp::Curves { channel: CurveChannel::Master, points: vec![] },
        GradeOp::Curves { channel: CurveChannel::Red, points: vec![[0.5, 0.5]] },
        GradeOp::Curves {
            channel: CurveChannel::Master,
            points: vec![[0.5, 0.2], [0.5, 0.8], [1.0, 1.0]],
        },
        GradeOp::Saturation { amount: -1.0 },
        GradeOp::Saturation { amount: 10.0 },
        // Degenerate wheels: zero gamma, negative gain.
        GradeOp::LiftGammaGain {
            lift: [1.0, -1.0, 0.5],
            gamma: [0.0, 10.0, 1.0],
            gain: [-2.0, 0.0, 5.0],
        },
        GradeOp::HslAdjust { hue: 720.0, saturation: 10.0, lightness: -10.0 },
        GradeOp::HslAdjust { hue: -450.0, saturation: -1.0, lightness: 1.0 },
        GradeOp::Lut3d { size: 2, table: identity_lut },
        // Degenerate hue curves: empty, single point, off-range hues.
        GradeOp::HueVsHue { points: vec![] },
        GradeOp::HueVsHue { points: vec![[-720.0, 180.0]] },
        GradeOp::HueVsHue { points: vec![[0.0, 360.0], [400.0, -360.0]] },
        GradeOp::HueVsSat { points: vec![] },
        GradeOp::HueVsSat { points: vec![[90.0, -5.0], [270.0, 10.0]] },
        GradeOp::LumVsSat { points: vec![] },
        GradeOp::LumVsSat { points: vec![[0.0, -10.0], [1.0, 10.0]] },
        GradeOp::SatVsSat { points: vec![[0.5, -1.0]] },
        // Degenerate zone splits: pivots at/off the ends, huge offsets.
        GradeOp::LogWheels {
            shadows: [10.0, -10.0, 0.0],
            midtones: [-10.0, 10.0, 0.0],
            highlights: [10.0, 10.0, -10.0],
            low_pivot: 0.0,
            high_pivot: 1.0,
        },
        GradeOp::LogWheels {
            shadows: [1.0, 1.0, 1.0],
            midtones: [1.0, 1.0, 1.0],
            highlights: [1.0, 1.0, 1.0],
            low_pivot: 2.0,
            high_pivot: -1.0,
        },
        GradeOp::Contrast { amount: -100.0, pivot: 10.0 },
        GradeOp::Contrast { amount: 100.0, pivot: -10.0 },
        // Degenerate soft clip: knees off-range / inverted.
        GradeOp::SoftClip { high_start: 2.0, low_start: -1.0 },
        GradeOp::SoftClip { high_start: 0.0, low_start: 1.0 },
        GradeOp::SoftClip { high_start: 0.8, low_start: 0.1 },
        // Off-range colour temperatures and tints clamp to the locus fit.
        GradeOp::WhiteBalanceK { temp_k: 0.0, tint: -100.0 },
        GradeOp::WhiteBalanceK { temp_k: 1e9, tint: 100.0 },
        GradeOp::WhiteBalanceK { temp_k: f32::NAN, tint: f32::NAN },
        // Degenerate mixer: extreme, non-finite, all-zero weights.
        GradeOp::RgbMixer {
            red: [100.0, -100.0, 0.0],
            green: [f32::NAN, f32::INFINITY, f32::NEG_INFINITY],
            blue: [0.0, 0.0, 0.0],
            monochrome: false,
        },
        GradeOp::RgbMixer {
            red: [f32::NAN, f32::NAN, f32::NAN],
            green: [0.0, 1.0, 0.0],
            blue: [0.0, 0.0, 1.0],
            monochrome: true,
        },
    ]
}

// Ops never touch alpha, so only finiteness is asserted here; the
// composite test below checks the 0..=1 alpha invariant.
fn assert_sane(name: &str, s: &GradeSurface) {
    for (i, &v) in s.data.iter().enumerate() {
        assert!(v.is_finite(), "{name}: sample {i} is {v}");
    }
}

#[test]
fn every_op_survives_hostile_inputs() {
    for space in [GradeSpace::Srgb, GradeSpace::ProPhoto, GradeSpace::LinearRec709] {
        for op in all_ops() {
            let mut s = hostile_surface(space);
            apply_op(&mut s, &op);
            assert_sane(&format!("{op:?} in {space:?}"), &s);
        }
    }
}

#[test]
fn qualifier_survives_hostile_inputs_and_stays_in_range() {
    let qualifiers = [
        // Degenerate: inverted bands, zero softness, off-range hue centre.
        HslQualifier {
            hue_center: -720.0,
            hue_range: -10.0,
            hue_soft: 0.0,
            sat_range: [1.0, 0.0],
            sat_soft: 0.0,
            lum_range: [0.5, 0.5],
            lum_soft: -1.0,
            invert: false,
        },
        HslQualifier {
            hue_center: 1e6,
            hue_range: 1e6,
            hue_soft: 1e6,
            sat_range: [-10.0, 10.0],
            sat_soft: 1e6,
            lum_range: [-10.0, 10.0],
            lum_soft: 1e6,
            invert: true,
        },
    ];
    for q in qualifiers {
        let s = hostile_surface(GradeSpace::Srgb);
        for w in q.gate(&s) {
            assert!(w.is_finite() && (0.0..=1.0).contains(&w), "gate weight {w}");
        }
    }
}

#[test]
fn every_blend_mode_survives_hostile_inputs() {
    let modes = [
        BlendMode::Normal,
        BlendMode::Multiply,
        BlendMode::Screen,
        BlendMode::Overlay,
        BlendMode::Darken,
        BlendMode::Lighten,
        BlendMode::ColorDodge,
        BlendMode::ColorBurn,
        BlendMode::HardLight,
        BlendMode::SoftLight,
        BlendMode::Difference,
        BlendMode::Exclusion,
        BlendMode::LinearDodge,
        BlendMode::LinearBurn,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
    ];
    for mode in modes {
        for space in [GradeSpace::Srgb, GradeSpace::LinearRec709] {
            let mut dst = hostile_surface(space);
            let src = hostile_surface(space);
            composite_over(&mut dst, &src, mode, 0.7, Some(&[1.0, 0.5, 0.0, 2.0, -1.0, 0.25]));
            for (i, &v) in dst.data.iter().enumerate() {
                assert!(v.is_finite(), "{mode:?} in {space:?}: sample {i} is {v}");
                if i % 4 == 3 {
                    assert!((0.0..=1.0).contains(&v), "{mode:?} in {space:?}: alpha {i} = {v}");
                }
            }
        }
    }
}
