# GPU / Device Strategy Plan

> Status: active. Short-term reporting steps 1–4 of the recommended order have
> started landing: the device-field inventory, the shared TypeScript
> `DeviceReport` vocabulary, and normalizers for the local-engine `*_report`
> outputs and viewport `ViewportBackend` frames live in
> `studio-ui/src/runtime/deviceReport.ts`, and every run now logs a per-node
> `device requested -> used (backend; fallback)` line, and the grade panel /
> program monitor backend badges render from the same vocabulary with
> fallbacks kept visible. Remaining: Rust-side vocabulary, capability-summary
> refinement, and the medium/long-term hardening below.

## Purpose

H-Gripe Studio should use available GPU acceleration where it helps, but it
should not pretend that "the system has a GPU" is enough to make every backend
safe, fast, or compatible.

The correct direction is:

- default to automatic device selection
- keep explicit CPU/GPU choices for control and debugging
- report what actually ran
- keep each compute kernel responsible for its own runtime compatibility
- only build a deeper resource manager after the product paths stabilize

This document separates the short-term, low-risk work from the long-term
cross-kernel scheduling work.

## Coordination With WGPU Migration

This document must be read together with
[`WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md).

The priority order is:

```text
WGPU viewport boundary first
  -> thin DeviceReport protocol
  -> existing WGPU backend reports become shared DeviceReport output
  -> ONNX/local model reports join the same vocabulary
  -> FFmpeg hardware acceleration later, behind probe/report/fallback
  -> cross-kernel registry and scheduler last
```

Do not build a heavy global GPU manager before the WGPU viewport path is stable.
That would create a second architecture that image edit, grade preview, and
video preview would later have to bypass or rewrite.

The short-term role of this plan is to define the common reporting vocabulary.
The short-term role of the WGPU plan is to move heavy visual surfaces behind a
stable viewport/resource boundary.

Decision authority:

| Question | Source Of Truth |
| --- | --- |
| Which surfaces move to WGPU first? | `WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md` |
| How should a run report requested vs actual device? | This document |
| Should there be a global scheduler now? | This document: no, reporting first |
| Should WGPU wait for a global scheduler? | WGPU plan: no, viewport boundary first |
| When should ONNX/FFmpeg join the shared device layer? | After WGPU viewport reports use the shared vocabulary |

## Why A Single Global GPU Switch Is Not Enough

Windows can identify a GPU, but every runtime has its own compatibility layer:

| Area | GPU path | Compatibility depends on |
| --- | --- | --- |
| Grade kernel | `wgpu` / D3D12 / Vulkan / WebGPU-style compute | adapter availability, driver, shader support, texture limits |
| ONNX helper models | ONNX Runtime providers such as CUDA / DirectML / CPU | ORT build, provider availability, driver, model ops |
| External model plugins | CUDA / CPU / provider-specific backends | plugin contract, runtime build, driver, VRAM |
| FFmpeg | software decode/encode, later hardware decode/encode | codec, encoder support, NVENC/QSV/AMF/D3D11VA, driver |
| WebView UI | browser GPU compositing / canvas / WebGL | WebView2 GPU status and browser sandbox |

So the app can detect hardware globally, but each kernel still needs its own
runtime probe and fallback.

## Product Contract

Every accelerated operation should expose the same user-facing truth:

```text
requested device: auto | cpu | cuda | gpu
actual device: cpu | cuda | wgpu | directml | ffmpeg_sw | ffmpeg_hw | provider
fallback reason: optional text
```

The exact runtime can differ by kernel, but the reporting shape should be
consistent.

## Short-Term Plan: Thin Unified Device Contract

Goal: make device behavior transparent without changing core scheduling.

This phase must not block WGPU viewport migration. It should provide the
`DeviceReport` shape that WGPU, ONNX, FFmpeg, and external plugins can all emit
as they mature.

### Step 1: Inventory Current Device Fields

List every existing place that already has `engine`, `device`, `precision`,
`provider`, or fallback reporting.

Expected areas:

- image enhance
- refine mask edge
- match light color
- detail watchdog
- detail repaint
- subject mask / matte
- grade preview / imageGrade
- video decode / trim / assemble
- future timeline export

Output:

- a small table in docs or code comments mapping each node to:
  - requested device field
  - actual device report field
  - fallback field
  - runtime backend

### Step 2: Normalize Report Names

Adopt common names where possible:

```ts
type DeviceRequest = "auto" | "cpu" | "cuda" | "gpu";

type DeviceUsed =
  | "cpu"
  | "cuda"
  | "wgpu"
  | "directml"
  | "ffmpeg_sw"
  | "ffmpeg_hw"
  | "provider"
  | "unknown";

type DeviceReport = {
  requested?: DeviceRequest;
  used: DeviceUsed;
  backend?: string;
  accelerated: boolean;
  fallbackReason?: string;
};
```

This type does not force every backend into one implementation. It only gives
the UI and run reports one vocabulary.

### Step 3: Keep Existing Kernel-Specific Resolution

Do not rewrite runtime selection yet.

Each kernel keeps its own resolver:

- grade: `auto -> wgpu if available -> cpu`
- ONNX: `auto -> CUDA/DirectML if available -> CPU`
- FFmpeg: `auto -> vendored native software path`, with hardware acceleration
  introduced later only after tests
- external model plugins: plugin-owned resolver, but the app still requires a
  `DeviceReport` from the plugin boundary

The short-term work is reporting and consistency, not central scheduling.

For WGPU viewports, the resolver can remain local to the viewport/grade path:

```text
viewport request: auto | gpu | cpu
  -> WGPU adapter/path if available
  -> CPU fallback if not
  -> emit DeviceReport
```

That report flows into the same UI/run diagnostics as later ONNX and FFmpeg
reports.

### Step 4: UI Transparency

Show the result near node reports and capability panels:

```text
Device: auto -> cuda
Backend: onnxruntime CUDAExecutionProvider
Accelerated: yes
```

Fallback example:

```text
Device: cuda -> cpu
Reason: CUDA provider unavailable
```

Rules:

- Do not silently hide fallback.
- Do not label something "GPU" unless the report proves it.
- Keep CPU fallback acceptable and expected, not an error state by itself.

### Step 5: Capability Probe Summary

✅ (existing probes) `summarizeCapabilities` in
`studio-ui/src/runtime/capabilitySummary.ts` flattens the engine probe report
(CUDA devices, torch, onnxruntime providers, model cache, per-card engine
availability) into diagnostic lines, surfaced in the Model Manager's local
tab behind a manual "Check engines" button. wgpu adapter status and FFmpeg
vendored/hardware status join the same summary once their probes exist.

Add or refine a single capability summary that aggregates existing probes:

- detected display adapters
- wgpu adapter status
- ONNX providers
- FFmpeg vendored library status
- future FFmpeg hardware encoder availability
- external model plugin device status, when a plugin is installed

This should be a diagnostic snapshot, not the source of truth for every run.
Per-run reports still matter because a model can fail on GPU due to memory,
unsupported ops, or a specific codec.

### Step 6: Tests

Short-term tests should verify:

- `auto` always produces an actual `used` value
- explicit `cpu` never reports `cuda`
- explicit `cuda` reports a fallback reason if CUDA is unavailable
- grade GPU fallback to CPU is visible
- FFmpeg reports vendored native software path
- reports are serializable and stable across UI/Rust boundaries

This phase is mostly contract testing, not performance testing.

## Medium-Term Plan: Runtime-Specific Hardening

Goal: make each accelerated backend robust before unifying scheduling.

### Grade Kernel

- Keep CPU as the reference path.
- GPU preview can be default when available.
- GPU output remains tolerance-tested against CPU.
- Add clearer `backend: "gpu" | "cpu"` report for every grade preview/render.
- Cache GPU pipelines for interactive sliders.
- ✅ Add fallback reasons — `GpuError` distinguishes no adapter, shader
  compilation failed (validation error scope around plan build), surface too
  large (device storage-buffer limits), GPU readback failed, and device
  errors; each surfaces verbatim as the reported CPU-fallback reason.

### ONNX Helpers

- Keep ONNX session cache in Rust.
- ✅ Support provider order by request — `OnnxDeviceRequest` (`onnx_pool`)
  parses the node's `device` param and `resolve_provider` applies the
  contract: `cpu` -> CPU only (honoured, no reason); `cuda` -> CUDA else CPU
  fallback with reason; `auto` -> preferred accelerator else CPU fallback
  with reason. The current build carries the CPU provider only, so cuda/auto
  resolve to CPU with distinct visible reasons; accelerated providers slot
  into the resolver when compiled in.
- Consider DirectML only after the CUDA/CPU contract is stable.
- Report model path, provider, and fallback reason.

### External Model Plugins

- The core app no longer owns Python/Torch runtime paths after Phase 7.
- Heavy Torch/Diffusers-style engines may return later only as external plugins
  or separately managed services.
- Preserve `device` and `precision` truthfulness at the plugin boundary:
  - requested vs actual device
  - requested vs actual precision
- Do not let any plugin become the core GPU scheduler.
- A missing plugin is normal and must not break native Rust image/PSD/video
  workflows.

### FFmpeg

- Treat vendored software FFmpeg as the stable baseline.
- Do not enable hardware decode/encode by default until:
  - codec support is probed
  - output parity is acceptable
  - fallback to software is tested
- Hardware acceleration should be per-operation:
  - decode
  - encode
  - filter graph
  - mux

## Long-Term Plan: Cross-Kernel Device Manager

Goal: coordinate GPU resources across grade, model inference, video, and export
after the main product paths are stable.

This is intentionally not the first step.

### Long-Term Step 1: Central Device Registry

Create a Rust-side registry that records:

- adapters
- runtime providers
- GPU memory hints where available
- supported FFmpeg encoders/decoders
- ONNX providers
- external model plugin device status, when installed
- wgpu adapter limits

This registry should not force every kernel to use the same API. It is a shared
source of diagnostic truth and capability summaries.

### Long-Term Step 2: Shared Resource Classes

Classify operations by resource class:

```text
interactive ui
preview gpu
full-res render gpu
model inference gpu
video decode
video encode
audio cpu
file io
network api
```

This extends the existing executor lane idea rather than replacing it.

### Long-Term Step 3: GPU Queue Policy

Possible policy:

- one full-resolution GPU compute job at a time
- previews are latest-wins and cancellable
- playback decode must not stall on model inference
- export jobs can queue
- CPU fallback is allowed when GPU is busy or unavailable

Do not over-engineer this before video/timeline/export are real product paths.

### Long-Term Step 4: Memory And Failure Handling

Add structured fallback for:

- out of memory
- unsupported shader/model op
- unsupported codec
- driver/device lost
- timeout
- worker crash

The important behavior is not "GPU always wins". The important behavior is that
the app stays alive, reports the truth, and produces a usable result.

### Long-Term Step 5: User Controls

Only after the manager exists, consider a settings surface:

- global default: auto / prefer GPU / prefer CPU
- per-kernel overrides
- disable unstable hardware encode
- max concurrent GPU jobs
- prefer preview speed vs export fidelity

This should be a settings surface, not a required setup wizard.

## What Not To Do Now

- Do not build a giant GPU manager before the product paths are stable.
- Do not remove explicit CPU choices.
- Do not make CUDA the only accelerator story.
- Do not make FFmpeg hardware acceleration default just because the GPU exists.
- Do not hide fallback.
- Do not let every node invent its own UI wording for device reports.
- Do not treat a successful device probe as proof every future run will succeed.

## Recommended Implementation Order

1. Keep WGPU viewport migration as the heavy-pixel mainline.
2. ✅ Document current device fields and reports (inventory table in
   `studio-ui/src/runtime/deviceReport.ts`).
3. ✅ (TypeScript side) Add shared report vocabulary: `DeviceRequest`,
   `DeviceUsed`, `DeviceReport` + `deviceReportFromEngineReport` /
   `deviceReportFromViewportBackend` normalizers. Rust-side vocabulary still
   pending.
4. ✅ (node reports) Formalize existing backend reports as shared
   `DeviceReport`: after every run the run log shows one
   `device requested -> used (backend; fallback)` line per node whose
   `*_report` output carries engine telemetry
   (`logDeviceReports` in `useStudioRunController`). Viewport frames have a
   normalizer; wiring their frames into the same log is part of the WGPU
   surface work.
5. ✅ (viewport surfaces) Normalize UI display of requested/used/fallback:
   the grade panel's backend badge and the program monitor's frame badge now
   render from the shared `DeviceReport` (label from `used`, tooltip with
   `requested -> used` + fallback reason, and a visible ⚠ marker on fallback
   instead of silently hiding it). Node-report/capability panels still pending.
6. ✅ (existing probes) Add or refine capability summary as diagnostics only:
   `summarizeCapabilities` + Model Manager "Machine capability" section.
   `probe_engines` now also carries `wgpu` (grade kernel adapter summary, or
   the init-failure reason) and `ffmpeg` (vendored libav software decode, or
   why not) `BackendProbe` lines. FFmpeg hardware encoders join behind their
   own probe.
7. ✅ Add contract tests for report behavior
   (`studio-ui/src/runtime/deviceReport.test.ts`: `auto` always yields a
   `used`, explicit `cpu` never reports `cuda`, fallback stays visible).
8. ✅ (grade kernel) Harden remaining WGPU fallback reasons and reports:
   `apply_grade_doc` now returns `GradeBackend { name, fallback_reason }` —
   a failed adapter/device init is cached with its reason, and a per-run GPU
   apply failure reports why — so `grade_report`, `GradePreviewResult`,
   viewport frames and `timeline_export` all carry
   `backend_fallback_reason` instead of silently reporting `cpu`. Remaining
   WGPU-surface reasons (texture too large, shader compile) land with the
   viewport migration.
9. ✅ (subjectMask) Harden ONNX provider reporting: an `auto_*` mode's
   `matte_report` now carries engine telemetry (`engine: onnxruntime|cpu`,
   `device`, `device_requested`, `engine_fallback_reason` — CPU execution
   provider today, or the builtin fallback when no weights resolve), and the
   run log's `deviceReportFromNodeOutputs` reads `matte_report`. ORT
   CUDA/DirectML execution providers join when the runtime ships them.
10. ✅ Keep heavy model runtimes outside the core app; accept plugin reports
    only: the plugin boundary contract is `deviceReportFromPluginReport`
    (`PluginDeviceReportLike`: requested vs actual device + precision,
    fallback reason). A device/precision downgrade the plugin does not
    explain gets a synthesised reason, so a silent downgrade cannot pass the
    boundary. No plugin ships today; the contract is ready for when one does.
11. ✅ Keep FFmpeg software native as baseline: `videoAssemble`'s
    `assemble_report` now carries engine telemetry (`engine: ffmpeg`,
    `device: ffmpeg_sw`, `device_requested: auto`, and a visible reason that
    hardware encode is not enabled), the run log reads `assemble_report`, and
    `ffmpeg_sw` is classified as the non-accelerated baseline in the shared
    vocabulary. Hardware encode joins per step 12.
12. Add hardware FFmpeg only behind explicit probe/report/fallback.
13. Build cross-kernel device registry later.
14. Build GPU queue/memory policy only after timeline/export workloads demand it.

## Success Criteria

Short term:

- The user can see what device each node requested and actually used.
- `auto` is the default.
- CPU fallback is explicit and non-mysterious.
- Root-level builds do not require manual FFmpeg env setup.
- Reports use one vocabulary across nodes.

Long term:

- GPU preview, model inference, video playback, and export do not starve each
  other.
- Hardware acceleration is optional, testable, and reversible.
- Driver or provider differences degrade gracefully.
- The app remains stable on CPU-only, NVIDIA, AMD, and Intel machines.
