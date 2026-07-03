# Grade kernel: the standalone f32 colour-grading core

**Status:** Proposed (design). Nothing in this document is implemented yet.
This is the design for the colour-grading kernel that the image grading
dialog and the future **video grading dialog** will share. It builds *on top
of* the locked colour pipeline (`docs/design/colour-pipeline.md`) and does
**not** change the mask editor's u8 proxy compositor
(`docs/design/ps-editor-architecture.md`).

## Goals and non-goals

Photoshop is the baseline, not the ceiling. The kernel must support
PS-level layered compositing **and** the higher-precision demands of video
grading (many stacked corrections per frame, no cumulative banding).

- **Goal:** one deterministic, frame-agnostic f32 compositing + grading core
  that both the image dialog and the video dialog call. Same numbers, every
  frame, both dialogs.
- **Goal:** isolation — a bug fix or new blend mode touches only the kernel
  crate, never the app shell, the mask editor, or the colour pipeline.
- **Non-goal:** replacing the mask editor's u8 grayscale compositor. Mask
  surfaces are alpha coverage; 8-bit is semantically correct there and PS
  does the same. That kernel stays as-is.
- **Non-goal (first landing):** GPU. First landing is CPU (scanline,
  optionally rayon). The op model is designed so a GPU backend can be added
  behind the same op graph later without changing the serialised format.
  That backend now exists behind the optional `gpu` feature (wgpu + WGSL):
  `GpuGrader` compiles a `GradeDoc` into generated compute passes (per-pixel
  runs fused into one pass, spatial ops as their own src→dst pass) and
  replays the cached pipeline per frame. The CPU path stays the reference
  implementation and fallback; the GPU output is preview-grade, validated
  against CPU with f32 tolerances in `crates/hgripe-grade/tests/gpu.rs`
  (curves are baked to 1024-sample LUTs), not bit-identical — the
  bit-identical constraint below binds the CPU paths only.

## Placement and dependency policy (decided constraints)

- **Standalone crate: `crates/hgripe-grade`.** A workspace member like
  `crates/hgripe-api`, depended on by `hgripe-desktop`. Not a module inside
  `src-tauri/src/studio` — the kernel must be compilable, testable, and
  fuzzable on its own, and its public API is the only coupling surface.
- **Pure Rust, no Python.** Grading is a per-frame hot path; the Python
  bridge's process/serialisation overhead and deployment weight are
  disqualifying. The bridge never participates in grading.
- **Minimal, locked dependencies.** The kernel core (blend math, adjustment
  math, LUT application) is dependency-free `f32` array code. Allowed
  dependencies, all already in the tree and covered by the vendoring policy
  (`docs/design/rust-dependency-vendoring.md`):
  - `moxcms` (vendored fork) — only if the kernel ever does ICC transforms
    itself; the intent is that it does **not** (see *Colour contract*).
  - `rayon` — optional feature for row-parallel compositing.
  - `serde`/`serde_json` — the op-graph serialisation.
  No new colour crates. `.cube` LUT parsing is ~100 lines and is written
  in-crate, not pulled from crates.io.

## Colour contract (division of labour with the existing pipeline)

The existing `studio/color` module stays the *only* place ICC conversions
are constructed. The kernel never sees ICC:

```
WorkingImage (u16 ProPhoto/sRGB + ICC)          — studio/color owns this
        │  ingress: u16 → f32 (0..1), space tag passed through
        ▼
GradeSurface { data: Vec<f32> /* RGBA interleaved */, w, h, space }
        │  kernel: composite + grade in f32, no quantisation
        ▼
        │  egress: f32 → u16, back into WorkingImage
        ▼
WorkingImage → to_srgb_rgba8 / write_working_output   — unchanged egress
```

- **Working values are gamma-encoded** (matching pipeline decision #2:
  gamma-encoded working space, linear-light per operation). Each op declares
  whether its maths runs on encoded or linear values; the kernel decodes /
  re-encodes around that op using the shared TRC code (`studio/color/linear.rs`
  logic, generalised to f32 — the gamma-1.8 ProPhoto TRC and the sRGB TRC).
- **Quantisation happens exactly once**, at kernel egress back to u16. No
  per-layer u8/u16 rounding — this is the precision gap the u8 mask
  compositor deliberately accepts and the grade kernel deliberately closes.
- **Alpha is straight**, as everywhere else in the pipeline. Blending
  premultiplies transiently inside the compositor where required.

## Kernel model

### Surface

```rust
pub struct GradeSurface {
    pub w: u32,
    pub h: u32,
    /// RGBA interleaved, straight alpha, 0.0..=1.0 nominal (HDR headroom
    /// above 1.0 is allowed mid-chain; clamped at egress).
    pub data: Vec<f32>,
    pub space: GradeSpace, // Srgb | ProPhoto — TRC + primaries tag
}
```

### Op graph (serialisable, revisable)

