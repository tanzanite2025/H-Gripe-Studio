// WGSL codegen: compile a `GradeDoc` into a compute-shader module plus a
// pass schedule (`GpuPlan`). One shader module is generated per
// (doc, surface shape) with every parameter baked in as a constant — a doc
// edit recompiles (milliseconds), but replaying the same doc over many
// frames (the video path) reuses the compiled plan via the runner's cache.
//
// The maths mirrors the CPU reference path op for op. Two deliberate
// approximations keep the shader simple: every spline-backed curve
// (curves, hue-vs-*, lum/sat-vs-sat) is baked to a `CURVE_RES`-sample LUT
// sampled linearly, and f32 transcendentals (pow/exp) may differ from the
// CPU libm in the last ulps. The GPU path is therefore preview-grade —
// validated against the CPU path with tolerances in `tests/gpu.rs`, not
// bit-identical (the design doc's bit-identical constraint binds CPU
// parallelism; the GPU backend is a separate, tolerance-tested backend).

use crate::blend::BlendMode;
use crate::doc::{GradeDoc, GradeLayer};
use crate::ops::{planckian_gains, CurveChannel, GradeOp, MonotoneSpline};
use crate::qualifier::HslQualifier;
use crate::surface::GradeSpace;

/// Samples per baked curve LUT.
const CURVE_RES: usize = 1024;

/// The compiled form of a doc: WGSL source, the pass schedule, and the
/// f32 table blob (masks, baked curve LUTs, 1D/3D LUT tables) bound as a
/// read-only storage buffer.
pub(super) struct GpuPlan {
    pub shader: String,
    pub steps: Vec<Step>,
    pub tables: Vec<f32>,
}

/// One step of the schedule, executed in order by the runner.
pub(super) enum Step {
    /// Copy the accumulated result into `work_a` (a fresh graded copy for
    /// the next layer), via a plain buffer-to-buffer copy.
    CopyStateToWorkA,
    /// Dispatch the named compute entry point over all pixels.
    Dispatch(String),
}

// Which buffer currently holds the layer's graded pixels.
#[derive(Clone, Copy, PartialEq)]
enum Work {
    A,
    B,
}

impl Work {
    fn name(self) -> &'static str {
        match self {
            Work::A => "work_a",
            Work::B => "work_b",
        }
    }
    fn other(self) -> Work {
        match self {
            Work::A => Work::B,
            Work::B => Work::A,
        }
    }
}

/// Build the shader + schedule for `doc` over a `w`×`h` surface in `space`.
pub(super) fn build_plan(doc: &GradeDoc, w: u32, h: u32, space: GradeSpace) -> GpuPlan {
    let mut b = Builder::new(w, h, space);
    for layer in &doc.layers {
        if !layer.visible {
            continue;
        }
        b.layer(layer);
    }
    GpuPlan {
        shader: b.finish(),
        steps: b.steps,
        tables: b.tables,
    }
}

struct Builder {
    space: GradeSpace,
    header: String,
    entries: String,
    steps: Vec<Step>,
    tables: Vec<f32>,
    n: usize,
    next_entry: usize,
}

impl Builder {
    fn new(w: u32, h: u32, space: GradeSpace) -> Self {
        let n = (w as usize) * (h as usize);
        let header = format!(
            "@group(0) @binding(0) var<storage, read_write> state: array<f32>;\n\
             @group(0) @binding(1) var<storage, read_write> work_a: array<f32>;\n\
             @group(0) @binding(2) var<storage, read_write> work_b: array<f32>;\n\
             @group(0) @binding(3) var<storage, read> tables: array<f32>;\n\
             const W: u32 = {w}u;\nconst H: u32 = {h}u;\nconst N: u32 = {n}u;\n{helpers}",
            helpers = helpers(space),
        );
        Self {
            space,
            header,
            entries: String::new(),
            steps: Vec::new(),
            tables: Vec::new(),
            n,
            next_entry: 0,
        }
    }

    fn finish(&self) -> String {
        format!("{}{}", self.header, self.entries)
    }

    fn entry_name(&mut self) -> String {
        let name = format!("pass_{}", self.next_entry);
        self.next_entry += 1;
        name
    }

    // Append `values` to the table blob, returning its f32 offset.
    fn push_table(&mut self, values: &[f32]) -> usize {
        let off = self.tables.len();
        self.tables.extend_from_slice(values);
        off
    }

    fn layer(&mut self, layer: &GradeLayer) {
        self.steps.push(Step::CopyStateToWorkA);
        let mut cur = Work::A;
        // Fuse consecutive per-pixel ops into one pass; spatial ops get
        // their own src→dst pass (they read neighbours, so they cannot
        // run in place).
        let mut run: Vec<String> = Vec::new();
        for op in &layer.ops {
            if op.is_spatial() {
                if !run.is_empty() {
                    self.per_pixel_pass(cur, &run);
                    run.clear();
                }
                self.spatial_pass(cur, op);
                cur = cur.other();
            } else {
                run.push(self.op_body(op));
            }
        }
        if !run.is_empty() {
            self.per_pixel_pass(cur, &run);
        }
        self.composite_pass(cur, layer);
    }

