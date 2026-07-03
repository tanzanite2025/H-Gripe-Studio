// GPU-vs-CPU tolerance validation (feature `gpu`). The CPU path is the
// reference implementation; the GPU backend replays the same GradeDoc via
// generated WGSL compute passes and must match within f32 tolerance —
// per-op transcendental differences and the baked-curve-LUT approximation
// are expected, bit-identity is not (that constraint binds the CPU
// parallel path only; see docs/design/grade-kernel.md).
//
// Every test skips (with a note) when no GPU adapter is available, so the
// suite stays green on headless CI while still exercising the full backend
// wherever a GPU (or a software rasteriser like WARP/lavapipe) exists.
#![cfg(feature = "gpu")]

use std::sync::{Mutex, MutexGuard};

use hgripe_grade::{
    apply, BlendMode, GpuError, GpuGrader, GradeDoc, GradeLayer, GradeOp, GradeSpace, GradeSurface,
    HslQualifier,
};

// GPU work is serialised across tests: some adapters (WARP, notably)
// crash under several concurrent devices, so each test creates its grader
// and runs its whole GPU session while holding this lock.
static GPU_LOCK: Mutex<()> = Mutex::new(());

struct GpuSession {
    grader: GpuGrader,
    _guard: MutexGuard<'static, ()>,
}

fn grader() -> Option<GpuSession> {
    let guard = GPU_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match GpuGrader::new() {
        Ok(grader) => Some(GpuSession {
            grader,
            _guard: guard,
        }),
        Err(GpuError::NoAdapter) => {
            eprintln!("skipping GPU test: no adapter available");
            None
        }
        Err(e) => panic!("GPU device creation failed: {e}"),
    }
}

fn gradient(w: u32, h: u32, space: GradeSpace) -> GradeSurface {
    let n = (w * h) as usize;
    let mut data = Vec::with_capacity(n * 4);
    for px in 0..n {
        let t = px as f32 / n as f32;
        data.extend([
            t,
            (t * 5.0).fract(),
            1.0 - t,
            0.25 + 0.75 * (t * 3.0).fract(),
        ]);
    }
    GradeSurface { w, h, data, space }
}

fn layer(ops: Vec<GradeOp>) -> GradeLayer {
    GradeLayer {
        blend: BlendMode::Normal,
        opacity: 1.0,
        visible: true,
        mask: None,
        qualifier: None,
        ops,
    }
}

// Run `doc` on both paths and assert the outputs agree within `tol`.
fn check(g: &mut GpuGrader, doc: &GradeDoc, surface: &GradeSurface, tol: f32, what: &str) {
    let mut cpu = surface.clone();
    apply(doc, &mut cpu);
    let mut gpu = surface.clone();
    g.apply(doc, &mut gpu).expect("GPU apply");
    let mut worst = 0.0f32;
    for (i, (a, b)) in cpu.data.iter().zip(&gpu.data).enumerate() {
        let d = (a - b).abs();
        if d > worst {
            worst = d;
        }
        assert!(
            d <= tol,
            "{what}: index {i} cpu={a} gpu={b} |d|={d} > tol={tol}"
        );
    }
    eprintln!("{what}: max |cpu - gpu| = {worst:e}");
}

#[test]
fn per_pixel_ops_match_cpu() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(64, 48, GradeSpace::Srgb);
    let cases: Vec<(&str, GradeOp, f32)> = vec![
        ("exposure", GradeOp::Exposure { ev: 0.7 }, 1e-4),
        (
            "white_balance",
            GradeOp::WhiteBalance {
                temp: 0.3,
                tint: -0.2,
            },
            1e-4,
        ),
        (
            "levels",
            GradeOp::Levels {
                in_black: 0.05,
                in_white: 0.9,
                gamma: 1.4,
                out_black: 0.02,
                out_white: 0.98,
            },
            1e-4,
        ),
        ("saturation", GradeOp::Saturation { amount: 0.5 }, 1e-4),
        (
            "lift_gamma_gain",
            GradeOp::LiftGammaGain {
                lift: [0.02, -0.01, 0.03],
                gamma: [1.1, 0.9, 1.0],
                gain: [1.05, 1.0, 0.95],
            },
            1e-4,
        ),
        (
            "hsl_adjust",
            GradeOp::HslAdjust {
                hue: 25.0,
                saturation: 0.2,
                lightness: -0.1,
            },
            2e-4,
        ),
        (
            "log_wheels",
            GradeOp::LogWheels {
                shadows: [0.05, -0.02, 0.0],
                midtones: [-0.03, 0.04, 0.01],
                highlights: [0.02, 0.0, -0.05],
                low_pivot: 0.33,
                high_pivot: 0.67,
            },
            1e-4,
        ),
        (
            "contrast",
            GradeOp::Contrast {
                amount: 1.3,
                pivot: 0.45,
            },
            1e-4,
        ),
        (
            "soft_clip",
            GradeOp::SoftClip {
                high_start: 0.8,
                low_start: 0.1,
            },
            1e-4,
        ),
        (
            "white_balance_k",
            GradeOp::WhiteBalanceK {
                temp_k: 5200.0,
                tint: 0.1,
            },
            1e-4,
        ),
        (
            "rgb_mixer",
            GradeOp::RgbMixer {
                red: [0.9, 0.1, 0.0],
                green: [0.05, 0.9, 0.05],
                blue: [0.0, 0.2, 0.8],
                monochrome: false,
            },
            1e-4,
        ),
    ];
    for (name, op, tol) in cases {
        let doc = GradeDoc {
            layers: vec![layer(vec![op])],
        };
        check(&mut g.grader, &doc, &surface, tol, name);
    }
}