Mirrors the mask editor's proven document model — plain data, replayed in
order, every step revisable — so the dialogs get undo/redo and non-destructive
editing for free:

```rust
pub struct GradeDoc { pub layers: Vec<GradeLayer> }

pub struct GradeLayer {
    pub blend: BlendMode,
    pub opacity: f32,
    pub visible: bool,
    /// Optional grayscale mask gating the layer's effect (f32, 0..1).
    pub mask: Option<GradeMask>,
    pub ops: Vec<GradeOp>,
}

pub enum GradeOp {
    Exposure { ev: f32 },                       // linear-light
    WhiteBalance { temp: f32, tint: f32 },      // linear-light
    LiftGammaGain { lift: [f32; 3], gamma: [f32; 3], gain: [f32; 3] }, // video wheels
    Levels { /* per-channel in/out black/white + gamma */ },
    Curves { /* per-channel control points → monotone spline */ },
    HslAdjust { /* hue/sat/lum deltas, 8 hue ranges */ },
    Saturation { amount: f32 },                 // linear-light, Rec.709 luma weights
    Lut3d { title: String, size: u32, data: Vec<f32> },  // parsed .cube
}
```

`BlendMode` starts with the full separable PS set — normal, multiply,
screen, overlay, soft/hard light, darken, lighten, difference, exclusion,
color/linear dodge & burn — as pure `fn blend(cb: f32, cs: f32) -> f32`
per-channel functions (the W3C compositing spec definitions, which PS
follows for separable modes). Non-separable modes (hue, saturation, color,
luminosity) come in a second phase; they need per-pixel luma/sat helpers,
not a different architecture.

### Determinism

- Pure `f32` arithmetic, no fast-math, no platform intrinsics in the
  reference path. An optional SIMD/rayon path must produce bit-identical
  results to the reference path (asserted in tests) or it does not ship.
- LUT sampling is tetrahedral (same choice as the ICC engine), defined once.

## Golden vectors: one spec, two runners

The mask kernel's TS/Rust mirroring relies on comment discipline ("mirrors
`maskMorphology.ts`"). The grade kernel replaces that with **shared golden
vectors** so the preview provably cannot drift from the run:

- `crates/hgripe-grade/goldens/*.json` — small, hand-auditable cases: input
  pixels (f32), a `GradeDoc`, expected output pixels, and a tolerance
  (`0` for the reference path; small ε only where TRC transcendentals are
  involved).
- **Rust runner:** `cargo test -p hgripe-grade` loads every vector and
  asserts the kernel output.
- **TS runner:** the studio-ui preview implementation (a WebGL/WASM or plain
  TS mirror, decided when the dialog lands) loads the *same JSON files* via a
  vitest suite. A new blend mode or op is not "done" until both runners pass
  the same vectors.
- Adding an op = adding vectors first (spec), then making both ends pass.

## Video integration (why this shape)

The video grading dialog feeds frames from the existing media-engine seam
(`third_party/ffmpeg` native path). The kernel is deliberately frame-agnostic:

- `apply(doc: &GradeDoc, surface: &mut GradeSurface)` has no notion of
  time — the dialog maps `frame → GradeSurface → apply → encode/display`.
  Keyframed parameters are the *dialog's* job (interpolate the `GradeDoc`
  per frame), keeping the kernel stateless and trivially cacheable.
- f32 end-to-end means a 10-bit video source (0..1023 → f32) grades without
  the 8-bit quantisation that would band on the first node stack.
- The op set is a superset of PS adjustments *and* the Resolve-style video
  primitives (lift/gamma/gain wheels, LUTs) so one dialog vocabulary serves
  both stills and footage.

## Phasing

- **G0 — crate + surface + goldens harness.** `crates/hgripe-grade` with
  `GradeSurface`, u16↔f32 ingress/egress against `WorkingImage`, the golden
  JSON loader, and CI wiring (`cargo test -p hgripe-grade` job). No ops yet.
- **G1 — separable blend modes + opacity + layer masks.** Full separable PS
  blend set with golden vectors; TS runner stub executes the same vectors.
- **G2 — core adjustments.** Exposure, levels, curves, saturation, white
  balance — each with linear/encoded declaration and vectors.
- **G3 — video-facing ops.** Lift/gamma/gain, HSL ranges, `.cube` 3D LUT
  parse + tetrahedral apply.
- **G4 — dialog integration.** Image grading dialog first (proves the
  ingress/egress round-trip on `WorkingImage`), then the video dialog on the
  frame path. Non-separable blend modes ride along here or after.

## Related

- `docs/design/colour-pipeline.md` — the locked pipeline this kernel sits on;
  owns ICC, working space, and egress.
- `docs/design/ps-editor-architecture.md` — the mask editor document model the
  op graph mirrors; its u8 compositor is unaffected.
- `docs/design/rust-dependency-vendoring.md` — dependency policy the kernel
  crate follows.