    // One fused per-pixel pass over `buf`, in place.
    fn per_pixel_pass(&mut self, buf: Work, bodies: &[String]) {
        let name = self.entry_name();
        let buf = buf.name();
        let body = bodies.join("\n");
        self.entries.push_str(&format!(
            "\n@compute @workgroup_size(256)\n\
             fn {name}(@builtin(global_invocation_id) gid: vec3<u32>) {{\n\
             let px = gid.x;\n\
             if (px >= N) {{ return; }}\n\
             let i = px * 4u;\n\
             var rgb = vec3f({buf}[i], {buf}[i + 1u], {buf}[i + 2u]);\n\
             {body}\n\
             {buf}[i] = rgb.x;\n{buf}[i + 1u] = rgb.y;\n{buf}[i + 2u] = rgb.z;\n}}\n"
        ));
        self.steps.push(Step::Dispatch(name));
    }

    // One spatial pass reading `src` (clamped, edge-clamped 3×3 taps where
    // needed) and writing the other work buffer.
    fn spatial_pass(&mut self, src: Work, op: &GradeOp) {
        let name = self.entry_name();
        let dst = src.other().name();
        let src = src.name();
        let body = match op {
            GradeOp::Sharpen { amount } => {
                let a = finite_or(*amount, 0.0).clamp(0.0, 10.0);
                // The 3×3 taps are unrolled: some HLSL compilers (FXC,
                // notably on the WARP software adapter) miscompile the
                // nested-loop form, and nine straight-line taps are faster
                // anyway.
                let taps: String = taps_3x3()
                    .map(|(k, dx, dy)| {
                        format!(
                            "let t{k} = tap(x, y, {dx}, {dy});\n\
                             sum += vec3f(clamp01({src}[t{k}]), clamp01({src}[t{k} + 1u]), clamp01({src}[t{k} + 2u]));\n"
                        )
                    })
                    .concat();
                format!(
                    "var sum = vec3f(0.0);\n\
                     {taps}\
                     let v = vec3f(clamp01({src}[i]), clamp01({src}[i + 1u]), clamp01({src}[i + 2u]));\n\
                     let outv = clamp(v + {a} * (v - sum / 9.0), vec3f(0.0), vec3f(1.0));",
                    a = lit(a),
                )
            }
            GradeOp::Denoise { amount } => {
                let a = finite_or(*amount, 0.0).clamp(0.0, 1.0);
                // Unrolled like sharpen; the binomial spatial weight is
                // (2 − |dx|) × (2 − |dy|), baked per tap.
                let taps: String = taps_3x3()
                    .map(|(k, dx, dy)| {
                        let spatial = ((2 - dx.abs()) * (2 - dy.abs())) as f32;
                        format!(
                            "let t{k} = tap(x, y, {dx}, {dy});\n\
                             let u{k} = vec3f(clamp01({src}[t{k}]), clamp01({src}[t{k} + 1u]), clamp01({src}[t{k} + 2u]));\n\
                             let d{k} = (u{k} - v) / 0.1;\n\
                             let wgt{k} = {spatial} * exp(-d{k} * d{k});\n\
                             sum += wgt{k} * u{k};\nweight += wgt{k};\n",
                            spatial = lit(spatial),
                        )
                    })
                    .concat();
                format!(
                    "let v = vec3f(clamp01({src}[i]), clamp01({src}[i + 1u]), clamp01({src}[i + 2u]));\n\
                     var sum = vec3f(0.0);\n\
                     var weight = vec3f(0.0);\n\
                     {taps}\
                     let outv = clamp(v + {a} * (sum / weight - v), vec3f(0.0), vec3f(1.0));",
                    a = lit(a),
                )
            }
            GradeOp::FilmGrain { amount, seed } => {
                let a = finite_or(*amount, 0.0).clamp(0.0, 1.0);
                format!(
                    "let noise = (f32(grain_hash(u32(x), u32(y), {seed}u)) / 4294967296.0) * 2.0 - 1.0;\n\
                     let v = vec3f(clamp01({src}[i]), clamp01({src}[i + 1u]), clamp01({src}[i + 2u]));\n\
                     let outv = clamp(v + {a} * noise, vec3f(0.0), vec3f(1.0));",
                    a = lit(a),
                )
            }
            _ => unreachable!("spatial_pass only handles spatial ops"),
        };
        self.entries.push_str(&format!(
            "\n@compute @workgroup_size(256)\n\
             fn {name}(@builtin(global_invocation_id) gid: vec3<u32>) {{\n\
             let px = gid.x;\n\
             if (px >= N) {{ return; }}\n\
             let x = i32(px % W);\n\
             let y = i32(px / W);\n\
             let i = px * 4u;\n\
             {body}\n\
             {dst}[i] = outv.x;\n{dst}[i + 1u] = outv.y;\n{dst}[i + 2u] = outv.z;\n\
             {dst}[i + 3u] = {src}[i + 3u];\n}}\n"
        ));
        self.steps.push(Step::Dispatch(name));
    }

