# Python to Rust Migration Plan

## Core Decision

H-Gripe Studio should move toward a zero-Python desktop runtime.

This does not mean deleting `python/bridge` immediately. The safe path is to first
turn the current Python code into a reference implementation, replace each runtime
bridge with native Rust, verify output parity, and only then remove Python from
the app, package, CI, and documentation.

The long-term architecture is:

- React / XYFlow owns the visual node editor and panels.
- Tauri owns the desktop shell, filesystem access, local commands, and packaging.
- Rust owns pixel buffers, video, colour management, PSD I/O, local model
  inference, scheduling, caching, and export.
- Cloud APIs own large model generation and editing.
- Small local models are optional helpers, preferably through ONNX / `ort`, not
  Python Torch / Diffusers inside the core app.

## Final Acceptance Criteria

The migration is complete only when all of these are true:

- The desktop app runs on a clean machine with no `python`, `python3`, or
  `python_embeded` runtime available.
- No Tauri command spawns a Python process.
- The packaged app no longer bundles `python/bridge`, `custom_nodes`, ComfyUI
  remnants, or `third_party/psd_tools`.
- `tauri.conf.json` resources contain only Rust/native app assets, models, and
  required vendored native libraries.
- Rust tests cover the previous Python bridge contracts.
- Key image, mask, PSD, and video outputs are checked against golden fixtures.
- Third-party API profile and credential support remains intact. Removing the
  old H-Gripe account/cloud system must not remove API provider settings.

## Current Python Runtime Responsibilities

Python is still used for several real runtime paths:

- PSD inspection, analysis, and composition through `python/bridge/*psd*_cli.py`
  and `third_party/psd_tools`.
- Local image cards such as colour matching, edge refinement, detail watchdog,
  detail repaint, and non-default image enhancement engines.
- Video probing, frame decoding, trim, and assembly through PyAV workers.
- Torch / Diffusers model backends such as RealESRGAN, CCSR, SupIR, SD inpaint,
  SDXL inpaint, and Flux Fill.
- Device and engine probing for Python-backed optional engines.
- Packaging, because the current Tauri bundle still includes Python bridge
  resources.

These should be treated as migration targets, not dead files.

## Migration Principles

1. Freeze contracts before replacing code.

   For each Python CLI, preserve its input JSON, output JSON, output files, error
   shape, and default parameter behavior until the Rust replacement is verified.

2. Replace one runtime path at a time.

   A mixed state is acceptable while migrating, but the default path should move
   steadily from Python to Rust.

3. Keep Python only as a temporary parity oracle.

   During migration, Python can be used in tests to generate golden fixtures.
   It should not remain a normal app dependency.

4. Do not port heavy Torch / Diffusers first.

   The product is API-first. Local small models should serve practical tasks such
   as subject masking, matting, defect detection, and lightweight harmonization.
   These are better suited to ONNX / `ort` in Rust. Large local generation stacks
   can be removed from the core or moved to an optional external plugin later.

5. PSD compatibility should be production-driven.

   The goal is not to clone all of Photoshop's file-format surface immediately.
   The goal is to support the production subset H-Gripe actually needs: layers,
   masks, bounds, opacity, basic blend behavior, placeholders, smart-object style
   replacement where required, previews, metadata, and export round-trip.

6. The UI contract must not change because the backend changes.

   Existing cards, ports, reports, and workflow behavior should continue to work
   unless a planned product decision removes them.

## Phase 0: Inventory and Safety Rails

Goal: make it impossible to delete useful Python accidentally.

Tasks:

- List every Rust call site that shells out to `python/bridge`.
- List every Python CLI and the node/card that depends on it.
- Mark Python-only features as `legacy-python` in docs or internal comments.
- Add golden fixtures for representative image, mask, PSD, and video workflows.
- Add a test mode that can compare Rust output against current Python output.
- Define a temporary compatibility feature such as `python-bridge-compat` if
  needed, but do not make it the long-term default.

Do not delete:

- `python/bridge`
- `third_party/psd_tools`
- `torch_worker`
- `video_worker`

