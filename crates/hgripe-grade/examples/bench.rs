// Manual benchmark: `cargo run --release --example bench -p hgripe-grade`
// (add `--features parallel` to also time the rayon path). Times a
// representative 3-layer grade over a 1920x1080 surface — the kernel's
// per-frame hot path — and reports ms/frame per layer stack and per op.

use std::time::Instant;

use hgripe_grade::{
    apply, BlendMode, CurveChannel, GradeDoc, GradeLayer, GradeOp, GradeSpace, GradeSurface,
};

fn hd_surface() -> GradeSurface {
    let (w, h) = (1920u32, 1080u32);
    let n = (w as usize) * (h as usize);
    let mut data = Vec::with_capacity(n * 4);
    for px in 0..n {
        let t = px as f32 / n as f32;
        data.extend([t, (t * 7.3).fract(), 1.0 - t, 1.0]);
    }
    GradeSurface {
        w,
        h,
        data,
        space: GradeSpace::Srgb,
    }
}

fn grade_doc(n_px: usize) -> GradeDoc {
    let mask: Vec<f32> = (0..n_px).map(|px| ((px as f32) * 0.37).fract()).collect();
    GradeDoc {
        layers: vec![
            GradeLayer {
                blend: BlendMode::Normal,
                opacity: 1.0,
                visible: true,
                mask: None,
                qualifier: None,
                ops: vec![
                    GradeOp::Exposure { ev: 0.5 },
                    GradeOp::WhiteBalance {
                        temp: 0.1,
                        tint: -0.05,
                    },
                ],
            },
            GradeLayer {
                blend: BlendMode::SoftLight,
                opacity: 0.8,
                visible: true,
                mask: Some(mask),
                qualifier: None,
                ops: vec![GradeOp::LiftGammaGain {
                    lift: [0.05, 0.0, -0.05],
                    gamma: [1.1, 1.0, 0.9],
                    gain: [1.05, 1.0, 0.95],
                }],
            },
            GradeLayer {
                blend: BlendMode::Color,
                opacity: 0.6,
                visible: true,
                mask: None,
                qualifier: None,
                ops: vec![GradeOp::Saturation { amount: 0.3 }],
            },
        ],
    }
}

fn time<F: FnMut()>(name: &str, iters: u32, mut f: F) {
    // Warm-up once, then average.
    f();
    let start = Instant::now();
    for _ in 0..iters {
        f();
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / iters as f64;
    println!("{name:<40} {ms:8.2} ms/frame");
}

fn main() {
    let input = hd_surface();
    let doc = grade_doc((input.w as usize) * (input.h as usize));

    time("apply (serial, 3 layers, 1080p)", 5, || {
        let mut s = input.clone();
        apply(&doc, &mut s);
        std::hint::black_box(&s);
    });

    #[cfg(feature = "parallel")]
    time("apply_parallel (rayon, 3 layers, 1080p)", 5, || {
        let mut s = input.clone();
        hgripe_grade::apply_parallel(&doc, &mut s);
        std::hint::black_box(&s);
    });

    // The GPU path (`--features gpu`): the first apply pays codegen +
    // shader compilation; the timed loop replays the cached plan, which is
    // the per-frame cost for preview / video rendering.
    #[cfg(feature = "gpu")]
    match hgripe_grade::GpuGrader::new() {
        Ok(mut grader) => {
            time("gpu apply (wgpu, 3 layers, 1080p)", 5, || {
                let mut s = input.clone();
                grader.apply(&doc, &mut s).expect("GPU apply");
                std::hint::black_box(&s);
            });
        }
        Err(e) => println!("gpu apply skipped: {e}"),
    }

    // Per-op timings on a single normal layer.
    let single_ops: Vec<(&str, GradeOp)> = vec![
        ("exposure", GradeOp::Exposure { ev: 0.5 }),
        (
            "white_balance",
            GradeOp::WhiteBalance {
                temp: 0.1,
                tint: -0.05,
            },
        ),
        (
            "levels",
            GradeOp::Levels {
                in_black: 0.05,
                in_white: 0.95,
                gamma: 1.2,
                out_black: 0.0,
                out_white: 1.0,
            },
        ),
        (
            "curves",
            GradeOp::Curves {
                channel: CurveChannel::Master,
                points: vec![[0.0, 0.05], [0.5, 0.6], [1.0, 0.95]],
            },
        ),
        ("saturation", GradeOp::Saturation { amount: 0.3 }),
        (
            "lift_gamma_gain",
            GradeOp::LiftGammaGain {
                lift: [0.05, 0.0, -0.05],
                gamma: [1.1, 1.0, 0.9],
                gain: [1.05, 1.0, 0.95],
            },
        ),
        (
            "hsl_adjust",
            GradeOp::HslAdjust {
                hue: 30.0,
                saturation: 0.2,
                lightness: -0.1,
            },
        ),
    ];
    for (name, op) in single_ops {
        let mut s = input.clone();
        time(&format!("op: {name}"), 3, || {
            hgripe_grade::apply_op(&mut s, &op);
        });
    }
}
