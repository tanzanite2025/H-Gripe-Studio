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
    HslQualifier, TextureGrader,
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
        (
            "color_ranges",
            GradeOp::ColorRanges {
                ranges: vec![
                    hgripe_grade::RangeAdjust {
                        range: hgripe_grade::ColorRange::Reds,
                        hue: 20.0,
                        saturation: 0.3,
                        lightness: 0.05,
                    },
                    hgripe_grade::RangeAdjust {
                        range: hgripe_grade::ColorRange::Blues,
                        hue: -15.0,
                        saturation: -0.4,
                        lightness: 0.0,
                    },
                    hgripe_grade::RangeAdjust {
                        range: hgripe_grade::ColorRange::Neutrals,
                        hue: 0.0,
                        saturation: 0.2,
                        lightness: -0.05,
                    },
                ],
                monochrome: false,
            },
            2e-3,
        ),
        (
            "color_ranges_monochrome",
            GradeOp::ColorRanges {
                ranges: vec![hgripe_grade::RangeAdjust {
                    range: hgripe_grade::ColorRange::Greens,
                    hue: 0.0,
                    saturation: 0.0,
                    lightness: -0.2,
                }],
                monochrome: true,
            },
            2e-3,
        ),
        (
            "replace_color",
            GradeOp::ReplaceColor {
                from: [1.0, 0.75, 0.2],
                to: [0.2, 0.4, 1.0],
                fuzziness: 0.4,
                amount: 1.0,
            },
            2e-3,
        ),
        (
            "replace_color_partial",
            GradeOp::ReplaceColor {
                from: [0.5, 0.5, 0.5],
                to: [0.9, 0.1, 0.1],
                fuzziness: 0.2,
                amount: 0.5,
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
        (
            "sharpen",
            GradeOp::Sharpen {
                amount: 1.5,
                radius: 1,
            },
            1e-4f32,
        ),
        (
            "sharpen r2",
            GradeOp::Sharpen {
                amount: 1.5,
                radius: 2,
            },
            1e-4,
        ),
        (
            "sharpen r3",
            GradeOp::Sharpen {
                amount: 1.5,
                radius: 3,
            },
            1e-4,
        ),
        (
            "denoise",
            GradeOp::Denoise {
                amount: 0.8,
                radius: 1,
            },
            1e-4,
        ),
        (
            "denoise r2",
            GradeOp::Denoise {
                amount: 0.8,
                radius: 2,
            },
            1e-4,
        ),
        (
            "denoise r3",
            GradeOp::Denoise {
                amount: 0.8,
                radius: 3,
            },
            1e-4,
        ),
        (
            "film_grain",
            GradeOp::FilmGrain {
                amount: 0.3,
                seed: 42,
            },
            1e-4,
        ),
        // Blur accumulates many taps, so allow a little extra f32 noise.
        ("blur s0.8", GradeOp::Blur { sigma: 0.8 }, 2e-4),
        ("blur s2.5", GradeOp::Blur { sigma: 2.5 }, 2e-4),
        ("blur s8", GradeOp::Blur { sigma: 8.0 }, 5e-4),
        (
            "vignette",
            GradeOp::Vignette {
                amount: -0.7,
                midpoint: 0.4,
                feather: 0.5,
            },
            1e-4,
        ),
        (
            "vignette brighten",
            GradeOp::Vignette {
                amount: 0.5,
                midpoint: 0.3,
                feather: 0.2,
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

// The texture route (video zero-copy: ingress -> kernel -> egress) must
// match the CPU reference within 8-bit quantisation: both ends start from
// the same rgba8 pixels, so the only extra error is the kernel tolerance
// plus the egress round to rgba8unorm.
#[test]
fn texture_grader_matches_cpu_within_8bit() {
    let _guard = GPU_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    })) else {
        eprintln!("skipping GPU test: no adapter available");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("texture-grader-test"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .expect("device");

    // 64 px wide keeps rows COPY_BYTES_PER_ROW_ALIGNMENT-aligned for the
    // test's readback copy.
    let (w, h) = (64u32, 36u32);
    // Quantise the gradient to rgba8 so both paths start from identical
    // pixels (the texture upload is 8-bit).
    let bytes: Vec<u8> = gradient(w, h, GradeSpace::Srgb)
        .data
        .iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    let surface = GradeSurface {
        w,
        h,
        data: bytes.iter().map(|&b| f32::from(b) / 255.0).collect(),
        space: GradeSpace::Srgb,
    };

    let size = wgpu::Extent3d {
        width: w,
        height: h,
        depth_or_array_layers: 1,
    };
    let src = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("src"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &src,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        size,
    );
    let dst = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dst"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let doc = GradeDoc {
        layers: vec![layer(vec![
            GradeOp::Exposure { ev: 0.4 },
            GradeOp::Contrast {
                amount: 1.15,
                pivot: 0.5,
            },
            GradeOp::Saturation { amount: 0.2 },
        ])],
    };
    let mut grader = TextureGrader::new();
    grader
        .apply_texture(
            &device,
            &queue,
            &doc,
            &src.create_view(&wgpu::TextureViewDescriptor::default()),
            &dst.create_view(&wgpu::TextureViewDescriptor::default()),
            w,
            h,
            GradeSpace::Srgb,
        )
        .expect("apply_texture");

    // Read the graded texture back (test-only; the production path never
    // does this) and compare against the CPU reference.
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(w * h * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &dst,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
        },
        size,
    );
    queue.submit(Some(encoder.finish()));
    readback.map_async(wgpu::MapMode::Read, .., |r| r.expect("map"));
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll");
    let gpu_bytes: Vec<u8> = readback.get_mapped_range(..).to_vec();

    let mut cpu = surface.clone();
    apply(&doc, &mut cpu);
    let mut worst = 0u8;
    for (i, (&g, c)) in gpu_bytes.iter().zip(&cpu.data).enumerate() {
        let expect = (c.clamp(0.0, 1.0) * 255.0).round() as i32;
        let d = (i32::from(g) - expect).unsigned_abs() as u8;
        if d > worst {
            worst = d;
        }
        assert!(d <= 2, "index {i}: gpu={g} cpu={expect} |d|={d} > 2");
    }
    eprintln!("texture grade: max |cpu - gpu| = {worst} / 255");
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
                    GradeOp::Sharpen {
                        amount: 0.8,
                        radius: 2,
                    },
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