    // Composite the graded buffer over `state` per blend + opacity +
    // mask × qualifier (mirrors `composite_over` + the gate assembly in
    // `doc.rs::apply_layer_masked`).
    fn composite_pass(&mut self, graded: Work, layer: &GradeLayer) {
        let name = self.entry_name();
        let src = graded.name();
        let opacity = layer.opacity.clamp(0.0, 1.0);
        let mut gate = String::from("var gate = 1.0;\n");
        if let Some(q) = &layer.qualifier {
            self.entries.push_str(&qualifier_fn(&name, q));
            gate.push_str(&format!(
                "gate = {name}_qual(vec3f(state[i], state[i + 1u], state[i + 2u]));\n"
            ));
        }
        if let Some(mask) = &layer.mask {
            assert_eq!(mask.len(), self.n, "mask length");
            let off = self.push_table(mask);
            gate.push_str(&format!("gate *= clamp01(tables[{off}u + px]);\n"));
        }
        let unbounded = self.space == GradeSpace::LinearRec709 && layer.blend == BlendMode::Normal;
        // Clamp mid-chain HDR to the display window before blending, unless
        // the space+mode combo passes values through unbounded.
        let ld = |e: &str| {
            if unbounded {
                e.to_string()
            } else {
                format!("clamp01({e})")
            }
        };
        let blended = blend_expr(layer.blend, "cb", "cs");
        self.entries.push_str(&format!(
            "\n@compute @workgroup_size(256)\n\
             fn {name}(@builtin(global_invocation_id) gid: vec3<u32>) {{\n\
             let px = gid.x;\n\
             if (px >= N) {{ return; }}\n\
             let i = px * 4u;\n\
             {gate}\
             let sa = clamp01({src}[i + 3u]) * {opacity} * clamp01(gate);\n\
             let ba = clamp01(state[i + 3u]);\n\
             let oa = sa + ba * (1.0 - sa);\n\
             let cb = vec3f({cb0}, {cb1}, {cb2});\n\
             let cs = vec3f({cs0}, {cs1}, {cs2});\n\
             let blended = {blended};\n\
             var outv = vec3f(0.0);\n\
             if (oa != 0.0) {{\n\
             outv = (sa * (1.0 - ba) * cs + sa * ba * blended + (1.0 - sa) * ba * cb) / oa;\n\
             }}\n\
             state[i] = outv.x;\nstate[i + 1u] = outv.y;\nstate[i + 2u] = outv.z;\n\
             state[i + 3u] = oa;\n}}\n",
            opacity = lit(opacity),
            cb0 = ld("state[i]"),
            cb1 = ld("state[i + 1u]"),
            cb2 = ld("state[i + 2u]"),
            cs0 = ld(&format!("{src}[i]")),
            cs1 = ld(&format!("{src}[i + 1u]")),
            cs2 = ld(&format!("{src}[i + 2u]")),
        ));
        self.steps.push(Step::Dispatch(name));
    }

