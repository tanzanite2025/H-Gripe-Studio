# Grade kernel: upgrade roadmap

**Status:** Living document. The kernel described in
`docs/design/grade-kernel.md` is implemented and merged (G0–G4 op set,
module split, scopes, rayon parallel path, GPU backend, adjustable-radius
spatial ops, temporal denoise). This document lists the remaining upgrade
directions so future work can be picked deliberately instead of ad hoc.

## Where the kernel stands today

- **Op set:** exposure, white balance (incl. planckian), levels, curves,
  saturation, lift/gamma/gain, contrast, HSL adjust, HSL curves
  (hue-vs-hue etc.), log wheels, RGB mixer, 1D/3D LUT (tetrahedral),
  color warper, soft clip, sharpen / bilateral denoise (3×3/5×5/7×7),
  film grain, plus the cross-frame `temporal_denoise` stage.
- **Backends:** CPU reference path (bit-identical to the TS mirror via
  shared golden vectors), optional rayon band-parallel path (bit-identical,
  asserted), optional GPU backend (`gpu` feature, wgpu + WGSL codegen,
  tolerance-validated against CPU).
- **Analysis:** histogram, waveform, vectorscope scopes (f64, exact goldens).
- **Testing:** `goldens/*.json` shared by `cargo test -p hgripe-grade` and
  the studio-ui vitest suite; robustness tests over hostile inputs.

## Upgrade directions

### 1. UI integration (largely landed)

- ✅ **GPU preview in the grading dialog.** The panel's preview calls the
  backend `grade_preview` / `video_frame_grade_preview` commands, which run
  the process-wide `GpuGrader` (pipelines cached per op sequence) and fall
  back to the CPU reference path when no adapter initialises; the TS mirror
  remains the browser-preview / error fallback. The `grade-gpu` feature is
  now **on by default** in the desktop build.
- ✅ **Expose the newer ops in the panel.** Sharpen / denoise (with the
  radius control), film grain, RGB mixer, color warper and `.cube` LUT
  loading are in `GradePanel`.
- **Temporal denoise in the video dialog.** Still open: the kernel stage is
  caller-managed (`temporal_denoise(current, prev, amount)`); the
  `TemporalAccumulator` seam exists in `studio/grade.rs` but the video
  preview path does not yet keep the previous graded frame, with a reset on
  seek/cut.

### 2. New ops (same triple-end pattern: Rust + TS goldens + WGSL)

- ✅ **Vignette** — parametric ellipse, feather, encoded-signal gain — landed
  (`GradeOp::Vignette { amount, midpoint, feather }`, all three ends +
  goldens + panel UI).
- **Halation / bloom** — thresholded highlight spread; needs a separable
  large-radius blur primitive (see §4).
- **Glow / soft diffusion** — same blur primitive, screen-blended.
- **Chromatic aberration** — per-channel radial displacement; first op to
  need non-integer sampling (bilinear tap helper).
- **Film emulation presets** — composite ops (grain + halation + curve +
  matrix) shipped as factory `GradeDoc` fragments rather than new op kinds.
- **Dehaze / clarity** — local-contrast ops built on the blur primitive.
- **Noise reduction, chroma-specific** — bilateral on chroma only (needs a
  YCbCr split helper in the spatial family).

### 3. LUT and interchange

- **Bake a `GradeDoc` to `.cube`** — sample the identity cube through
  `apply()` and export; makes every grade portable to Resolve/PS. Spatial
  ops are excluded by construction (document that).
- **`.cube` export of individual layers** and import of shaper+cube pairs.
- **CDL (`.cdl`/ASC-CDL) import/export** — slope/offset/power/sat maps
  directly onto existing ops.
- **HALD CLUT PNG import/export** — cheap interchange with image tools.

### 4. Spatial/kernel infrastructure

- ✅ **Separable large-radius Gaussian blur primitive** — landed
  (`GradeOp::Blur { sigma }`, σ ≤ 32 px, radius `ceil(3σ)`; two-pass
  H then V on all three ends, goldens + panel UI). Halation, bloom, glow,
  dehaze, clarity can now build on it.