These are still needed until replacement paths pass parity checks.

## Phase 1: Rename the Mental Model

Goal: make "local" mean native/local execution, not Python.

Tasks:

- Update executor wording so local cards are described as native compute, API
  compute, or external legacy bridge.
- Keep API provider profile and credential logic separate from any removed
  account/cloud logic.
- Replace project-root checks that accept `python/bridge` as a valid root with a
  stable H-Gripe project marker.
- Make the node registry describe execution lanes by real cost: API, compute,
  media, file, and lightweight UI/helper work.

Why this matters:

If the code still treats `python/bridge` as the project identity, Python cannot
be truly removed later without breaking packaging and root resolution.

## Phase 2: Replace Video Python First

Goal: remove PyAV from normal video playback and export.

Current Python paths:

- `video_probe_cli.py`
- `video_worker.py`
- Rust `video_worker`
- PyAV fallback inside the media engine

Rust target:

- Make the native FFmpeg backend the default desktop path.
- Keep vendored FFmpeg libraries maintained locally.
- Implement native probe, frame decode, poster generation, trim, and assemble.
- Preserve current report shapes for video cards.
- Remove PyAV fallback after native coverage is proven.

Why this should come early:

Video has a clean boundary: input file, timestamps/ranges, output frames or
clips. It is also one of the biggest packaging wins because PyAV pulls in a
large Python dependency chain.

## Phase 3: Replace CPU Image and Mask Nodes

Goal: move common image production nodes fully into Rust.

Suggested order:

1. `image_enhance_cli.py`

   The default CPU path already has a Rust implementation. Finish parity for
   colour-managed inputs, DPI, ICC handling, resizing, sharpening, reports, and
   file output behavior. Non-CPU learned engines should be removed from core or
   moved to optional external engines.

2. `edge_refine_cli.py`

   Move erosion, dilation, feathering, guided refinement, alpha cleanup, and
   edge decontamination into Rust using shared pixel/mask operations.

3. `color_match_cli.py`

   Move histogram/statistical matching, prompt suffix generation, colour
   transfer, LUT-style correction, and brand-colour protection into Rust. Use the
   existing colour pipeline and `moxcms` work instead of Python imaging stacks.

4. `detail_watchdog_cli.py`

   Move rule-based checks into Rust first. Optional learned detection should use
   ONNX through `ort`.

5. `detail_repaint_cli.py prepare/composite`

   Move crop extraction, mask preparation, padding, feathering, blend-back, and
   report generation into Rust. Actual repaint generation can stay API-first.

## Phase 4: Local Small Models Through Rust

Goal: keep local helper models without bringing Python back.

Use Rust-native model paths for:

- subject segmentation
- SAM-style point refinement
- ViTMatte-style matting
- defect/detail detection
- lightweight colour or harmonization models if useful

Preferred runtime:

- ONNX through `ort`
- cached sessions
- explicit model manager paths
- CPU first, then optional GPU providers where stable

Avoid in the core app:

- Python Torch
- Diffusers
- CUDA-only model assumptions
- workflows that require users to debug Python wheels

This matches the product direction: cheap cloud APIs for heavy generation, small
local models for practical no-cost editing assistance.

## Phase 5: Replace PSD Python Last

Goal: remove `psd_tools` only after H-Gripe can read and write the PSD subset it
actually needs.

Minimum Rust PSD capability:

- inspect template dimensions
- list layers and groups
- read layer bounds
- read layer names
- read masks where needed
- identify placeholders
- replace or compose generated images into placeholders
- write layered PSD/PSB output for Photoshop cleanup
- write preview image and metadata sidecar
- preserve enough structure that the file remains useful in Photoshop

Recommended approach:

1. Start with a Rust PSD metadata reader for the templates used in real
   workflows.
2. Implement a minimal layered PSD writer/exporter.
3. Add round-trip fixtures for real templates.
4. Add smart-object or placeholder replacement only for the subset H-Gripe uses.
5. Delete `third_party/psd_tools` only after all PSD nodes pass Rust fixtures.

Risk:

PSD is harder than masks and image math. The danger is not Rust performance. The
danger is incomplete file-format behavior. This is why PSD should be migrated
after the rest of the runtime is already stable.

## Phase 6: Remove Torch / Diffusers From Core

Goal: avoid rebuilding the Python AI ecosystem inside Rust unless it is truly
needed.

Recommended decision:

- Do not port RealESRGAN, CCSR, SupIR, SD inpaint, SDXL inpaint, and Flux Fill
  directly as the first Rust migration.
- Keep API generation/editing as the primary high-quality generation path.
- Keep local Rust/ONNX helpers for no-cost practical operations.
- If a heavy local model becomes essential later, add it as a separate external
  engine/plugin with its own lifecycle.

Reason:

These engines are not the core competitive advantage. H-Gripe's advantage is the
production workflow: PSD-aware generation, mask/manual correction, colour,
timeline, node reproducibility, and API compatibility.

## Phase 7: Delete Python Runtime (done, 2026-07-03)

Executed as a full deletion: the Python bridge, `third_party/psd_tools`, the
torch plugin engines, and every legacy Python fallback are gone. All cards run
on the native Rust baselines only.

Tasks:

- [x] Remove Python bridge resource bundling from Tauri config.
- [x] Remove `python/bridge`.
- [x] Remove `third_party/psd_tools`.
- [x] Remove Python ComfyUI/update/custom-node remnants (`.ci/`,
  `plugins/torch-engines`).
- [x] Remove Rust modules whose only job is to launch Python workers
  (`torch_worker.rs`, `video_worker.rs`, the bridge CLI runners).
- [x] Remove Python-related CI, pytest, ruff, and `pyproject.toml`.
- [x] Remove references to `python_embeded`, `python`, and `python3` as runtime
  requirements.
- [x] Add a CI check (`no-python-spawn`) that fails if runtime code
  reintroduces a Python process launch or the deleted trees reappear.

Final check:

Run the desktop app, execute image, PSD, mask, video, and API workflows on a
machine with no Python installed. That is the real zero-Python milestone.

## Runtime Call-Site Inventory & Status (updated 2026-07-03)

This section tracks the P0–P5 mainline. Update it whenever a step lands.

### P0 — Remaining Python runtime call sites (done)

Every Rust site that can spawn a Python process today
(`apps/desktop-tauri/src-tauri/src/...`):

| Rust call site | Python entry point | Node / feature |
| --- | --- | --- |
| `psd/compose.rs` (`compose_psd`) | `compose_psd_cli.py` | PSD Export (fallback) |
| `psd/compose.rs` (`inspect_psd`) | `inspect_psd_cli.py` | PSD template validation |
| `psd/compose.rs` (`analyze_psd_context`) | `analyze_psd_cli.py` | PSD Context Analyze |
| `psd/cards.rs` (`match_light_color`) | `color_match_cli.py` | Light & Color Match (legacy engines) |
| `psd/cards.rs` (`refine_mask_edge`) | `edge_refine_cli.py` | Refine Mask Edge (legacy engines) |
| `psd/cards.rs` (`enhance_image` via `run_torch_cli`) | `image_enhance_cli.py` | Image Enhance (legacy engines) |
| `psd/cards.rs` (`detect_quality_issues`) | `detail_watchdog_cli.py` | Detail Watchdog (legacy engines) |
| `psd/repaint.rs` (`prepare_repaint_regions` / `composite_repaint`) | `detail_repaint_cli.py prepare/composite` | Detail Repaint (fallback) |
| `psd/repaint.rs` (`local_repaint_regions` via `run_torch_cli`) | `detail_repaint_cli.py repaint` | Detail Repaint local engines |
| `psd/engines.rs` (`run_device_probe`) | `device_probe_cli.py` | Engine capability report |
| `psd/engines.rs` (`run_engine_probe`) | card CLIs `--probe-engines` | Engine capability report |
| `psd.rs` (`run_bridge_oneshot`) | any bridge CLI (one-shot fallback) | torch CLI fallback |
| `studio/torch_worker.rs` | `torch_worker.py` | warm worker for legacy torch engines |
| `studio/video_worker.rs` | `video_worker.py` | PyAV worker (non-default builds only) |
| `commands/video.rs` (`video_probe_oneshot`) | `video_probe_cli.py` | video probe/scrub fallback |
| `studio/video_trim.rs` / `studio/video_assemble.rs` | `video_worker.py` | only without `native-ffmpeg` feature |