    // The WGSL statements for one per-pixel op, mutating `rgb` (mirrors
    // `apply_op`). Each op is wrapped in a block so temporaries can reuse
    // names.
    fn op_body(&mut self, op: &GradeOp) -> String {
        let body = match op {
            GradeOp::Exposure { ev } => {
                self.linear(&format!("lin *= {};", lit(2f32.powf(*ev))))
            }
            GradeOp::WhiteBalance { temp, tint } => self.linear(&format!(
                "lin *= vec3f({}, {}, {});",
                lit(2f32.powf(*temp)),
                lit(2f32.powf(*tint)),
                lit(2f32.powf(-*temp)),
            )),
            GradeOp::Levels {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
            } => {
                let span = (in_white - in_black).max(1e-6);
                let inv_gamma = 1.0 / gamma.max(1e-6);
                format!(
                    "let v = clamp((clamp(rgb, vec3f(0.0), vec3f(1.0)) - {ib}) / {span}, vec3f(0.0), vec3f(1.0));\n\
                     rgb = {ob} + ({ow} - {ob}) * pow(v, vec3f({ig}));",
                    ib = lit(*in_black),
                    span = lit(span),
                    ob = lit(*out_black),
                    ow = lit(*out_white),
                    ig = lit(inv_gamma),
                )
            }
            GradeOp::Curves { channel, points } => {
                let spline = MonotoneSpline::new(points);
                let lut: Vec<f32> = (0..CURVE_RES)
                    .map(|k| spline.eval(k as f32 / (CURVE_RES - 1) as f32))
                    .collect();
                let off = self.push_table(&lut);
                let sample = |ch: &str| format!("curve_lut({off}u, clamp01({ch}))");
                match channel {
                    CurveChannel::Master => format!(
                        "rgb = vec3f({}, {}, {});",
                        sample("rgb.x"),
                        sample("rgb.y"),
                        sample("rgb.z")
                    ),
                    CurveChannel::Red => format!("rgb.x = {};", sample("rgb.x")),
                    CurveChannel::Green => format!("rgb.y = {};", sample("rgb.y")),
                    CurveChannel::Blue => format!("rgb.z = {};", sample("rgb.z")),
                }
            }
            GradeOp::Saturation { amount } => self.linear(&format!(
                "let luma = dot(lin, vec3f(0.2126, 0.7152, 0.0722));\n\
                 lin = luma + (lin - luma) * {};",
                lit(1.0 + amount),
            )),
            GradeOp::LiftGammaGain { lift, gamma, gain } => {
                let ig = [
                    1.0 / gamma[0].max(1e-6),
                    1.0 / gamma[1].max(1e-6),
                    1.0 / gamma[2].max(1e-6),
                ];
                self.linear(&format!(
                    "let v = max((lin + vec3f({l0}, {l1}, {l2}) * (1.0 - lin)) * vec3f({g0}, {g1}, {g2}), vec3f(0.0));\n\
                     lin = pow(v, vec3f({i0}, {i1}, {i2}));",
                    l0 = lit(lift[0]),
                    l1 = lit(lift[1]),
                    l2 = lit(lift[2]),
                    g0 = lit(gain[0]),
                    g1 = lit(gain[1]),
                    g2 = lit(gain[2]),
                    i0 = lit(ig[0]),
                    i1 = lit(ig[1]),
                    i2 = lit(ig[2]),
                ))
            }
            GradeOp::HslAdjust {
                hue,
                saturation,
                lightness,
            } => format!(
                "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                 rgb = hsl_to_rgb(rem_euclid(hsl.x + {h}, 360.0), clamp01(hsl.y * {s}), clamp01(hsl.z * {l}));",
                h = lit(*hue),
                s = lit(1.0 + saturation),
                l = lit(1.0 + lightness),
            ),
            GradeOp::HueVsHue { points } => {
                self.hue_curve(points, 0.0, |lut| {
                    format!(
                        "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                         rgb = hsl_to_rgb(rem_euclid(hsl.x + {lut}, 360.0), hsl.y, hsl.z);"
                    )
                })
            }
            GradeOp::HueVsSat { points } => {
                self.hue_curve(points, 1.0, |lut| {
                    format!(
                        "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                         rgb = hsl_to_rgb(hsl.x, clamp01(hsl.y * {lut}), hsl.z);"
                    )
                })
            }
            GradeOp::LumVsSat { points } => {
                let mul = self.multiplier_curve(points, "hsl.z");
                format!(
                    "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                     rgb = hsl_to_rgb(hsl.x, clamp01(hsl.y * {mul}), hsl.z);"
                )
            }
            GradeOp::SatVsSat { points } => {
                let mul = self.multiplier_curve(points, "hsl.y");
                format!(
                    "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                     rgb = hsl_to_rgb(hsl.x, clamp01(hsl.y * {mul}), hsl.z);"
                )
            }
            GradeOp::LogWheels {
                shadows,
                midtones,
                highlights,
                low_pivot,
                high_pivot,
            } => {
                let low = low_pivot.max(1e-6);
                let high_span = (1.0 - high_pivot).max(1e-6);
                format!(
                    "let v = clamp(rgb, vec3f(0.0), vec3f(1.0));\n\
                     let ws = 1.0 - sstep3(v / {low});\n\
                     let wh = sstep3((v - {hp}) / {hs});\n\
                     let wm = max(1.0 - ws - wh, vec3f(0.0));\n\
                     rgb = clamp(v + ws * vec3f({s0}, {s1}, {s2}) + wm * vec3f({m0}, {m1}, {m2}) + wh * vec3f({h0}, {h1}, {h2}), vec3f(0.0), vec3f(1.0));",
                    low = lit(low),
                    hp = lit(*high_pivot),
                    hs = lit(high_span),
                    s0 = lit(shadows[0]),
                    s1 = lit(shadows[1]),
                    s2 = lit(shadows[2]),
                    m0 = lit(midtones[0]),
                    m1 = lit(midtones[1]),
                    m2 = lit(midtones[2]),
                    h0 = lit(highlights[0]),
                    h1 = lit(highlights[1]),
                    h2 = lit(highlights[2]),
                )
            }
            GradeOp::Contrast { amount, pivot } => format!(
                "let v = clamp(rgb, vec3f(0.0), vec3f(1.0));\n\
                 rgb = clamp({p} + (v - {p}) * {a}, vec3f(0.0), vec3f(1.0));",
                p = lit(*pivot),
                a = lit(*amount),
            ),
            GradeOp::SoftClip {
                high_start,
                low_start,
            } => {
                let hs = high_start.clamp(0.0, 1.0 - 1e-4);
                let ls = low_start.clamp(0.0, hs);
                self.linear(&format!(
                    "lin = vec3f(soft_clip(lin.x, {hs}, {ls}), soft_clip(lin.y, {hs}, {ls}), soft_clip(lin.z, {hs}, {ls}));",
                    hs = lit(hs),
                    ls = lit(ls),
                ))
            }
            GradeOp::WhiteBalanceK { temp_k, tint } => {
                let gains = planckian_gains(*temp_k, *tint);
                self.linear(&format!(
                    "lin *= vec3f({}, {}, {});",
                    lit(gains[0]),
                    lit(gains[1]),
                    lit(gains[2]),
                ))
            }
            GradeOp::RgbMixer {
                red,
                green,
                blue,
                monochrome,
            } => {
                let sane = |w: &[f32; 3]| w.map(|v| if v.is_finite() { v } else { 0.0 });
                let rows = if *monochrome {
                    [sane(red), sane(red), sane(red)]
                } else {
                    [sane(red), sane(green), sane(blue)]
                };
                self.linear(&format!(
                    "lin = vec3f(dot(lin, vec3f({}, {}, {})), dot(lin, vec3f({}, {}, {})), dot(lin, vec3f({}, {}, {})));",
                    lit(rows[0][0]),
                    lit(rows[0][1]),
                    lit(rows[0][2]),
                    lit(rows[1][0]),
                    lit(rows[1][1]),
                    lit(rows[1][2]),
                    lit(rows[2][0]),
                    lit(rows[2][1]),
                    lit(rows[2][2]),
                ))
            }
            GradeOp::ColorWarper { points } => {
                let mut body = String::from(
                    "let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
                     var hue_shift = 0.0;\nvar sat_factor = 1.0;\n",
                );
                for p in points {
                    if ![
                        p.hue,
                        p.sat,
                        p.hue_shift,
                        p.sat_scale,
                        p.hue_radius,
                        p.sat_radius,
                    ]
                    .iter()
                    .all(|v| v.is_finite())
                    {
                        continue;
                    }
                    body.push_str(&format!(
                        "{{\nlet draw = rem_euclid(hsl.x - {hue}, 360.0);\n\
                         let dh = min(draw, 360.0 - draw);\n\
                         let ds = hsl.y - {sat};\n\
                         let d = sqrt((dh / {hr}) * (dh / {hr}) + (ds / {sr}) * (ds / {sr}));\n\
                         let wq = sstep(1.0 - d);\n\
                         hue_shift += wq * {shift};\n\
                         sat_factor *= 1.0 + wq * ({scale} - 1.0);\n}}\n",
                        hue = lit(p.hue),
                        sat = lit(p.sat.clamp(0.0, 1.0)),
                        hr = lit(p.hue_radius.max(1e-3)),
                        sr = lit(p.sat_radius.max(1e-3)),
                        shift = lit(p.hue_shift),
                        scale = lit(p.sat_scale),
                    ));
                }
                body.push_str(
                    "rgb = hsl_to_rgb(rem_euclid(hsl.x + hue_shift, 360.0), clamp01(hsl.y * max(sat_factor, 0.0)), hsl.z);",
                );
                body
            }
            GradeOp::Lut1d { size, table } => {
                assert!(*size >= 2 && table.len() == (*size as usize) * 3, "LUT");
                let off = self.push_table(table);
                format!(
                    "rgb = vec3f(lut1d({off}u, {size}u, 0u, clamp01(rgb.x)), lut1d({off}u, {size}u, 1u, clamp01(rgb.y)), lut1d({off}u, {size}u, 2u, clamp01(rgb.z)));"
                )
            }
            GradeOp::Lut3d { size, table } => {
                assert!(
                    *size >= 2 && table.len() == (*size as usize).pow(3) * 3,
                    "LUT"
                );
                let off = self.push_table(table);
                format!("rgb = lut3d({off}u, {size}u, clamp(rgb, vec3f(0.0), vec3f(1.0)));")
            }
            GradeOp::Sharpen { .. } | GradeOp::Denoise { .. } | GradeOp::FilmGrain { .. } => {
                unreachable!("spatial ops are scheduled by spatial_pass")
            }
        };
        format!("{{\n{body}\n}}")
    }