- **Non-integer sampling helper** (bilinear tap with edge clamp) — needed by
  chromatic aberration and any future warp/transform op.
- **Tile/stripe processing for very large stills** — bounded memory for
  >100 MP sources; spatial ops need an apron exchange between tiles.

### 5. Performance

- **SIMD on the CPU path** — blocked on the bit-identical CPU contract;
  either (a) relax the contract to a tolerance for the parallel path, or
  (b) implement identical SIMD on both ends (Rust intrinsics + WASM SIMD).
  Decide explicitly; do not drift into it.
- **Precomputation caching** — monotone splines, HSL curve tables, planckian
  gains and 1D-LUT tables are recomputed per `apply()`; cache keyed on the
  serialized op for interactive slider drags.
- **GPU: readback overlap and fp16 storage** — double-buffered staging to
  hide the copy latency; optional half-float intermediate surfaces for
  preview (tolerance-tested).
- **GPU spatial-pass fusion** — consecutive spatial ops currently each pay a
  full src→dst pass; fuse when radii allow.

### 6. Video-specific

- **Keyframed `GradeDoc` interpolation** — per the design doc this is the
  dialog's job; needs a defined interpolation for every op parameter
  (linear for scalars, slerp-like for hue) and a golden-tested
  `lerp_doc(a, b, t)` helper so CPU/TS agree.
- **GPU frame-sequence renderer for export** — reuse the cached pipeline
  across frames, ping-pong buffers, no per-frame shader rebuild; the seam
  to `third_party/ffmpeg` already exists.
- **Motion-compensated temporal denoise** — the current stage is
  zero-motion-vector (Gaussian range gate). A block-match or optical-flow
  assisted version is a large but well-scoped upgrade.
- **Scene-cut detection helper** — histogram-distance based, to auto-reset
  the temporal accumulator.

### 7. Colour science

- **More working spaces** — the `GradeSpace` enum is extensible; candidates:
  Rec.2020/PQ and HLG (HDR video), ACEScct (grading interchange). Each needs
  TRC pairs in `trc.rs` + goldens on both ends.
- **Tone mapping ops** — PQ→SDR / HDR→SDR display transforms as explicit
  ops, not hidden in egress.
- **Gamut mapping / gamut warning** — soft-clip in a perceptual space
  instead of per-channel; scope overlay for out-of-gamut pixels.

### 8. Robustness and tooling

- **Fuzzing** — `cargo fuzz` target over `GradeDoc` JSON → `apply()`;
  the crate was placed standalone precisely to make this possible.
- **Criterion benchmarks in CI** — the ad-hoc `examples/bench.rs` should
  become tracked benchmarks so perf regressions are visible in PRs.
- **Golden-coverage lint** — a script asserting every `GradeOp` variant and
  every `BlendMode` appears in at least one golden case.

## Suggested ordering

1. ✅ GPU preview in the dialog + expose the shipped ops (§1) — landed;
   temporal denoise in the video dialog is the remaining §1 item.
2. ✅ Blur primitive (§4) + vignette (§2) — landed; halation/bloom + glow
   (§2) are the natural next ops on top of the blur primitive.
3. LUT export (§3) — small, high interchange value.
4. Keyframe interpolation + GPU export renderer (§6) as the video dialog
   lands.
5. Precompute caching (§5) when interactive sliders feel sluggish; SIMD
   only after the contract decision.

## Related

- `docs/design/grade-kernel.md` — kernel design and constraints (colour
  contract, determinism, golden-vector discipline). All upgrades above stay
  inside those constraints unless a section says otherwise.
- `docs/design/colour-pipeline.md` — ICC/working-space ownership; §7 items
  must not move ICC into the kernel.
- `docs/design/rust-dependency-vendoring.md` — any new crate (fuzzing,
  criterion) follows the vendoring policy.