#[test]
fn curve_ops_match_cpu_within_lut_tolerance() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(64, 48, GradeSpace::Srgb);
    // The GPU bakes every spline to a 1024-sample LUT, so allow the
    // preview-grade approximation error on top of f32 noise.
    let cases: Vec<(&str, GradeOp, f32)> = vec![
        (
            "curves_master",
            GradeOp::Curves {
                channel: hgripe_grade::CurveChannel::Master,
                points: vec![[0.0, 0.05], [0.4, 0.3], [0.7, 0.85], [1.0, 0.95]],
            },
            2e-3,
        ),
        (
            "curves_red",
            GradeOp::Curves {
                channel: hgripe_grade::CurveChannel::Red,
                points: vec![[0.0, 0.0], [0.5, 0.6], [1.0, 1.0]],
            },
            2e-3,
        ),
        (
            "hue_vs_hue",
            GradeOp::HueVsHue {
                points: vec![[0.0, 15.0], [120.0, -20.0], [240.0, 5.0]],
            },
            5e-3,
        ),
        (
            "hue_vs_sat",
            GradeOp::HueVsSat {
                points: vec![[0.0, 1.3], [180.0, 0.6]],
            },
            5e-3,
        ),
        (
            "lum_vs_sat",
            GradeOp::LumVsSat {
                points: vec![[0.0, 0.5], [0.5, 1.2], [1.0, 0.8]],
            },
            2e-3,
        ),
        (
            "sat_vs_sat",
            GradeOp::SatVsSat {
                points: vec![[0.0, 1.0], [0.5, 1.4], [1.0, 0.9]],
            },
            2e-3,
        ),
        (
            "color_warper",
            GradeOp::ColorWarper {
                points: vec![hgripe_grade::WarpPoint {
                    hue: 30.0,
                    sat: 0.6,
                    hue_shift: 20.0,
                    sat_scale: 1.3,
                    hue_radius: 60.0,
                    sat_radius: 0.4,
                }],
            },
            2e-3,
        ),
    ];
    for (name, op, tol) in cases {
        let doc = GradeDoc {
            layers: vec![layer(vec![op])],
        };
        check(&mut g.grader, &doc, &surface, tol, name);
    }
}

#[test]
fn lut_ops_match_cpu() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(48, 32, GradeSpace::Srgb);
    // A warm-ish 1D LUT.
    let size1 = 17u32;
    let table1: Vec<f32> = (0..size1)
        .flat_map(|i| {
            let t = i as f32 / (size1 - 1) as f32;
            [t.powf(0.9), t, t.powf(1.1)]
        })
        .collect();
    // A gentle 3D LUT (identity plus a channel-coupled tint).
    let size3 = 9u32;
    let mut table3 = Vec::with_capacity((size3 as usize).pow(3) * 3);
    for b in 0..size3 {
        for gch in 0..size3 {
            for r in 0..size3 {
                let n = (size3 - 1) as f32;
                let (rf, gf, bf) = (r as f32 / n, gch as f32 / n, b as f32 / n);
                table3.extend([
                    (rf * 0.95 + gf * 0.05).clamp(0.0, 1.0),
                    gf,
                    (bf * 0.9 + rf * 0.1).clamp(0.0, 1.0),
                ]);
            }
        }
    }
    for (name, op, tol) in [
        (
            "lut1d",
            GradeOp::Lut1d {
                size: size1,
                table: table1,
            },
            1e-4f32,
        ),
        (
            "lut3d",
            GradeOp::Lut3d {
                size: size3,
                table: table3,
            },
            1e-4,
        ),
    ] {
        let doc = GradeDoc {
            layers: vec![layer(vec![op])],
        };
        check(&mut g.grader, &doc, &surface, tol, name);
    }
}