    // Wrap `inner` (operating on `lin`) in the linear-light decode/encode
    // round trip (mirrors `for_each_rgb_linear`).
    fn linear(&self, inner: &str) -> String {
        if self.space == GradeSpace::LinearRec709 {
            return format!("var lin = rgb;\n{inner}\nrgb = lin;");
        }
        format!(
            "var lin = vec3f(trc_decode(clamp01(rgb.x)), trc_decode(clamp01(rgb.y)), trc_decode(clamp01(rgb.z)));\n\
             {inner}\n\
             rgb = vec3f(trc_encode(lin.x), trc_encode(lin.y), trc_encode(lin.z));"
        )
    }

    // Bake a periodic hue-domain spline to a wrapped LUT and emit `f(lut)`
    // where `lut` samples it at `hsl.x` (mirrors `PeriodicSpline`).
    fn hue_curve(
        &mut self,
        points: &[[f32; 2]],
        neutral: f32,
        f: impl Fn(String) -> String,
    ) -> String {
        if points.is_empty() {
            // Identity for hue shift 0; multiplier 1 leaves sat unchanged —
            // but the CPU path still does the HSL round trip, so mirror it.
            return f(lit(neutral));
        }
        let mut wrapped: Vec<[f32; 2]> = Vec::with_capacity(points.len() * 3);
        let mut base: Vec<[f32; 2]> = points
            .iter()
            .map(|p| [p[0].rem_euclid(360.0), p[1]])
            .collect();
        base.sort_by(|a, b| a[0].total_cmp(&b[0]));
        for shift in [-360.0, 0.0, 360.0] {
            wrapped.extend(base.iter().map(|p| [p[0] + shift, p[1]]));
        }
        let spline = MonotoneSpline::new(&wrapped);
        let lut: Vec<f32> = (0..CURVE_RES)
            .map(|k| spline.eval(k as f32 * 360.0 / CURVE_RES as f32))
            .collect();
        let off = self.push_table(&lut);
        f(format!("hue_lut({off}u, hsl.x)"))
    }

    // Bake a 0..=1-domain multiplier spline to a LUT sampled at `arg`
    // (mirrors `MultiplierSpline`).
    fn multiplier_curve(&mut self, points: &[[f32; 2]], arg: &str) -> String {
        if points.is_empty() {
            return lit(1.0);
        }
        let spline = MonotoneSpline::new(points);
        let lut: Vec<f32> = (0..CURVE_RES)
            .map(|k| spline.eval(k as f32 / (CURVE_RES - 1) as f32))
            .collect();
        let off = self.push_table(&lut);
        format!("curve_lut({off}u, clamp01({arg}))")
    }
}

// A per-layer WGSL function `{name}_qual(rgb) -> f32` giving the HSL
// qualifier gate for one encoded RGB pixel (mirrors `HslQualifier::weight`).
fn qualifier_fn(name: &str, q: &HslQualifier) -> String {
    let hue_w = if q.hue_soft <= 0.0 {
        format!("select(0.0, 1.0, dq <= {})", lit(q.hue_range))
    } else {
        format!(
            "select(1.0 - sstep((dq - {r}) / {s}), 1.0, dq <= {r})",
            r = lit(q.hue_range),
            s = lit(q.hue_soft),
        )
    };
    let band = |v: &str, lo: f32, hi: f32, soft: f32| {
        if soft <= 0.0 {
            format!(
                "select(0.0, 1.0, {v} >= {lo} && {v} <= {hi})",
                lo = lit(lo),
                hi = lit(hi),
            )
        } else {
            format!(
                "select(1.0 - sstep(select({v} - {hi}, {lo} - {v}, {v} < {lo}) / {soft}), 1.0, {v} >= {lo} && {v} <= {hi})",
                lo = lit(lo),
                hi = lit(hi),
                soft = lit(soft),
            )
        }
    };
    let sat_w = band("hsl.y", q.sat_range[0], q.sat_range[1], q.sat_soft);
    let lum_w = band("hsl.z", q.lum_range[0], q.lum_range[1], q.lum_soft);
    let invert = if q.invert { "1.0 - w" } else { "w" };
    format!(
        "\nfn {name}_qual(rgb: vec3f) -> f32 {{\n\
         let hsl = rgb_to_hsl(clamp(rgb, vec3f(0.0), vec3f(1.0)));\n\
         let draw = rem_euclid(hsl.x - {center}, 360.0);\n\
         let dq = min(draw, 360.0 - draw);\n\
         let hue_w = {hue_w};\n\
         let sat_w = {sat_w};\n\
         let lum_w = {lum_w};\n\
         let w = hue_w * sat_w * lum_w;\n\
         return {invert};\n}}\n",
        center = lit(q.hue_center),
    )
}

