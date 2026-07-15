# Implementation Status — what's landed vs. still planned

> **Purpose:** a single, long-lived cross-reference of which documented
> capabilities are actually implemented today versus still in the design/roadmap
> stage. The per-card docs under [`docs/cards/`](cards/) remain the frozen
> contracts; the [Phase 2 roadmap](design/phase2-algorithm-roadmap.md) and the
> [executor-split design](design/executor-split-and-psd-chain-hardening.md) hold
> the forward-looking plans. This file just consolidates the *gaps* so they
> don't get lost across documents.
>
> **How to read the status column:**
> - ✅ **Landed** — implemented and covered by tests / CI.
> - 🟡 **Partial** — a deliberate Phase 1 / CPU baseline is in place; the
>   production-grade (usually GPU/ML) path is not.
> - ⛔ **Planned** — design only, no implementation.
>
> Keep this table honest: when a feature lands, flip its row and link the PR.
> When a new card/feature is documented, add a row so the gap is tracked.

---

## 1. PSD production chain (the eight cards)

> Since **Phase 7 (#314)** every card runs **in-process native Rust** — the
> Python bridge, `psd_tools`, and the Python ML engine backends were deleted.

| Capability | Status | Notes |
| --- | --- | --- |
| PSD Context Analyze (`psd/analyze.rs`) | ✅ Landed | Native `VisualContext` (lighting / bounds / masks) extraction. |
| Match Light & Color (`studio/color_match_cpu.rs` + `color_match_onnx.rs`) | Landed (native, optional weight) | Complete Lab/histogram CPU baseline plus opt-in native PCT-Net `onnx_harmonize`: strict four-input 256/full-resolution contract, shared ORT warm session, managed weight resolution, full-resolution RGB output, and complete CPU fallback. The third-party ONNX is not bundled by default and still requires release provenance review. See Section 2. |
| PSD Export (`psd/compose.rs` + `psd/write.rs` + `psd/smart.rs`) | ✅ Landed | Native writer: smart-object replacement + `.psd`/preview/metadata triplet. |
| Refine Mask Edge (`studio/edge_refine_cpu.rs`) | ✅ Landed | CPU clean/feather baseline plus native `onnx_matting`: reuses Subject Mask's ViTMatte/ORT session and replaces only the trimap unknown band, with reported CPU fallback for missing inputs, weights or inference. |
| Image Enhance (`studio/image_enhance_cpu.rs`) | 🟡 Partial | CPU Lanczos upscale + denoise + unsharp, incl. the in-process CMYK/ICC decode paths. The Python SR engines (`realesrgan`/`ccsr`/`supir`) were deleted in Phase 7; a native SR backend is still ⛔. See §2. |
| Detail Watchdog (`studio/detail_watchdog_cpu.rs` + `detail_watchdog_onnx.rs`) | 🟡 Partial | Always-on CPU rules plus native ORT `onnx_defect`, warm-session reuse, managed weight/sidecar resolution and rules-preserving fallback. The fetched PP-OCRv3 weight covers `text`; `hands`/`logo` remain truthfully `skipped` until trained weights cover them. See §2. |
| Detail Repaint (`studio/detail_repaint_cpu.rs`) | 🟡 Partial | Native `prepare`/`composite` (feather + Poisson seam blends) around a provider `image.edit` call. The Python local diffusers engines (`sd_inpaint`/`sdxl_inpaint`/`flux_fill`) were deleted in Phase 7; the provider path is the only repaint backend. See §2. |

## 2. Phase 2 algorithm backends — [`design/phase2-algorithm-roadmap.md`](design/phase2-algorithm-roadmap.md)

**Status reset by Phase 7 (#314):** the roadmap's opt-in ML backends were all
implemented on the Python bridge, and were **deleted with it**. What survives
is the *contract*: every card keeps its `engine` param, `engine` /
`engine_requested` / `engine_fallback_reason` report fields, and the
`probe_engines` capability probe. Refine Mask Edge restored `onnx_matting` on
the Subject Mask ViTMatte/ORT path; Detail Watchdog restored `onnx_defect`; and
Match Light & Color now restores `onnx_harmonize` with a native PCT-Net block.
All three reuse the local ORT runtime/session infrastructure and preserve their
native baseline outputs through reported weight, runtime, session, inference,
panic, and provider fallback. Image Enhance still rejects its deleted engine
ids; Detail Repaint falls back to its provider path.

| Item | Status | What's missing |
| --- | --- | --- |
| **Super-resolution** backend (Image Enhance) | ⛔ Planned (native) | Python `realesrgan` / `ccsr` / `supir` backends deleted in Phase 7. A native SR backend (`ort` or similar) + weight story. |
| **Detail Watchdog** ML/VLM passes | 🟡 Partial (native) | Native Rust/ORT `onnx_defect` supports strict box outputs and DB probability maps, additive rules merge, sidecar-defined coverage and complete fallback. The verified PP-OCRv3 slice covers `text`; trained `hands` and `logo` coverage is still missing. |
| **Detail Repaint** local inpaint backend | ⛔ Planned (native) | Python `sd_inpaint` / `sdxl_inpaint` / `flux_fill` backends deleted in Phase 7. The provider `image.edit` path is the only repaint backend; the native Poisson/feather seam blends remain. |
| **Match Light & Color** learned matcher | Landed (native, opt-in weight) | Native Rust/ORT PCT-Net uses four named float32 inputs (`image_lr`, `image_fullres`, `mask_lr`, `mask_fullres`), a fixed 256x256 low-resolution branch, effective alpha/mask compositing, and straight-RGB recovery from the full-resolution output. Subject and background source surfaces are each capped at 4 MP for learned inference, and ONNX-only surfaces are retained only on that bounded path; the complete CPU match remains the fallback. The pinned third-party ONNX is unofficial, unbundled by default, and not release-ready without provenance/license review. |
| **Refine Mask Edge** learned matting | ✅ Landed | Native `onnx_matting` shares `subject_matte.rs`, the process-wide ORT session pool and managed `vitmatte.onnx` resolution. Only the trimap unknown band takes learned alpha; the CPU pipeline and outputs remain the fallback contract. |
| **Capability probe / weight cache** | Partial | `probe_engines` reports native `onnx_matting`, `onnx_defect`, and `onnx_harmonize` weight/runtime presence alongside the always-on baselines. The provider-aware warm pool keys by model/runtime/provider/device, SAM2 sessions resolve as one group, and runtime diagnostics separate packaged from loadable providers. The current exact-allowlist ORT payload is CPU-only; actual NVIDIA CUDA and AMD/Intel DirectML runtime flavors, hardware evidence, an Inspector consumer, and a replacement for the legacy Dashboard model-management surface remain open. |

## 3. Subject Mask / Matte — [`subject-mask-matte.md`](cards/subject-mask-matte.md)

| Item | Status | Notes |
| --- | --- | --- |
| Manual brush / eraser / wand / marquee / morphology | ✅ Landed | Phase 1 Image Editor tool set. |
| Auto modes via in-process model cascade | ✅ Landed | BiRefNet lite / U²-Netp salient cascade + point-prompt **SAM 2**, `builtin-cpu` fallback. |
| SAM 2 point prompts (positive **and** negative) | ✅ Landed | Left-click include (green), right-click exclude (red) → `point_labels`; builtin fallback excludes connected components. |
| Alpha matting (continuous alpha) | ✅ Landed | `alpha_matting` → trimap → **ViTMatte** (`ort`) when the weight resolves, else deterministic image-guided **guided-filter** `builtin-cpu-matte`. |
| Matting paint tool (hand-painted unknown band) | ✅ Landed | `matte_strokes` stamped onto the trimap before matting. |
| Trimap hand-off to Refine Mask Edge | ✅ Landed | `trimap` output → Refine `trimap` input protects the soft-alpha band. |
| **`auto_person` portrait-matting net** | 🟡 Partial | The **`u2net_human_seg`** human-segmentation net (Apache-2.0, ~168 MB, env `HGRIPE_PERSON_MODEL` / `scripts/fetch-person-model.*`) slots into `segmenter_for_mode` behind the same trait: `auto_person` leads with it (so the matte tracks people, not generic saliency), then falls through to BiRefNet → U²-Netp → `builtin-cpu`; other modes keep the generic priority. Still ⛔: bundling the weight in the installer (downloadable big tier today). |
| **Pen / Lasso (bezier paths)** | ✅ Landed | Pen (click anchors, bezier-capable) / lasso (freehand) tools in the Image Editor modal; the backend flattens each closed path (cubic bezier where handles are present), rasterises it (even-odd scanline fill) and boolean-combines it with the mask (`add` / `subtract` / `intersect`). The proxy preview folds paths in too. |
| **SAM 2 multi-variant XY compare (T/S/B/L)** | ✅ Landed | The node's `sam2_variant` param selects **tiny / small / base_plus / large**; `scripts/fetch-sam2.*` take a variant list (`all` fetches every one, sha256-checked). A missing weight falls back to tiny, and `detected_subjects` records the `variant` actually used, so two nodes on the same prompts compare variants side by side (XY). |

## 4. Executor-split / management surfaces — [`design/executor-split-and-psd-chain-hardening.md`](design/executor-split-and-psd-chain-hardening.md)

| Item | Status | Notes |
| --- | --- | --- |
| Executor lanes (Graph / Local / Compute / Api / Hybrid) | ✅ Landed | `StudioExecutor` + `studio_executor_for_kind` + `executor` field on node specs. |
| Input hardening (CMYK/ICC normalise, EXIF, `--max-decode-pixels`) | ✅ Landed | Across the PSD cards. |
| Colour pipeline: wide-gamut 16-bit working space + manual/model split — [`design/colour-pipeline.md`](design/colour-pipeline.md) | ✅ Landed | **P1–P5 landed.** CMYK decode coverage ✅ (#180–#186). Canonical surface is now **16-bit ProPhoto** for profiled CMYK (#188–#190); the card/model/output boundary colour-manages **ProPhoto → sRGB**, while plain images / naive CMYK egress as an exact bit-narrow (byte-exact contract held). **P4 (manual-path 16-bit chain) complete**: `image_buffer` carries the 16-bit `WorkingImage` natively (P4a #191), crop walks it end-to-end with 16-bit PNG-with-ICC output (P4b #192), 16-bit TIFF-with-ICC output + crop `format` param (P4c #193), subject-mask 16-bit cutout/RGBA products (P4d #194), close-out P4e reconciled the remaining manual cards' pixel work in P5. **P5 (cross-engine parity) complete**: ProPhoto-tagged manual products were colour-managed to sRGB at card ingress (#202), the enhance cpu path no longer re-embeds the stale ProPhoto profile on its sRGB output (#203). **Open decisions closed**: TRC — working space stays gamma-encoded with per-operation linear-light where the maths need it (first landing: enhance colour resample, #205); local-model bit depth — 8-bit sRGB for all current integrations. Initiative complete; the Python half of the parity contract was retired with the bridge in Phase 7 (#314) — the native path is the only implementation. |
| **Local model management surface** | 🟡 Partial | The per-node `engine` param and backend capability report (`probe_engines`) remain, but the Inspector does not currently consume that report to disable unavailable choices. The backend `get_model_paths`/`set_model_paths` commands (persisted per-engine `weights_path` overrides + shared cache dir in `model_paths.json`, resolved by `psd/model_paths.rs` with real env vars still winning) remain for native `ort` weights. The old Dashboard **Local models** panel was removed with the legacy shell tabs; a settings/diagnostics surface inside the node editor is still needed. |
| **In-app account / config editor** | ⛔ Not planned | The desktop shell has no H-Gripe account/login surface and no Credentials / Profiles tabs. Third-party API keys and provider profiles stay as local config files + CLI until a cleaner API configuration surface is deliberately designed. |
| Per-card `engine` seams (matcher) | Partial | Refine Mask Edge, Detail Watchdog, and Match Light & Color now have native ORT backends behind their existing seams. Image Enhance still exposes only its CPU baseline and Detail Repaint only its provider path after the Python ML backends were deleted. |

## 5. Production drawer / timeline / monitor

| Item | Status | Notes |
| --- | --- | --- |
| Clip keyframe / motion pipeline | ✅ Landed (code), evidence pending | Phases 1-5 landed across #612, #616-#618: Rust/TS keyframe evaluation, export and preview property compositing, easing interpolation, timeline keyframe lane, hit targets, and compositor reporting. The plan stays active only because native FFmpeg-backed preview/export evidence still needs to be captured after repo-maintained `third_party/ffmpeg` LFS binaries are restored. |
| Media workspace direct file import | ✅ Landed | `MediaWorkspacePopover` owns the media-bin popup; users can drag/select local video, audio, and image files into the workspace and then place assets on the timeline (#619). |
| Program monitor export frame | ✅ Landed | Left monitor toolbar has Export Frame; the dialog supports name, format, output path, and "add to project" default-on, then registers the exported still in the media workspace (#620). |
| Program monitor loop playback | ✅ Landed | Left monitor toolbar has Loop Playback; playback wraps within explicit in/out marks or the current timeline duration (#621). |

## 6. Packaging & verification gaps

| Item | Status | Notes |
| --- | --- | --- |
| Bundled CPU baseline (u²-netp ~4.6 MB) | ✅ Landed | Fetched at package time, shipped via `tauri.conf.json` `bundle.resources`. |
| **Optional model bundling** (Issue #2) | Planned | BiRefNet lite, SAM 2, ViTMatte, and PCT-Net are not default installer weights. PCT-Net additionally requires a fresh provenance/license review and preferably a reproducible export before any release bundle. |
| **ViTMatte real inference in CI** | 🟡 Partial | Subject Mask and Refine Mask Edge both have weight-gated native inference tests; the weight-fetching job remains opt-in, so real model inference is skipped on normal PRs. |
| **Detail Watchdog real inference** | ✅ Landed (opt-in CI) | Native inference is weight-gated; the manual Windows CI job uses the SHA-256-locked PP-OCRv3 fetch script and requires a real `garbled_text` box. Normal runs cover preprocessing, DB postprocessing, fallback and validation while skipping the trained model when the local weight is absent. |
| **PCT-Net harmonizer real inference** | Landed (opt-in CI) | A manual Windows job fetches the unofficial conversion from its pinned conversion-repository commit, verifies `24819882` bytes and its SHA-256, then runs `pctnet_inference_when_weight_present`. Normal runs cover preprocessing, strict tensors, resource limits, and CPU fallback while skipping real inference without the optional weight. This CI gate is verification, not release approval. |

## 7. Internationalisation (cards)

| Item | Status | Notes |
| --- | --- | --- |
| Node-card / Inspector / Palette / search / Image Editor i18n (中/英) | ✅ Landed | English `NODE_SPECS` source + `nodeSpecsI18n` / `imageEditorToolsI18n` zh overlays + `localizeSpec` resolver. A coverage test fails CI if any node/param/port/tool ships without a zh entry. |

## 8. Editor resource & threading model — [`design/editor-resource-model.md`](design/editor-resource-model.md)

The full staged rollout of the editor compute/threading model has **landed**.

| Item | Status | Notes |
| --- | --- | --- |
| Preview lane (single-slot, latest-wins, decoupled from run lock) | ✅ Landed | PR #145; first consumer is live mask-morphology proxy preview. |
| Explicit exec-lane scheduler + GPU `Semaphore(1)` | ✅ Landed | PR #146; replaces the accidental serial `.await` loop in `exec.rs`. |
| ONNX warm pool (`onnx_pool.rs`) | ✅ Landed | PR #147; process-global `ort::Session` reuse (see §1/§3). |
| Long-lived torch worker (`torch_worker.rs`) | ❌ Removed | Landed in PR #148 for the Python torch engines; deleted with them in Phase 7 (#314). The ONNX warm pool (`onnx_pool.rs`) is the surviving warm-model mechanism. |
| Video media engine (decoder seam + frame cache + playback thread) | ✅ Landed | PR #149; `video_engine.rs` + `frame_cache.rs`, `video_scrub` command. |
| Native in-process ffmpeg `FrameSource` | ✅ Landed | PR #150; `ffmpeg_native.rs` links **vendored** libav (`third_party/ffmpeg`, git-lfs) behind the `native-ffmpeg` feature. The PyAV fallback was deleted in Phase 7 (#314) — native ffmpeg is the only video backend. |
| Video **export / encode** | ✅ Landed | The **Video Assemble** output card encodes an ordered frame sequence to video natively (`studio/video_assemble.rs`, vendored ffmpeg encoders; fps / encoder / output params). |
| Video **trim** | ✅ Landed | The **Video Trim** output card cuts a `[start_sec, end_sec)` range out of a video natively (`studio/video_trim.rs`, frame-accurate decode-and-re-encode; audio not carried over). |

## 9. Out of scope (explicit product-direction decisions)

These were floated in early vision/research notes but are **not** committed
work. The product today is PSD-first, single-image, native Rust.

| Item | Status | Notes |
| --- | --- | --- |
| Video **subject** axis (temporal mask tracking / flicker smoothing) | ⛔ Not planned | Would need a video predictor (SAM 2 memory bank); the bundled SAM 2 ONNX is the **image** variant. Distinct from the decode/scrub **media engine**, which *has* landed (§8) — this row is about propagating a *mask* across frames, not playback. Needs a separate product decision. |
| Private local SD video content-aware fill | ⛔ Not planned | Video axis is out of scope; the *still-image* local SD inpaint engine that once existed on the Python bridge was deleted in Phase 7 (see §2). |