`python/bridge/hgripe_api_bridge.py` has no Rust call site (dead legacy shim).

### P1 — Default path per call site (done)

Rust-default (Python only as optional legacy engine or fallback):

- Image Enhance / Light & Color Match / Refine Mask Edge / Detail Watchdog:
  the default `cpu`/`rules` engine runs in-process native Rust
  (`image_enhance_cpu.rs`, `color_match_cpu.rs`, `edge_refine_cpu.rs`,
  `detail_watchdog_cpu.rs`); Python serves only opt-in legacy engines or
  sources the Rust loader cannot decode.
- Detail Repaint prepare/composite: native Rust fast path
  (`detail_repaint_cpu.rs`); Python only when the loader cannot decode.
- Video probe / scrub / trim / assemble: native FFmpeg (`ffmpeg_native.rs`,
  `native-ffmpeg` is a default feature); PyAV only in
  `--no-default-features` builds or as the one-shot fallback.
- Subject Mask / Matte: fully native Rust (`ort` ONNX), no Python at all.

Python-default (no Rust path yet):

- ~~Smart-object content replacement inside `compose_psd`~~ — native now
  (P3c below); every PSD command (inspect, analyze, pixel-layer compose,
  embedded smart-object replace) is native-default.
- Torch/Diffusers engines (`realesrgan`, `ccsr`, `supir`, `sd_inpaint`,
  `sdxl_inpaint`, `flux_fill`) and the ONNX legacy backends behind the
  bridge — opt-in only, never a default (P4 below).
- Engine/device capability probe — probes only the legacy Python engines;
  a box without Python simply reports them unavailable.

### P2 — UI / node report wording (done)

Bridge launch failures no longer read as a bare "python cli failed": every
spawn site now states the lane — "optional legacy Python bridge …
(the default engine runs natively in Rust)" for Rust-default cards and
"legacy PyAV …" for video fallbacks; the PSD commands (inspect, analyze,
compose) are all native-default now and use the same wording. The
`Executor` doc in `nodeSpecs.ts` describes `local` as native-Rust default +
optional legacy bridge.

### P3 — PSD (in progress, migrate last)

Done:

- **Inspect is native.** `inspect_psd` now runs a minimal read-only Rust
  PSD/PSB parser (`psd/inspect.rs`): it reads only the header + layer
  records (canvas size, layer names incl. Unicode `luni`, group dividers,
  smart-object markers) and never decodes pixel data. Output matches the
  Python CLI's golden output (fixture:
  `apps/desktop-tauri/src-tauri/tests/fixtures/inspect_template.psd`).
  `inspect_psd_cli.py` remains only as an optional legacy fallback when
  native parsing rejects an exotic file.
- **Analyze is native.** `analyze_psd_context` now runs the Phase-1
  heuristics natively (`psd/analyze.rs`): channel decoding (raw + PackBits
  RLE), a simple compositor for plain normal-mode layers over the white
  backdrop (matching psd_tools `composite()`), alpha-weighted colour
  statistics, median-cut palette, 3x3 light-direction, colour temperature,
  and the three artifact PNGs (placeholder mask, background preview,
  luminance histogram). Golden tests assert the exact `VisualContext`
  JSON of `analyze_psd_cli.py` on the shared fixture, and the artifact
  PNGs were verified pixel-identical to the Python CLI's output.
  `analyze_psd_cli.py` remains only as an optional legacy fallback when the
  native path rejects a file (non-RGB/8-bit modes, zip-compressed channels,
  non-trivial blending: masks, opacity < 100%, non-normal modes, clipping).