// Blend `cb`/`cs` (vec3f expressions) per the layer's mode (mirrors
// `blend_rgb` / `blend_channel`).
fn blend_expr(mode: BlendMode, cb: &str, cs: &str) -> String {
    match mode {
        BlendMode::Normal => cs.to_string(),
        BlendMode::Multiply => format!("({cb} * {cs})"),
        BlendMode::Screen => format!("({cb} + {cs} - {cb} * {cs})"),
        BlendMode::Overlay => format!("blend_hard_light({cs}, {cb})"),
        BlendMode::Darken => format!("min({cb}, {cs})"),
        BlendMode::Lighten => format!("max({cb}, {cs})"),
        BlendMode::ColorDodge => format!("blend_color_dodge({cb}, {cs})"),
        BlendMode::ColorBurn => format!("blend_color_burn({cb}, {cs})"),
        BlendMode::HardLight => format!("blend_hard_light({cb}, {cs})"),
        BlendMode::SoftLight => format!("blend_soft_light({cb}, {cs})"),
        BlendMode::Difference => format!("abs({cb} - {cs})"),
        BlendMode::Exclusion => format!("({cb} + {cs} - 2.0 * {cb} * {cs})"),
        BlendMode::LinearDodge => format!("min({cb} + {cs}, vec3f(1.0))"),
        BlendMode::LinearBurn => format!("max({cb} + {cs} - 1.0, vec3f(0.0))"),
        BlendMode::Hue => format!("set_lum(set_sat({cs}, sat3({cb})), lum3({cb}))"),
        BlendMode::Saturation => format!("set_lum(set_sat({cb}, sat3({cs})), lum3({cb}))"),
        BlendMode::Color => format!("set_lum({cs}, lum3({cb}))"),
        BlendMode::Luminosity => format!("set_lum({cb}, lum3({cs}))"),
    }
}

// An f32 literal that always parses as WGSL f32.
fn lit(v: f32) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{v}");
    if s.contains('.') || s.contains('e') || s.contains("inf") || s.contains("NaN") {
        s
    } else {
        format!("{s}.0")
    }
}

// The 3×3 neighbourhood offsets in row-major order: (tap index, dx, dy).
fn taps_3x3() -> [(usize, i32, i32); 9] {
    let mut out = [(0usize, 0i32, 0i32); 9];
    let mut k = 0;
    let mut dy = -1;
    while dy <= 1 {
        let mut dx = -1;
        while dx <= 1 {
            out[k] = (k, dx, dy);
            k += 1;
            dx += 1;
        }
        dy += 1;
    }
    out
}

