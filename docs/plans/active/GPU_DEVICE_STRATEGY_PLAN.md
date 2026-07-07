# GPU / Device Strategy Plan

> Status: active. Short-term reporting steps 1–4 of the recommended order have
> started landing: the device-field inventory, the shared TypeScript
> `DeviceReport` vocabulary, and normalizers for the local-engine `*_report`
> outputs and viewport `ViewportBackend` frames live in
> `studio-ui/src/runtime/deviceReport.ts`, and every run now logs a per-node
> `device requested -> used (backend; fallback)` line, and the grade panel /
> program monitor backend badges render from the same vocabulary with
> fallbacks kept visible, and the Rust-side vocabulary mirror lives in
> `src-tauri/src/studio/device_report.rs`. Remaining: capability-summary
> refinement and the medium/long-term hardening below.

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
[`WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md).

## Zero-Copy Presentation Is A Hard Product Target

The previous WGPU surface work treated PNG/blob transport as an acceptable
desktop fallback. That is no longer the long-term target. For H-Gripe Studio's
image editor, grade preview, program monitor, crop/mask preview, and later
video editing surfaces, the product target is:

```text
interactive desktop frame
  -> no PNG encode
  -> no base64/blob frame payload
  -> no GPU -> CPU -> WebView round trip
  -> present through a native GPU surface or an equivalent zero-copy texture path
```

CPU/software paths may remain for correctness, tests, export parity, unsupported
machines, and explicit user fallback, but they must not be described as the
final interactive presentation path.

### Required Surface Adapter Strategy

The surface path must stop selecting a generic high-performance adapter first
and only then testing whether it can present to the viewport HWND. That order can
fail on hybrid-GPU and driver-specific machines: the adapter can be valid for
compute but invalid for the child-window surface, producing errors such as
`surface is not supported by the shared adapter`.

The correct probe order is:

1. Create a real probe/presentation surface for the target window class
   (Windows child HWND today).
2. Request the WGPU adapter with that surface as `compatible_surface`.
3. Prefer the best surface-compatible adapter, not merely the best compute
   adapter.
4. Cache a `SurfacePresentationProfile` for the session:
   - supported / unsupported
   - adapter name and backend
   - surface format / present mode
   - failure reason when unsupported
5. Route every heavy viewport through that profile. Do not re-probe on every
   mouse move, scroll, resize, slider tick, or frame.
6. If the WebView-underlay child surface cannot be supported on a machine,
   the next product path is a WGPU-owned native viewport/window composition
   strategy, not accepting PNG/blob as the final answer.

This means the current fallback caching is only a stability fix. The next
implementation step must be a surface-compatible adapter selector and a visible
diagnostic panel that says exactly why a machine is or is not in the zero-copy
profile.

### Required Video / FFmpeg Zero-Copy Strategy

Vendored FFmpeg already means the app does not depend on a system FFmpeg,
vcpkg, pkg-config, or CI downloads. It does not automatically mean video decode
is zero-copy.

For video, there are three different levels:

| Level | Meaning | Status / Requirement |
| --- | --- | --- |
| Vendored software FFmpeg | Decode/encode through local libav DLLs and Rust FFI. | Baseline already local and controlled. |
| Hardware FFmpeg session | Use a hardware decoder/encoder such as D3D11VA/DXVA2/NVDEC/QSV/AMF when compiled and accepted by the driver. | Must remain explicit/probed/reporting until stable. |
| True video zero-copy | Hardware decoder outputs GPU frames that are imported or presented without CPU readback/upload. | Future hard target for playback/program monitor; requires FFmpeg HW frames + D3D/WGPU interop or a native compositor path. |

So "FFmpeg is local" and "video preview is zero-copy" are not the same claim.
The former is already true. The latter requires a dedicated hardware-frame path:

```text
vendored FFmpeg hw decode
  -> AVHWDeviceContext / AVHWFramesContext
  -> D3D11/D3D12 texture-backed frame
  -> WGPU/native compositor import or same-GPU presentation
  -> grade/preview surface
```

If a frame has to become `RgbaImage` and then be uploaded to WGPU, that path is
not true decode zero-copy, even if presentation afterward is native.

Phase 1 of this route is in `ffmpeg_native`: a D3D11VA hardware session
(`Decoder::open_d3d11va`, selectable per-operation as the `d3d11va` decoder
name) decodes to `AV_PIX_FMT_D3D11` GPU texture frames, `decode_d3d11_frame`
hands out the `ID3D11Texture2D` + array-slice handle the WGPU import will
consume, and the registry's `ffmpeg_d3d11va` entry reports the
"driver/session accepted" level (device created) separately from the
compiled-in decoder list. Until the phase-2 texture import lands, hardware
sessions read frames back once through `av_hwframe_transfer_data` — reported,
not silent, and not claimed as zero-copy.

Phase 2 of this route is `d3d11_wgpu`: `import_d3d11_frame` bridges a decoded
hardware frame into the WGPU Dx12 device without CPU readback — a BGRA8
texture created raw on WGPU's D3D12 device with `HEAP_FLAG_SHARED`, opened on
FFmpeg's D3D11 device through an NT shared handle, filled by the D3D11 video
processor (`VideoProcessorBlt`, fixed-function NV12->RGB on the GPU), fenced
with a D3D11 event query, and wrapped as a `wgpu::Texture` via `wgpu-hal`.
The registry's `d3d11_wgpu_interop` entry reports this third level ("zero-copy
texture path") from the recorded outcome of the first actual import — proven,
not assumed.

Phase 3 wires the import to presentation: a video viewport target that opts
in with `decodeDevice: "gpu"` and asks for the frame verbatim (no grade, no
denoise, no overlay, identity view) presents through
`try_present_hw_video_frame` -> `viewport_surface::present_hw_frame` — the
decoded D3D11 frame is imported into the shared WGPU device and blitted to
the native surface directly, with no CPU readback, no upload, and no PNG.
Any other request (a grade doc, a zoomed view, a machine where decode or
import refuses) falls back to the CPU render path with the reason on stderr
and the import outcome in the registry. The opt-in default stays software;
the CPU path remains the explicit, reported fallback.

### Done Means

Do not mark the zero-copy work complete until:

- the surface adapter is selected using the actual presentation surface;
- the device registry reports the zero-copy profile separately from generic
  display adapters;
- image edit, grade preview, program monitor, and crop/mask preview can run
  interactive frames without PNG/blob transport on supported machines;
- unsupported machines get a single structured reason, not repeated terminal
  spam;
- FFmpeg hardware decode/encode probes distinguish "compiled in",
  "driver/session accepted", and "zero-copy texture path available";
- the user can open a diagnostics panel and see why the current machine is or is
  not using zero-copy.

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

- ✅ detected display adapters — `display_adapters()` in
  `src-tauri/src/studio/wgpu_device.rs` enumerates every adapter across the
  compiled wgpu backends on a throwaway instance (never the shared device),
  joins the `EngineProbeReport` as `display_adapters`, and renders as a
  "display adapters" summary line (feature-off / no-adapter reasons stay
  visible as warn lines).
- ✅ wgpu adapter status
- ✅ ONNX providers
- ✅ FFmpeg vendored library status
- FFmpeg hardware encoder/decoder availability (`ffmpeg hw encoders` /
  `ffmpeg hw decoders` summary lines)
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
- ✅ Report model path, provider, and fallback reason — `SubjectSegmenter`
  exposes `model_path()` (the weight file(s) inference ran on; encoder +
  decoder for SAM 2) and `matte_report.model_path` carries it alongside the
  existing `provider` / `engine_fallback_reason`; absent for weight-free
  lanes (manual/hybrid and the builtin fallback).

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

Done: `JobCategory` in `studio/schedule.rs` is the resource-class vocabulary,
mapped from the list above onto the lanes the app actually has today:

- interactive ui → the frontend / `CpuLight` graph logic (never gated)
- preview gpu → the shared viewport surface device (its own lazy-init path)
- full-res render gpu / model inference gpu → `Gpu` (`Semaphore(1)`)
- video decode → the playback engine's dedicated decode thread (latest-wins,
  its own lane distinct from the scheduler)
- video encode → `VideoEncode` (`Semaphore(1)`, its own permit so an
  assemble/trim encode serialises against other encodes but does not block
  model inference on the GPU gate)
- audio cpu / file io → `CpuBound` (bounded pool)
- network api → `Network` (ungated locally, bounded by the provider)

New classes join by extending `JobCategory` + `node_class`, not by a parallel
mechanism.

### Long-Term Step 3: GPU Queue Policy

Possible policy:

- ✅ one full-resolution GPU compute job at a time — the `Gpu` lane is
  `Semaphore(1)` in `StudioScheduler`.
- ✅ previews are latest-wins and cancellable — the grade preview renders
  through `latestWinsGate` (`useGradeViewport.ts`): at most one render in
  flight and one queued, a stacked slider drag supersedes the queued render
  before it dispatches; the playback engine's scrub queue is latest-wins the
  same way (`coalesce_latest`).
- ✅ playback decode must not stall on model inference — the playback engine
  runs on its own dedicated decode thread, outside the scheduler's GPU gate.
- ✅ export jobs can queue — `VideoEncode` is its own `Semaphore(1)`; queued
  encodes wait on the permit without holding the GPU gate.
- ✅ CPU fallback is allowed when GPU is busy or unavailable — every GPU path
  (viewport surface, grade kernel, ONNX providers, FFmpeg hw decode) carries
  a reported CPU/software fallback.

Do not over-engineer this before video/timeline/export are real product paths.

### Long-Term Step 4: Memory And Failure Handling

Add structured fallback for:

- ✅ out of memory / unsupported op on the shared surface device — the shared
  viewport surface device registers `on_uncaptured_error` at creation
  (`wgpu_device.rs`): wgpu's default handler panics on uncaptured GPU errors,
  the shared device instead records the classified error (out-of-memory /
  validation / internal + driver description) and keeps the app alive — the
  failing present falls back to the PNG transport, and the device registry
  keeps the last error visible (`viewport_surface_last_error`, a warn line in
  the Model Manager). The grade kernel's own device already scopes these per
  run (`GpuError`).
- ✅ unsupported codec (decode side) — when a container carries a video
  stream whose codec has no decoder compiled into the vendored libav,
  `Decoder::open` reports `unsupported codec '<name>': no decoder compiled
  into the vendored libav` (`undecodable_stream_reason` in
  `ffmpeg_native.rs`) instead of the generic "no decodable video stream
  found"; the encode side already names the codec
  (`assemble_rejects_unknown_codec`).
- ✅ driver/device lost — the shared viewport surface device registers a
  `set_device_lost_callback` at creation (`wgpu_device.rs`); a loss records
  the structured reason class + driver message once, `shared_gpu()` then
  reports the device unavailable with that reason (every present downgrades
  to the PNG transport, placement reports carry the reason, and the device
  registry's viewport-surface entry shows it) instead of silently failing
  every frame against a dead device.
- ✅ timeout — a scrub waits at most `SCRUB_TIMEOUT` (30s) for the decode
  thread (`scrub_blocking` uses `recv_timeout`); a wedged worker yields a
  structured "playback engine timed out" error instead of blocking a command
  thread forever.
- ✅ worker crash — a decode-thread panic surfaces as "playback engine worker
  crashed" on the waiting scrub (the reply channel drops during the unwind),
  and `scrub_frame` detects the finished thread (`worker_crashed`) and
  respawns the engine on the next scrub instead of returning "stopped"
  forever.

The important behavior is not "GPU always wins". The important behavior is that
the app stays alive, reports the truth, and produces a usable result.

### Long-Term Step 5: User Controls

Only after the manager exists, consider a settings surface:

- ✅ global default: auto / prefer GPU / prefer CPU — a "Default device"
  select in the Model Manager's local tab (`runtime/devicePreference.ts`,
  localStorage-backed). It only seeds *unset* `device` params (node executors
  and the export dialog's initial value); an explicit per-node choice always
  wins, and every request still goes through the same probe/report/fallback
  paths.
- per-kernel overrides — the per-node `device` param already is this;
  a dedicated settings surface can wait.
- disable unstable hardware encode — hardware encode is already opt-in per
  request (`device: gpu`); a global kill switch waits for real demand.
- ✅ max concurrent GPU jobs — a "Max concurrent GPU jobs" select next to the
  default-device control (`bridge/scheduler.ts`, localStorage-backed,
  re-applied on app start). The Rust `StudioScheduler`'s GPU semaphore is
  resizable (`set_gpu_limit`, clamped `1..=MAX_GPU_JOBS`): widening adds
  permits immediately, narrowing retires permits as running jobs finish —
  work is never interrupted.
- ✅ prefer preview speed vs export fidelity — a "Preview quality" select next
  to the other controls (`runtime/previewQuality.ts`, localStorage-backed).
  It only picks the grade preview proxy's long-edge size (speed = the
  historical 1280, fidelity = 2560) for the grade viewport and the
  `grade_preview` bridge defaults; exports never read it and always run at
  full fidelity.

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
3. ✅ Add shared report vocabulary: `DeviceRequest`, `DeviceUsed`,
   `DeviceReport` + `deviceReportFromEngineReport` /
   `deviceReportFromViewportBackend` normalizers on the TypeScript side, and
   the mirrored Rust-side vocabulary in `src-tauri/src/studio/device_report.rs`
   (`DeviceRequest` / `DeviceUsed` enums + the ACCELERATED classification,
   contract-tested against the TS wire strings) that report producers spell
   their `device` / `device_requested` values from.
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
   instead of silently hiding it). Node cards and the Inspector show the same
   report: after a run each reporting node's card header carries a
   `NodeDeviceBadge` (used device, ⚠ on fallback, full line as tooltip) and
   the Inspector shows a "Device (last run)" line.
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
   `backend_fallback_reason` instead of silently reporting `cpu`. The
   remaining WGPU reasons are covered too: the grade kernel reports shader
   compilation failures (`GpuError::ShaderCompilation`, validation error
   scope around plan build) and oversized surfaces
   (`GpuError::SurfaceTooLarge` against the storage-buffer limits), and the
   viewport surface path guards frame uploads against the device's 2D
   texture size limit (`frame_within_texture_limit`) so an oversized frame
   downgrades to the PNG transport with its reason logged instead of
   tripping a wgpu validation error.
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
12. Add hardware FFmpeg only behind explicit probe/report/fallback. Probe half
    landed: `probe_engines` carries `ffmpeg_hw` (hardware encoders compiled
    into the vendored libav via `avcodec_find_encoder_by_name` — nvenc / qsv /
    amf / mf, or the reason none exist) and `ffmpeg_hw_decode` (hardware
    decoders via `avcodec_find_decoder_by_name` — cuvid / qsv), and the
    capability summary shows `ffmpeg hw encoders` / `ffmpeg hw decoders`
    lines. Fallback half landed for `videoAssemble` and `videoTrim` (shared
    `video_engine::encode_with_device`): an explicit `device: gpu` request
    tries the first compiled-in hardware H.264 encoder and falls back to the
    software baseline with the failure reason kept visible on the node report
    (`device: ffmpeg_hw` only on success); `auto`/`cpu` stay on the software
    baseline. Decode fallback landed for `videoTrim` (shared
    `video_engine::decode_with_device`): an explicit `device: gpu` request
    tries the compiled-in hardware decoder matching the input codec and
    retries on the software decoder with the reason kept visible
    (`decode_device` / `decode_fallback_reason` on `trim_report`, and the
    run log's device line reads `trim_report` too, appending a
    `decode ffmpeg_sw/ffmpeg_hw` note with its fallback reason); playback
    scrubbing stays on the software baseline. Timeline export joined too:
    the export dialog's device select passes through `timeline_export` into
    the `videoAssemble` executor and the result surfaces `encode_device` /
    `encode_fallback_reason` (hardware note on success, fallback warning on
    an unmet gpu request).
13. Done: `studio/device_registry.rs` is the central device registry
    (Long-Term Step 1) — one `device_registry_snapshot` command records the
    enumerated display adapters with their wgpu limits (`Adapter::limits()`;
    wgpu exposes no memory size, so limits are the recorded capacity hint),
    the grade wgpu / viewport surface / vendored FFmpeg backend status, the
    compiled-in FFmpeg hardware encoder/decoder names, and the onnxruntime
    execution providers. Diagnostics only: a snapshot never initialises the
    viewport surface device (cached state read only) and per-run
    DeviceReports stay the source of truth. The Model Manager renders it
    below the capability summary on the same manual refresh.
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