- **Compose (pixel-layer insert) is native.** `compose_psd` now runs a
  native Rust writer by default (`psd/write.rs`): it splices the new
  `03_GENERATED` group (end marker + pixel layer + group record, in
  psd_tools' record layout) directly into the template's layer info
  sub-section — every other byte of the template round-trips untouched —
  recomputes the section lengths/count, honours `fit_mode`
  (contain/cover/stretch), `z_order` (above_background/placeholder/top),
  the optional matte (`mask`) and `hide_placeholder`, and writes the full
  `.psd` + `_preview.png` + `_metadata.json` triplet. Golden tests re-read
  the written PSD and assert the exact layer tree psd_tools produced for
  the same job, plus pixel-identical previews (also verified externally:
  psd_tools re-reads the Rust file and its `composite()` matches the
  Python CLI's preview pixel-for-pixel).
- **Smart-object content replacement is native (P3c).** For
  `smart_object_mode == "replace_content"` on an embedded (`liFD`) smart
  object, `psd/smart.rs` writes the generated image *inside* the object,
  byte-splicing exactly three spans instead of re-serialising the document
  like psd_tools: the placeholder's layer record (new bounds + raw RGBA
  channel info; blend data and every tagged block — `SoLd`, `luni` — are
  copied verbatim so UUID/transform/warp survive), its channel data (the
  cached raster previews show), and the matching UUID item inside the
  document-level linked-layer block (`lnkD`/`lnk2`/`lnk3`), where the
  embedded source bytes, size and file type become the new PNG. Unlike the
  legacy bridge (which flattens to the document's RGB mode), the native
  raster keeps the letterbox strips transparent — matching what Photoshop
  re-renders from the embedded PNG. Golden tests run against psd-tools'
  `placedLayer.psd` fixture and compare the preview against the Python
  CLI's output; psd_tools re-reads the Rust file cleanly (layer tree,
  UUID, embedded bytes, composite). Externally linked (`lnkE`) / alias
  smart objects still error into the `compose_psd_cli.py` fallback.

Pending:

- Inputs the native writer rejects (non-PNG / colour-managed /
  EXIF-rotated sources, non-8-bit/RGB templates, external smart objects)
  stay on `compose_psd_cli.py` + `third_party/psd_tools`. Once
  real-template coverage confirms the native writer, Phase 7 (deleting the
  Python runtime from the packaged app) can start.

### P4 — Torch/Diffusers out of core (done)

No default path depends on torch/diffusers today (verified in P1); they are
opt-in `engine` values only. The engines have now been moved out of
`python/bridge` into a plugin package, per "Phase 6":

- `plugins/torch-engines/hgripe_torch_engines/` hosts every torch/diffusers
  engine module: `realesrgan.py`, `ccsr.py`, `supir.py` (Image Enhance SR)
  and `sd_inpaint.py`, `sdxl_inpaint.py`, `flux_fill.py` (Detail Repaint
  local inpaint). The modules keep their lazy-import / no-bundled-weights /
  graceful-degradation design and still reuse the bridge's torch-free helpers
  (`model_cache_dir`, `resolve_device`, `resolve_precision`, the
  `*Unavailable` errors).
- `python/bridge/sr_backends` and `python/bridge/inpaint_backends` no longer
  contain torch/diffusers code. Their registries discover the plugin at
  runtime (`sr_backends.load_torch_plugin`): `HGRIPE_TORCH_PLUGIN_DIR`
  overrides the location, otherwise the repo-layout `plugins/torch-engines`
  is used when present. When the plugin is absent every torch engine is
  simply not registered and the nodes keep their always-available defaults
  (native Rust CPU path / remote provider). `--probe-engines` now reports a
  `plugin` entry (`installed` + `reason`) so the UI can say why the engines
  are missing.
- Packaging: `tauri.conf.json` does not bundle `plugins/`, so the packaged
  desktop app now ships zero torch/diffusers code. Installing the plugin
  (plus the optional torch stack and weights) is what opts a machine in.
- The warm-cache torch worker (`torch_worker.py` + `studio/torch_worker.rs`)
  is unchanged: it hosts the same CLIs, and the plugin's process-global
  caches (`hgripe_torch_engines.realesrgan._WARM_UPSAMPLERS`,
  `hgripe_torch_engines.sd_inpaint._WARM_PIPELINES`) still survive across
  requests when the plugin is installed.

Remaining work for later phases: stop bundling the rest of `python/bridge`
(P5) and delete the worker host once no engine needs it (Phase 7).

### P5 — Packaging (partially done; remainder blocked on P3)

Done (the parts that could be split off early):

- `custom_nodes/` is gone. Its only remaining file, `hgripe_psd_nodes.py`
  (the torch-free PSD placeholder/fit/smart-object helpers the PSD CLIs
  reuse), moved into `python/bridge/hgripe_psd_nodes.py`; the three PSD
  CLIs import it directly. The ComfyUI custom-node directory is no longer
  bundled or part of the repo layout.
- `tauri.conf.json` no longer bundles all of `third_party/` (which pulled
  the multi-hundred-MB `cargo-vendor` crate mirror, the `ffmpeg` build
  tree and `moxcms` sources into every installer). Only
  `third_party/psd_tools/` — the sole third_party piece used at runtime,
  by the Python PSD path — is bundled. The vendored FFmpeg DLLs were
  never loaded from resources: `build.rs` copies them next to the binary.

Remaining (blocked on P3, per "Phase 7"):

- `python/bridge/` and `third_party/psd_tools/` stay bundled while the
  PSD path still requires Python; `project_python()` still prefers a
  bundled `python_embeded`.
- ComfyUI launcher/updater remnants under `.ci/` are repo files, not
  bundled resources; delete them alongside the Phase 7 cleanup.

## Suggested Migration Matrix

| Current Python path | Rust target | Priority |
| --- | --- | --- |
| `video_probe_cli.py`, `video_worker.py` | native FFmpeg media engine | High |
| `image_enhance_cli.py` CPU path | native `image_enhance_cpu` parity | High |
| `edge_refine_cli.py` | Rust mask/pixel operations + matting | High |
| `color_match_cli.py` | Rust colour kernel + `moxcms` + optional ONNX | High |
| `detail_watchdog_cli.py` | Rust rule detector + optional ONNX detector | Medium |
| `detail_repaint_cli.py prepare/composite` | Rust crop/mask/blend pipeline | Medium |
| `detail_repaint_cli.py repaint` local engines | API-first or external engine | Medium |
| `compose_psd_cli.py` | Rust PSD exporter/composer | High but late |
| `inspect_psd_cli.py`, `analyze_psd_cli.py` | Rust PSD metadata/template reader | High but late |
| `torch_worker.py` | remove from core | Medium |
| `third_party/psd_tools` | remove after Rust PSD parity | Late |

## What Not To Do

- Do not delete all Python now.
- Do not port every Torch model just because it exists.
- Do not make the Rust migration change node UX at the same time.
- Do not remove API credential/profile code while removing account/cloud code.
- Do not claim zero-Python while Tauri still bundles Python resources.
- Do not treat PSD as an easy image format. It needs its own staged migration.

## Recommended Next PR Split

1. Add golden fixtures and a Python bridge inventory test.
2. Make native FFmpeg the default video backend.
3. Replace edge refine with Rust.
4. Replace colour match with Rust.
5. Replace detail watchdog rules with Rust and optional ONNX.
6. Replace detail repaint prepare/composite with Rust.
7. Implement minimal Rust PSD inspect/analyze.
8. Implement minimal Rust layered PSD export.
9. Remove Torch/Diffusers core paths or move them behind an external engine.
10. Remove Python bridge from packaging and runtime.

## Product Direction

The Rust migration is not only a cleanup. It supports the real product goal:

- fast local editing
- stable packaging
- no Python wheel failures
- no ComfyUI dependency gravity
- better AMD/CPU friendliness
- deterministic nodes
- API-first generation
- optional low-cost local helper models
- PSD/video/colour workflows that can be manually corrected to production level

That is the correct long-term foundation for H-Gripe Studio.