fn finite_or(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

// The shared helper functions, emitted once per module. TRC decode/encode
// are specialised to the surface's space at codegen time.
fn helpers(space: GradeSpace) -> String {
    let trc = match space {
        GradeSpace::LinearRec709 => {
            "fn trc_decode(c: f32) -> f32 { return c; }\n\
             fn trc_encode(l: f32) -> f32 { return l; }\n"
        }
        GradeSpace::Srgb => {
            "fn trc_decode(c: f32) -> f32 {\n\
             if (c <= 0.04045) { return c / 12.92; }\n\
             return pow((c + 0.055) / 1.055, 2.4);\n}\n\
             fn trc_encode(lv: f32) -> f32 {\n\
             let l = clamp01(lv);\n\
             if (l <= 0.0031308) { return 12.92 * l; }\n\
             return 1.055 * pow(l, 1.0 / 2.4) - 0.055;\n}\n"
        }
        GradeSpace::ProPhoto => {
            "fn trc_decode(c: f32) -> f32 {\n\
             if (c < 0.03125) { return c / 16.0; }\n\
             return pow(c, 1.8);\n}\n\
             fn trc_encode(lv: f32) -> f32 {\n\
             let l = clamp01(lv);\n\
             if (l < 0.001953125) { return 16.0 * l; }\n\
             return pow(l, 1.0 / 1.8);\n}\n"
        }
    };
    format!(
        "fn clamp01(v: f32) -> f32 {{ return clamp(v, 0.0, 1.0); }}\n\
         fn rem_euclid(x: f32, m: f32) -> f32 {{ return x - m * floor(x / m); }}\n\
         fn sstep(t: f32) -> f32 {{ return smoothstep(0.0, 1.0, t); }}\n\
         fn sstep3(t: vec3f) -> vec3f {{ return smoothstep(vec3f(0.0), vec3f(1.0), t); }}\n\
         {trc}\
         fn rgb_to_hsl(rgb: vec3f) -> vec3f {{\n\
         let mx = max(rgb.x, max(rgb.y, rgb.z));\n\
         let mn = min(rgb.x, min(rgb.y, rgb.z));\n\
         let l = (mx + mn) / 2.0;\n\
         let d = mx - mn;\n\
         if (d <= 0.0) {{ return vec3f(0.0, 0.0, l); }}\n\
         var s = d / (mx + mn);\n\
         if (l > 0.5) {{ s = d / (2.0 - mx - mn); }}\n\
         var h = 0.0;\n\
         if (mx == rgb.x) {{ h = 60.0 * rem_euclid((rgb.y - rgb.z) / d, 6.0); }}\n\
         else if (mx == rgb.y) {{ h = 60.0 * ((rgb.z - rgb.x) / d + 2.0); }}\n\
         else {{ h = 60.0 * ((rgb.x - rgb.y) / d + 4.0); }}\n\
         return vec3f(h, s, l);\n}}\n\
         fn hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3f {{\n\
         let c = (1.0 - abs(2.0 * l - 1.0)) * s;\n\
         let hp = h / 60.0;\n\
         let x = c * (1.0 - abs(rem_euclid(hp, 2.0) - 1.0));\n\
         var rgb = vec3f(c, 0.0, x);\n\
         switch (u32(hp)) {{\n\
         case 0u: {{ rgb = vec3f(c, x, 0.0); }}\n\
         case 1u: {{ rgb = vec3f(x, c, 0.0); }}\n\
         case 2u: {{ rgb = vec3f(0.0, c, x); }}\n\
         case 3u: {{ rgb = vec3f(0.0, x, c); }}\n\
         case 4u: {{ rgb = vec3f(x, 0.0, c); }}\n\
         default: {{ rgb = vec3f(c, 0.0, x); }}\n\
         }}\n\
         return rgb + (l - c / 2.0);\n}}\n\
         fn soft_clip(v: f32, hs: f32, ls: f32) -> f32 {{\n\
         if (v > hs) {{\n\
         let t = (v - hs) / (1.0 - hs);\n\
         return hs + (1.0 - hs) * t / (1.0 + t);\n\
         }}\n\
         if (v < ls) {{\n\
         if (ls <= 0.0) {{ return 0.0; }}\n\
         let t = (ls - v) / ls;\n\
         return ls - ls * t / (1.0 + t);\n\
         }}\n\
         return v;\n}}\n\
         fn curve_lut(off: u32, x: f32) -> f32 {{\n\
         let pos = x * f32({res_m1}u);\n\
         let i0 = min(u32(pos), {res_m2}u);\n\
         let f = pos - f32(i0);\n\
         let a = tables[off + i0];\n\
         let b = tables[off + i0 + 1u];\n\
         return a + (b - a) * f;\n}}\n\
         fn hue_lut(off: u32, h: f32) -> f32 {{\n\
         let pos = rem_euclid(h, 360.0) / 360.0 * f32({res}u);\n\
         let i0 = min(u32(pos), {res_m1}u);\n\
         let f = pos - f32(i0);\n\
         let a = tables[off + i0];\n\
         let b = tables[off + ((i0 + 1u) % {res}u)];\n\
         return a + (b - a) * f;\n}}\n\
         fn lut1d(off: u32, size: u32, channel: u32, v: f32) -> f32 {{\n\
         let pos = v * f32(size - 1u);\n\
         let i0 = min(u32(pos), size - 2u);\n\
         let f = pos - f32(i0);\n\
         let a = tables[off + i0 * 3u + channel];\n\
         let b = tables[off + (i0 + 1u) * 3u + channel];\n\
         return a + (b - a) * f;\n}}\n\
         fn lut3d_entry(off: u32, size: u32, r: u32, g: u32, b: u32) -> vec3f {{\n\
         let i = off + ((b * size + g) * size + r) * 3u;\n\
         return vec3f(tables[i], tables[i + 1u], tables[i + 2u]);\n}}\n\
         fn lut3d(off: u32, size: u32, rgb: vec3f) -> vec3f {{\n\
         let n = f32(size - 1u);\n\
         let pos = rgb * n;\n\
         let i0 = min(vec3u(pos), vec3u(size - 2u));\n\
         let f = pos - vec3f(i0);\n\
         let fr = f.x; let fg = f.y; let fb = f.z;\n\
         var w1 = 0.0; var w2 = 0.0; var w3 = 0.0;\n\
         var e1 = vec3f(0.0); var e2 = vec3f(0.0); var e3 = vec3f(0.0);\n\
         if (fr > fg) {{\n\
         if (fg > fb) {{\n\
         w1 = fr; e1 = lut3d_entry(off, size, i0.x + 1u, i0.y, i0.z);\n\
         w2 = fg; e2 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z);\n\
         w3 = fb; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }} else if (fr > fb) {{\n\
         w1 = fr; e1 = lut3d_entry(off, size, i0.x + 1u, i0.y, i0.z);\n\
         w2 = fb; e2 = lut3d_entry(off, size, i0.x + 1u, i0.y, i0.z + 1u);\n\
         w3 = fg; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }} else {{\n\
         w1 = fb; e1 = lut3d_entry(off, size, i0.x, i0.y, i0.z + 1u);\n\
         w2 = fr; e2 = lut3d_entry(off, size, i0.x + 1u, i0.y, i0.z + 1u);\n\
         w3 = fg; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }}\n\
         }} else if (fb > fg) {{\n\
         w1 = fb; e1 = lut3d_entry(off, size, i0.x, i0.y, i0.z + 1u);\n\
         w2 = fg; e2 = lut3d_entry(off, size, i0.x, i0.y + 1u, i0.z + 1u);\n\
         w3 = fr; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }} else if (fb > fr) {{\n\
         w1 = fg; e1 = lut3d_entry(off, size, i0.x, i0.y + 1u, i0.z);\n\
         w2 = fb; e2 = lut3d_entry(off, size, i0.x, i0.y + 1u, i0.z + 1u);\n\
         w3 = fr; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }} else {{\n\
         w1 = fg; e1 = lut3d_entry(off, size, i0.x, i0.y + 1u, i0.z);\n\
         w2 = fr; e2 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z);\n\
         w3 = fb; e3 = lut3d_entry(off, size, i0.x + 1u, i0.y + 1u, i0.z + 1u);\n\
         }}\n\
         let e0 = lut3d_entry(off, size, i0.x, i0.y, i0.z);\n\
         return e0 + w1 * (e1 - e0) + w2 * (e2 - e1) + w3 * (e3 - e2);\n}}\n\
         fn tap(x: i32, y: i32, dx: i32, dy: i32) -> u32 {{\n\
         let ty = clamp(y + dy, 0, i32(H) - 1);\n\
         let tx = clamp(x + dx, 0, i32(W) - 1);\n\
         return (u32(ty) * W + u32(tx)) * 4u;\n}}\n\
         fn grain_hash(x: u32, y: u32, seed: u32) -> u32 {{\n\
         var hsh = x * 0x9E3779B1u ^ y * 0x85EBCA77u ^ seed * 0xC2B2AE3Du;\n\
         hsh ^= hsh >> 16u;\n\
         hsh *= 0x7FEB352Du;\n\
         hsh ^= hsh >> 15u;\n\
         hsh *= 0x846CA68Bu;\n\
         hsh ^= hsh >> 16u;\n\
         return hsh;\n}}\n\
         fn lum3(c: vec3f) -> f32 {{ return dot(c, vec3f(0.3, 0.59, 0.11)); }}\n\
         fn sat3(c: vec3f) -> f32 {{\n\
         return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z));\n}}\n\
         fn clip_color(c: vec3f) -> vec3f {{\n\
         let l = lum3(c);\n\
         let n = min(c.x, min(c.y, c.z));\n\
         let x = max(c.x, max(c.y, c.z));\n\
         var outv = c;\n\
         if (n < 0.0) {{ outv = l + (outv - l) * l / (l - n); }}\n\
         if (x > 1.0) {{ outv = l + (outv - l) * (1.0 - l) / (x - l); }}\n\
         return outv;\n}}\n\
         fn set_lum(c: vec3f, l: f32) -> vec3f {{\n\
         return clip_color(c + (l - lum3(c)));\n}}\n\
         fn set_sat(c: vec3f, s: f32) -> vec3f {{\n\
         let mn = min(c.x, min(c.y, c.z));\n\
         let mx = max(c.x, max(c.y, c.z));\n\
         var outv = vec3f(0.0);\n\
         if (mx > mn) {{\n\
         let scaled = (c - mn) * s / (mx - mn);\n\
         outv = scaled;\n\
         // The max channel is exactly s, the min 0, the mid scaled.\n\
         }}\n\
         return outv;\n}}\n\
         fn blend_color_dodge(cb: vec3f, cs: vec3f) -> vec3f {{\n\
         return vec3f(cd1(cb.x, cs.x), cd1(cb.y, cs.y), cd1(cb.z, cs.z));\n}}\n\
         fn cd1(cb: f32, cs: f32) -> f32 {{\n\
         if (cb <= 0.0) {{ return 0.0; }}\n\
         if (cs >= 1.0) {{ return 1.0; }}\n\
         return min(cb / (1.0 - cs), 1.0);\n}}\n\
         fn blend_color_burn(cb: vec3f, cs: vec3f) -> vec3f {{\n\
         return vec3f(cbn1(cb.x, cs.x), cbn1(cb.y, cs.y), cbn1(cb.z, cs.z));\n}}\n\
         fn cbn1(cb: f32, cs: f32) -> f32 {{\n\
         if (cb >= 1.0) {{ return 1.0; }}\n\
         if (cs <= 0.0) {{ return 0.0; }}\n\
         return 1.0 - min((1.0 - cb) / cs, 1.0);\n}}\n\
         fn blend_hard_light(cb: vec3f, cs: vec3f) -> vec3f {{\n\
         return vec3f(hl1(cb.x, cs.x), hl1(cb.y, cs.y), hl1(cb.z, cs.z));\n}}\n\
         fn hl1(cb: f32, cs: f32) -> f32 {{\n\
         if (cs <= 0.5) {{ return cb * (2.0 * cs); }}\n\
         let s = 2.0 * cs - 1.0;\n\
         return cb + s - cb * s;\n}}\n\
         fn blend_soft_light(cb: vec3f, cs: vec3f) -> vec3f {{\n\
         return vec3f(sl1(cb.x, cs.x), sl1(cb.y, cs.y), sl1(cb.z, cs.z));\n}}\n\
         fn sl1(cb: f32, cs: f32) -> f32 {{\n\
         if (cs <= 0.5) {{ return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }}\n\
         var d = sqrt(cb);\n\
         if (cb <= 0.25) {{ d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }}\n\
         return cb + (2.0 * cs - 1.0) * (d - cb);\n}}\n",
        res = CURVE_RES,
        res_m1 = CURVE_RES - 1,
        res_m2 = CURVE_RES - 2,
    )
}
