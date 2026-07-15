# Phase 2 Algorithm Roadmap — Super-Resolution, Detail Watchdog, Detail Repaint

> **Status:** Historical (Issue #4). The Phase 2 backends described below were
> implemented on the **Python bridge** and were **deleted with it in Phase 7
> (#314)** — every `python/bridge/…` path, torch/onnxruntime backend, and
> Python CI lane in this document no longer exists. What survives is the
> per-card `engine` seam *contract* (param + report fields + `probe_engines`),
> now served by the native Rust cards; see
> [`../implementation-status.md`](../implementation-status.md) §2 for the live
> status. Kept as design reference for future **native** re-implementations.
>
> Native implementations added after Phase 7 are marked explicitly below.
> Image Enhance, Refine Mask Edge, Detail Watchdog, and Match Light & Color now
> have native ORT blocks while their deleted Python implementations remain
> historical only.

## 0. Context

The PSD-first production chain is *functionally* complete end-to-end, but three
nodes ship a deliberate **Phase 1 / skeleton** core: the heavy ML/GPU algorithms
are stubbed by dependency-light CPU approximations so the pipeline, contracts,
and UI can be exercised without a GPU or large model downloads.

| Node | Tauri command(s) | Phase 1 core (today) | Phase 2 target |
| --- | --- | --- | --- |
| Image Enhance (super-res) | `enhance_image` | Native Rust Lanczos/median/unsharp CPU fallback plus opt-in native Real-ESRGAN x4v3 ORT | Later quality tiers and Windows GPU providers |
| Detail Watchdog | `detect_quality_issues` | Pillow+numpy rule heuristics (Laplacian variance, tile sharpness grid, alpha-rim halo, mean-colour drift) | ML/VLM semantic defect detection |
| Detail Repaint | `prepare_repaint_regions` + `composite_repaint` | crop/mask + feathered paste around a provider `image.edit` call | dedicated GPU inpainting backend |
| Match Light & Color | `match_light_color` | Reinhard Lab transfer / per-channel histogram match weighted to shadows/highlights, brand-colour protected (CPU) | learned image-harmonisation backend |
| Refine Mask Edge | `refine_mask_edge` | erode/dilate morphology + numpy guided-filter edge snapping + feather + colour decontamination, trimap unknown band protected (CPU) | learned alpha-matting backend |

The guiding principle for Phase 2 is **additive, opt-in backends**: the existing
CPU path stays as the always-available default and fallback; local ML selection
uses each card's `engine` parameter, never a silent default change.

---

## 1. Super-Resolution — `enhance_image`

### 1.1 Phase 1 baseline
`python/bridge/image_enhance_cli.py` runs, on CPU only:
1. `_denoise` — blend the image with a Gaussian-blurred copy (`strength` 0..1).
2. Lanczos resample up to the PSD placeholder's pixel target.
3. `_sharpen` — unsharp mask, capped by `--max-sharpen` so logos / packaging
   text are not mangled.

Presets (`conservative` / `texture_rebuild` / `print_ready` / `custom`) resolve
to `(scale, denoise_strength, texture_strength)`. This restores *apparent*
sharpness but cannot synthesize detail that is not in the source pixels.

### 1.2 Phase 2 target
A GPU diffusion/restoration backend that **hallucinates plausible high-frequency
detail** while preserving identity and text:
- **SupIR** — best perceptual quality, prompt-guided restoration; heavy (SDXL +
  large adapters), needs a strong GPU.
- **CCSR** — more faithful / less hallucinated; good for product photography
  where over-invention is a risk.
- **Real-ESRGAN** — light, deterministic, fast; a strong mid-tier default and a
  good first integration target.

### 1.3 Integration plan
**Status: the native Rust/ORT `realesrgan` block and Windows weight-gated
inference lane have landed.** The historical Python/Torch implementation above
remains deleted; `ccsr` and `supir` are not core runtime options.

- The selector is the local card's `engine` parameter: visible values are
  `cpu | realesrgan`. Old workflows containing `ccsr | supir` still load and
  produce the complete CPU result with a migration reason.
- `studio/image_enhance_onnx.rs` implements one concrete model contract:
  named float32 NCHW `input` RGB `[0,1]` to named native 4x `output`. It is not a
  generic first-input/first-output adapter.
- Inference uses 128px core tiles with a 16px context halo. Halo pixels are
  discarded in native output space; the assembled learned surface is resampled
  once to the exact card target. The native 4x intermediate is limited to
  48,000,000 pixels.
- Decode, CMYK/ICC handling, target resolution, alpha, output naming, PNG ICC
  and DPI remain on the existing native path. Model success replaces only the
  CPU denoise/resample/sharpen stage; every model/runtime/session/tensor/panic
  failure keeps the complete CPU result.
- Weight resolution checks `HGRIPE_REALESRGAN_MODEL`, persisted `realesrgan`,
  environment/configured caches, then packaged/development resources.
  `probe_engines` reports weight plus ORT readiness without loading a session.
- The current weight and ORT provider are FP32/CPU. Visible requests are
  `auto | gpu | cpu`; legacy `cuda | directml` and `fp16` remain readable and
  report their actual CPU/FP32 downgrade. Provider-aware session keys and the
  cross-model accelerator gate are shared with the other native models.
- The manual Windows CI lane downloads the byte/hash-locked optional ONNX and
  runs `realesrgan_inference_when_weight_present` across a real tile boundary.
  The pinned file is a third-party re-host, not bundled or release-approved;
  reproducible export lineage remains a packaging requirement.

### 1.4 Dependencies & risks
The native path adds no Python, Torch, OpenCV, Paddle, `realesrgan` Python
package or second inference runtime. It reuses repository-locked ORT plus one
optional ~4.9 MB weight. Remaining risks are tile-boundary or text/logo
distortion, bounded intermediate memory, and unverified third-party ONNX
lineage; strict tensors, padded tiling, allocation limits, complete CPU
fallback and release gating contain those risks.

---

## 2. Detail Watchdog — `detect_quality_issues`

### 2.1 Phase 1 baseline
`python/bridge/detail_watchdog_cli.py` is **detect + report only**, `torch`-free,
using Pillow+numpy:
- `low_resolution` — global Laplacian-variance blur and/or smaller-than-placeholder.
- `face_blur` — per-tile sharpness grid merged into boxes.
- `edge_halo` — bright fringe on the semi-transparent alpha rim.
- `color_mismatch` — subject mean colour vs connected `visual_context`.

Semantic targets (hands, packaging text, logo deformation) are explicitly
**recorded as skipped**, not guessed.

### 2.2 Phase 2 target
Replace/augment heuristics with learned detectors that honestly cover the
skipped semantic targets:
- **Face/hand quality** — a face/hand landmark + quality model to flag
  malformed hands and blurred faces with real confidence.
- **Text/logo integrity** — OCR (e.g. PaddleOCR) + template/logo matching to
  detect garbled packaging text and deformed logos.
- **VLM defect pass** — a vision-language model prompt ("list visible artifacts,
  with bounding boxes") for open-ended defect discovery, reconciled with the
  rule layer.

### 2.3 Integration plan
**Status: the seam has landed, plus a real trained text detector +
real-inference CI** (⛔ items are the remaining face/hand-quality, logo and VLM
models).
As with Image Enhance, the selector is the local card's **`engine` param**
(`rules` | `onnx_defect` | …), not `--profile-ref` (Detail Watchdog is a `local`
card).

- ✅ Keep the rule layer as the always-on baseline; ML detectors are additive
  passes selected by `engine`, each emitting into the **same `QualityReport`
  contract** (so `issue_masks` + `suggested_action` consumers — notably Detail
  Repaint — need no change). The detectors register under
  `python/bridge/detector_backends/` (mirroring `sr_backends`).
- ✅ Newly-covered targets graduate from `skipped` to real findings; detector
  provenance is added as optional report fields (`engine` / `engine_requested` /
  `engine_fallback_reason` / `detectors` / `backend_model`).
- ✅ Detectors run behind a capability probe (`detail_watchdog_cli.py
  --probe-engines`); missing deps/weights ⇒ the rule-only report runs and the
  uncovered targets stay `skipped` exactly as today (no hard failure), with the
  reason recorded.
- 🟡 `onnx_defect` is the first concrete detector: a generic ONNX object
  detector seam covering hands/text/logo (`malformed_hands` / `garbled_text` /
  `deformed_logo`). It accepts both box-detector outputs
  (`boxes`/`scores`/`labels`) and DB-style segmentation **probability maps**
  (`[1,1,H,W]`, thresholded into connected components), with the sidecar's
  object form (`{"labels": {...}, "normalize": "imagenet"}`) selecting input
  normalisation. ✅ The `text` target has a real trained weight: the PP-OCRv3
  det ONNX export (PaddleOCR, Apache-2.0, ~2.4 MB), fetched sha256-checked by
  `scripts/fetch-watchdog-text.{sh,ps1}` — a partial-coverage weight keeps the
  other targets truthfully `skipped`. Weights are not bundled; ⛔ the trained
  face/hand-quality, logo and VLM models behind the remaining targets.
- 🟡 The gated unit test that synthesises a tiny ONNX detector to exercise the
  session path (incl. the `onnx_providers` execution-provider selection) now
  runs in CI: the **`python bridge (onnx inference)`** lane installs `onnx` +
  `onnxruntime` per PR (no weight download needed since the model is
  synthesised). ✅ Real *trained-weight* inference CI (opt-in like the ViTMatte
  e2e): the manual-dispatch **`python bridge (watchdog text e2e)`** lane
  fetches the PP-OCRv3 weight and runs the gated
  `test_onnx_defect_real_inference_when_weight_present` e2e through the CLI
  (skips on every normal run).

### 2.4 Dependencies & risks
`onnxruntime`/`torch`, OCR + detection weights. Risks: false positives causing
unnecessary repaint loops (tune thresholds, require agreement between rule + ML
for auto-action), latency (run ML passes only on flagged tiles).

---

## 3. Detail Repaint — `prepare_repaint_regions` / `composite_repaint`

### 3.1 Phase 1 baseline
`python/bridge/detail_repaint_cli.py` is the `torch`-free pixel backend:
- `prepare` — crop a padded window per issue region and write a same-size
  inpaint `mask` marking the issue core; emit a manifest.
- `composite` — paste provider-repainted crops back inside a *feathered* issue
  core (edge fusion at the seam), leaving padding context untouched.

The actual generative fix is the broker `image.edit` provider call, owned by the
Rust/TS orchestration layer — quality depends entirely on the configured
provider.

### 3.2 Phase 2 target
A first-class **local GPU inpainting backend** as an alternative to the remote
provider:
- Diffusion inpainting (SD/SDXL inpaint, or Flux Fill) driven by the same
  crop+mask+prompt manifest, for offline / privacy / cost-controlled runs.
- Optional ControlNet (edges/depth) conditioning to keep structure stable.
- Seam-aware blending beyond the current feather (e.g. Poisson / gradient-domain
  compositing) for harder seams.

### 3.3 Integration plan
**Status: the seam + `sd_inpaint` + the SDXL (`sdxl_inpaint`) and Flux Fill
(`flux_fill`) backends + the advanced-blend flag (`blend=poisson`,
gradient-domain seam compositing in `composite`, defaulting to the feather) +
the optional ControlNet (canny) conditioning for `sd_inpaint` (`controlnet`
param, weight from `HGRIPE_CONTROLNET_MODEL`; an unsupported request degrades
to the provider with a recorded reason) + the opt-in real-inference CI lane
have landed** (the rest of this section is the design it was built to): the
manual-dispatch **`python bridge (diffusers inference)`** job installs the CPU
torch stack (`torch` / `diffusers` / `transformers`) and runs the gated
`test_{sd_inpaint,sdxl_inpaint,flux_fill}_real_inference_with_tiny_snapshot`
e2es — **all three local engines** — each synthesising a tiny random-weight
snapshot in diffusers format (no weight download, like the synthesised-ONNX
lanes) and driving the real `from_pretrained` → denoise loop → VAE decode
through the CLI `repaint` subcommand (skips on every normal run). The selector
is the local card's
**`engine` param** (`provider` | `sd_inpaint` | …); `provider` stays the default
and the fallback.
- The `prepare`/`composite` split and manifest **already** isolate the generative
  step cleanly — the `repaint` subcommand (`python/bridge/inpaint_backends/`) adds
  a local backend that consumes the same manifest, so the orchestrator chooses
  "provider `image.edit`" vs "local inpaint" by the `engine` param with **no
  contract change**: a `repaint` run emits the same `{index, path}` list that
  `composite` already consumes, and an unavailable/`provider` engine emits an
  empty list + `engine_fallback_reason` so the remote path runs unchanged.
- `composite` stays backend-agnostic; only an optional advanced-blend flag is
  added, defaulting to today's feather. ✅ Landed as `--blend feather|poisson`
  (a DST-based exact Poisson solve over the rectangular issue core, falling
  back to the feather on a too-small region).

### 3.4 Dependencies & risks
`torch` + CUDA, inpaint model weights, optional ControlNet. Risks: identity
drift inside masked region (low denoise strength + tight masks), seam visibility
(advanced blend), VRAM (tiled per-region inference — already region-scoped by
`prepare`).

---

## 4. Match Light & Color — `match_light_color`

### 4.1 Phase 1 baseline
`studio/color_match_cpu.rs` now runs this baseline in-process in native Rust: a
Reinhard Lab statistics transfer / per-channel histogram match
(`color_transfer` | `histogram_match` | `hybrid`), weighted toward
shadows/highlights, sparing high-chroma brand pixels, and acting only inside the
subject alpha and optional correction mask. `prompt_only` emits the prompt
suffix and an unchanged image. The Python bridge no longer exists.

### 4.2 Phase 2 target
A **learned image-harmonisation** network that predicts a per-pixel light and
colour correction consistent with the background while preserving brand
colours and material cues better than global Lab/histogram statistics. The
native PCT-Net ViT implementation described below now provides this opt-in
path.

### 4.3 Integration plan
**Status: the native `onnx_harmonize` PCT-Net block and a weight-gated Windows
inference lane have landed.**

- The **`engine` param** is `cpu | onnx_harmonize`; `cpu` remains the default
  and always-available heuristic baseline.
- `studio/color_match_onnx.rs` is a concrete PCT-Net contract. It feeds four
  named float32 NCHW inputs: `image_lr` `1x3x256x256`, `image_fullres`
  `1x3xHxW`, `mask_lr` `1x1x256x256`, and `mask_fullres` `1x1xHxW`. The named
  `output` is full-resolution RGB `1x3xHxW`. The low-resolution branch stays
  fixed at 256x256 even though the exported axes are dynamic.
- The subject/background composite uses the effective soft matte (subject alpha
  multiplied by the optional correction mask) at both resolutions. This lets
  opaque RGB/JPEG subjects expose the background when a mask is connected.
  The model requires at least one percent exposed background; a fully opaque
  unmasked subject keeps the CPU result because its composite contains no
  reference context.
  PCT-Net's composited output is converted back to straight RGB through that
  same matte before the original alpha is restored, avoiding a second
  background mix on soft edges. The learned candidate then passes through the
  existing strength, shadow/highlight, saturation, and brand-colour
  protections.
- The complete CPU match is computed first. Model resolution, runtime/session,
  tensor validation, inference, or panic failures keep that CPU result and are
  reported in `engine_fallback_reason`. `prompt_only`, zero strength, no
  background, and unknown engine ids also preserve valid CPU outputs.
- The model resolver checks `HGRIPE_COLOR_MODEL`, persisted `onnx_harmonize`,
  environment/configured shared caches, and packaged/development resources.
  `probe_engines` reports weight and ORT availability without loading the model
  session.
- Learned inference requires both subject and background source surfaces to stay
  within a 4096-pixel edge and 4194304 total pixels. ONNX-only RGBA/matte
  buffers are retained only after that check; larger inputs keep the complete
  CPU match without those extra surfaces.
- The supported local file is `color_harmonize.onnx` (`24819882` bytes,
  SHA-256
  `5ac3c8f59ad3a58a55baae79f3886e06826e7acb932179aaed034b61d62f5997`).
  It is an unofficial conversion from `pccaza/harmonizer-onnx` commit
  `046a31654875432fe303d5342aa036782270c520` (conversion repository MIT), based
  on official PCT-Net work (MPL-2.0). Our upstream review reference is
  `rakutentech/PCT-Net-Image-Harmonization` commit
  `1572176ed1a72217dad7395391615329b98d30c7`; the converter did not identify its
  exact upstream revision/checkpoint or export procedure, so lineage remains
  unverified. It is not an official Rakuten/PCT-Net ONNX export, is not
  release-ready by default, and is not bundled by default.
- The manual Windows CI job fetches the byte/hash-locked artifact and runs
  `pctnet_inference_when_weight_present`; normal PR runs skip real model
  inference when no local weight resolves.

### 4.4 Dependencies & risks
The native path reuses the repository-maintained Windows x64 ORT 1.24.2 runtime
and process-wide warm session pool; no Python, torch, OpenCV, or Paddle runtime
returns. The current ORT package has the CPU provider only. A later Windows
provider block must add NVIDIA CUDA and AMD/Intel DirectML with real session
binding, packaging, truthful fallback, and hardware tests. ROCm is not a
Windows target.

The weight remains optional and unbundled. Distribution requires a fresh
provenance/license review and preferably an internally reproducible export from
the pinned official source. Runtime risks are identity or brand-colour drift,
bounded full-resolution memory use, and malformed third-party model tensors;
the strict contract and complete CPU fallback contain these failures.

---

## 5. Refine Mask Edge — `refine_mask_edge`

### 5.1 Phase 1 baseline
`studio/edge_refine_cpu.rs` runs in-process in Rust: erode/dilate morphology to
bite off the white fringe, a guided filter that snaps the matte to the subject's
own luminance edges, a Gaussian feather, and edge colour decontamination. When a
matting **trimap** is connected, the unknown band (hair / fur / glass) is
protected from the erode/feather clean-up and restored from the source matte.
Emits `{refined_image, refined_mask, edge_report}`.

### 5.2 Phase 2 target
A **learned alpha-matting** network (ViTMatte / IndexNet / MODNet-style) that
solves true continuous alpha in the trimap's unknown band — recovering fine hair
and semi-transparent edges the global guided filter flattens — while leaving the
definite FG/BG regions to the deterministic heuristic clean-up.

### 5.3 Integration plan
**Status: the native seam + `onnx_matting` + weight-gated inference test have
landed.** Mirroring the SR / Watchdog / Repaint / Match Light & Color seams:

- A new **`engine` param** (`cpu` | `onnx_matting` | …); `cpu` stays the default
  and always-available heuristic baseline.
- `studio/subject_matte.rs` owns the shared ViTMatte implementation. Both
  Subject Mask and Refine Mask Edge reuse its 4-channel `pixel_values`
  preprocessing and the process-wide warm `ort::Session` pool.
- The weight resolver checks `HGRIPE_VITMATTE_MODEL`, the persisted
  `onnx_matting` model-manager path, environment/configured shared cache, and
  packaged/development `resources/models/vitmatte.onnx` locations.
- Real trained-weight inference remains opt-in: both cards have gated tests;
  without the sha256-checked weight normal CI verifies preprocessing, band
  isolation and every fallback path without pretending model inference ran.
- The learned alpha **replaces the source matte only inside the protected
  (unknown) band**, so the definite regions still get the morphology/guided/
  feather clean-up and the geometry / report contract is unchanged (plus
  `engine` / `engine_requested` / `engine_fallback_reason` / `backend_model`
  telemetry). A learned matter is meaningful only with a trimap, so without one
  the node records a skip reason and keeps the heuristic.
- `probe_engines` reports the managed weight and compiled ORT providers for
  diagnostics. The Inspector does not yet consume that report to disable a
  missing `onnx_matting` choice. Missing weight/session/inference still produces
  outputs through the heuristic and records the fallback reason.

### 5.4 Dependencies & risks
`ort` + a matting weight (not bundled). Risks: trimap quality dominates matting
quality, and the weight is opt-in so real-inference CI remains gated. The
Windows x64 ORT CPU runtime is repository-maintained and packaged locally;
build-time runtime downloads remain forbidden.

---

## 6. Cross-cutting concerns

- **Packaging (ties to Issue #2):** optional model weights are not bundled by
  default. Native engines resolve them from explicit env values, persisted
  model paths, `HGRIPE_MODEL_CACHE`, or packaged/development resources. The
  Windows x64 ORT runtime itself is repository-maintained and packaged; no
  build-time download or arbitrary system runtime fallback is allowed.
- **Capability probing:** the `probe_engines` Tauri command reports the native
  `realesrgan`, `onnx_matting`, `onnx_defect`, and `onnx_harmonize` weight/runtime status plus
  their always-on baselines. Runtime diagnostics now distinguish the selected
  runtime flavor, packaged providers, and providers usable after DLL loading;
  obsolete Python/Torch/CUDA probe fields are removed. The Inspector does not
  yet consume that report to disable a missing engine choice.
- **Device reporting:** native ONNX reports preserve `auto | cpu | gpu` and
  legacy/provider-specific `cuda | directml` requests, then record the actual
  provider device. The current ORT package has the CPU provider only, so every
  accelerated request resolves truthfully to CPU with a reason. Later Windows
  work must add NVIDIA CUDA and AMD/Intel DirectML before reporting
  acceleration; ROCm is not a Windows target.
- **Provider/session architecture:** provider resolution runs before session
  creation. The warm-pool key includes model path, runtime flavor, actual
  provider, and device id; SAM2 encoder/decoder use one provider plan. The graph
  scheduler runs a conservative, advisory provider preflight from visible params;
  it is not the later session result. Subject Mask always enters that candidate
  resolution because its matting strokes arrive through resolved inputs; Crop
  auto-subject and Smart Layer Split remain explicit CPU candidates. The current
  CPU flavor keeps every request in `CpuBound`. Shared-session resolution, its
  process-wide single-slot accelerator gate, and per-stage reports are the
  execution truth.
- **Concurrency boundary:** the ONNX accelerator gate is currently global and
  single-slot, independent of the scheduler's configurable GPU limit. That is a
  safe CPU-era boundary, but the two policies must be aligned before the first
  CUDA or DirectML runtime ships.
- **Model management:** `get_model_paths` / `set_model_paths` persist per-engine
  weight overrides and the shared cache in `model_paths.json`; real process env
  values still win. The old Dashboard panel is gone, pending a settings and
  diagnostics surface inside the node editor.
- **Determinism and safety:** keep text/logo and identity protections, strict
  tensor contracts, bounded allocation, and complete baseline fallback. The
  third-party harmonizer weight additionally requires provenance and license
  review before any release bundling.
- **Contracts are stable:** local Phase 2 selection uses each card's `engine`
  param and existing report fields. CPU/rules/provider remains the default and
  complete fallback; Python runtimes and subprocess backends remain deleted.

## 7. Remaining sequencing

1. Add a native local repaint backend only after its model/runtime and manifest
   contract are concrete; provider repaint remains the fallback.
2. Extend Detail Watchdog with trained hands/logo coverage while retaining the
   additive rules result.
3. Add actual Windows ORT runtime flavors: NVIDIA CUDA and AMD/Intel DirectML,
   each with locked binaries, strict provider registration, CPU retry/fallback,
   packaging, and real hardware evidence. Provider-aware session keys,
   cross-model gating, and conservative candidate scheduling are in place; align
   the scheduler limit with the ONNX single-slot gate before either runtime ships.

Native `realesrgan`, `onnx_matting`, `onnx_defect`, and `onnx_harmonize` blocks
now have weight-gated inference paths. Real-ESRGAN and PCT-Net release bundling
remain intentionally unapproved pending provenance/license review and a
reproducible export story.