#[test]
fn spatial_ops_match_cpu() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(40, 30, GradeSpace::Srgb);
    for (name, op, tol) in [
        ("sharpen", GradeOp::Sharpen { amount: 1.5 }, 1e-4f32),
        ("denoise", GradeOp::Denoise { amount: 0.8 }, 1e-4),
        (
            "film_grain",
            GradeOp::FilmGrain {
                amount: 0.3,
                seed: 42,
            },
            1e-4,
        ),
    ] {
        let doc = GradeDoc {
            layers: vec![layer(vec![op])],
        };
        check(&mut g.grader, &doc, &surface, tol, name);
    }
}

#[test]
fn blend_modes_and_gates_match_cpu() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(32, 24, GradeSpace::Srgb);
    let n = (surface.w * surface.h) as usize;
    let mask: Vec<f32> = (0..n)
        .map(|px| (px as f32 / n as f32) * 1.2 - 0.1)
        .collect();
    for blend in [
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
    ] {
        let doc = GradeDoc {
            layers: vec![GradeLayer {
                blend,
                opacity: 0.75,
                visible: true,
                mask: Some(mask.clone()),
                qualifier: None,
                ops: vec![GradeOp::Exposure { ev: 1.2 }],
            }],
        };
        check(
            &mut g.grader,
            &doc,
            &surface,
            1e-4,
            &format!("blend {blend:?}"),
        );
    }
}

#[test]
fn qualifier_gated_layer_matches_cpu() {
    let Some(mut g) = grader() else { return };
    let surface = gradient(32, 24, GradeSpace::Srgb);
    let doc = GradeDoc {
        layers: vec![GradeLayer {
            blend: BlendMode::Normal,
            opacity: 1.0,
            visible: true,
            mask: None,
            qualifier: Some(HslQualifier {
                hue_center: 20.0,
                hue_range: 30.0,
                hue_soft: 25.0,
                sat_range: [0.2, 0.9],
                sat_soft: 0.15,
                lum_range: [0.1, 0.95],
                lum_soft: 0.1,
                invert: false,
            }),
            ops: vec![GradeOp::Saturation { amount: -0.6 }],
        }],
    };
    check(&mut g.grader, &doc, &surface, 2e-4, "qualifier gate");
}

#[test]
fn multi_layer_docs_match_cpu_in_every_space() {
    let Some(mut g) = grader() else { return };
    for space in [
        GradeSpace::Srgb,
        GradeSpace::LinearRec709,
        GradeSpace::ProPhoto,
    ] {
        let surface = gradient(48, 36, space);
        let n = (surface.w * surface.h) as usize;
        let mask: Vec<f32> = (0..n).map(|px| ((px % 7) as f32) / 6.0).collect();
        let doc = GradeDoc {
            layers: vec![
                layer(vec![
                    GradeOp::Exposure { ev: 0.4 },
                    GradeOp::Contrast {
                        amount: 1.15,
                        pivot: 0.5,
                    },
                    GradeOp::Sharpen { amount: 0.8 },
                    GradeOp::Saturation { amount: 0.2 },
                ]),
                GradeLayer {
                    blend: BlendMode::SoftLight,
                    opacity: 0.6,
                    visible: true,
                    mask: Some(mask),
                    qualifier: None,
                    ops: vec![
                        GradeOp::LogWheels {
                            shadows: [0.03, 0.0, -0.02],
                            midtones: [0.0, 0.02, 0.0],
                            highlights: [-0.01, 0.0, 0.03],
                            low_pivot: 0.33,
                            high_pivot: 0.67,
                        },
                        GradeOp::FilmGrain {
                            amount: 0.15,
                            seed: 7,
                        },
                    ],
                },
                GradeLayer {
                    blend: BlendMode::Normal,
                    opacity: 1.0,
                    visible: false, // hidden layers must be skipped
                    mask: None,
                    qualifier: None,
                    ops: vec![GradeOp::Exposure { ev: 5.0 }],
                },
            ],
        };
        check(
            &mut g.grader,
            &doc,
            &surface,
            2e-4,
            &format!("multi-layer {space:?}"),
        );
    }
}
