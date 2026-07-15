# Detail Watchdog card

Executor: **local** (in-process native Rust, never networks).
Backend: `detect_quality_issues` Tauri command -> `studio/detail_watchdog_cpu.rs`
(always-on native rules) plus `studio/detail_watchdog_onnx.rs` (opt-in native
ORT detector). The Python bridge remains deleted.

Scans a candidate image for local quality breakdowns and emits a structured
`QualityReport` so the workflow can decide whether to re-run, hand-fix, or
repaint a region before composing into the PSD. This document is the card's
contract: what it accepts, what it guarantees, and how it behaves at the edges.
Phase 1 is **detect + report only** (it never repaints — `fixed_image` is the
input unchanged). The CPU **rule layer** (native Rust, no ML) is the
always-available baseline and always runs. Semantic detection of hands,
packaging text and logo deformation needs a learned detector: the rule layer
never guesses at them, recording them as `skipped` instead. They graduate to
real findings through an **opt-in** ML detector selected by the `engine` param
(see *Engine seam* below); when the chosen detector's runtime or weight is
missing, the node falls back to the rule-only report and records why
(`engine_fallback_reason`) — it never hard-fails for lack of a model.

## Inputs (ports)

| Port | Type | Required | Notes |
| --- | --- | --- | --- |
| `image` | image path | yes | The candidate image to inspect. Its alpha rim is used for halo detection. |
| `visual_context` | JSON | no | Connected `VisualContext` (background `mean_color` + placeholder `bounds`) from PSD Context Analyze. |
| `target_bounds` | JSON | no | Standalone placeholder rectangle `{x,y,width,height}`; overrides `visual_context`'s placeholder for the size check. |

## Parameters

| Param | Type | Default | Range / values | Notes |
| --- | --- | --- | --- | --- |
| `mode` | enum | `balanced` | `strict` \| `balanced` \| `lenient` | Detection aggressiveness (thresholds below). |
| `watch_targets` | csv | all | `face,hands,text,logo,product_edges` | Empty = all. `hands`/`text`/`logo` stay in `skipped_targets` unless an `engine` covers them. |
| `engine` | enum | `rules` | `rules` \| `onnx_defect` | Detection engine. `rules` = built-in CPU rule layer (always on). `onnx_defect` = opt-in native ORT detector for hands/text/logo, falling back to the complete rules result when its runtime, weight, session or inference is unavailable. |
| `device` | enum | `auto` | `auto` \| `cpu` \| `gpu` \| `cuda` | ORT provider request for `onnx_defect`. `gpu` stays vendor-neutral for future CUDA/DirectML selection. The current Windows runtime is CPU-only, so accelerated requests report the provider fallback. |
| `output_dir` | path | run output dir | | Validated server-side. |
| `output_name` | basename | `<image>_issues` | plain basename | Rejected if it contains `..` or a path separator (`reject_unsafe_output_name`). |

## Detectors

| Issue type | What it catches | `suggested_action` |
| --- | --- | --- |
| `low_resolution` | Global Laplacian-variance blur, and/or the image being smaller than the connected placeholder bounds. | `image_enhance` |
| `face_blur` / `low_resolution` | Locally soft tiles from an 8-column sharpness grid, merged into boxes (`face_blur` when `face` is watched, else `low_resolution`). | `detail_redraw` |
| `edge_halo` | A bright fringe on the semi-transparent alpha rim of a cut-out (only when `product_edges` is watched). | `edge_refine` |
| `color_mismatch` | The subject's mean colour drifting from the connected background `mean_color`. | `color_match` |
| `malformed_hands` | A loaded detector class mapped to `hands`. | `detail_redraw` |
| `garbled_text` | A loaded detector class mapped to `text`. | `detail_redraw` |
| `deformed_logo` | A loaded detector class mapped to `logo`. | `detail_redraw` |

The per-mode thresholds (`blur_floor`, `region_ratio`, `region_floor`,
`halo_delta`, `color_delta`) widen from `strict` → `balanced` → `lenient`. The
soft-region grid is fixed at **8 columns**, with rows scaled to the aspect
ratio (capped at 8).

## Colour space & bit depth

The decode is normalised to an 8-bit RGB working space (plus a separate alpha
plane) so the luminance / sharpness / colour heuristics sample honest data; the
source's original mode is recorded as `source_mode`:

| Source mode | Handling |
| --- | --- |
| `RGB` / `RGBA` / `L` / `LA` | Used directly; alpha (when present) feeds halo detection. |
| `P` (palette) | Expanded to RGB(A); transparency in `info` is treated as alpha. |
| `CMYK` | Converted to sRGB via the embedded ICC profile when present, else a naive convert. |
| `I` / `I;16*` / `F` (high bit) | Data range normalised down to 8-bit before RGB conversion. |

## Boundary behaviour

| Condition | Behaviour |
| --- | --- |
| Missing / blank `image` input | Rust handler errors `Detail Watchdog needs a connected image input`. |
| Missing/unsupported/unsafe image source | Native runner returns `Detail Watchdog could not decode <path>: unsupported source for the native path`. |
| Input larger than 96,000,000 pixels | Rejected by the shared loader before decode and surfaced through the native-source error above. |
| Unknown `mode` | `unknown mode ...; expected one of [...]`. |
| Unknown `watch_targets` entry | `unknown watch target(s): [...]; expected [...]`. |
| Unknown `engine` | Rule-only report; `engine: rules`, `engine_fallback_reason: "unknown engine '...'"` (no error). |
| `onnx_defect` runtime/weight/session/inference unavailable | Complete rule-only report; `engine: rules`, `engine_fallback_reason` explains; uncovered targets stay `skipped`. |
| Invalid ONNX input/output name, type, shape, length or non-finite value | Detector is rejected and the complete rule result is retained with the validation error in `engine_fallback_reason`. |
| EXIF-rotated input | Orientation normalised via the orientation tag; `exif_transposed: true`. |
| No issues found | `status: passed`, `issues: []`, no overlay PNG written. |
| Unsafe `output_name` (`..`, separators) | Rejected server-side. |

## `quality_report` / `watchdog_report` fields

`quality_report` follows the shared contract: `status`
(`passed` \| `warning` \| `failed`) and `issues` (each `type`, `confidence`,
`bbox` `[x1,y1,x2,y2]`, `suggested_action`).

`watchdog_report` (diagnostics): `mode`, `watch_targets`, `skipped_targets`,
`image_size`, `target_size`, `global_sharpness`, `source_mode`,
`exif_transposed`, `max_decode_pixels`, `mask_consumed`, and the engine-seam
telemetry: `engine` (what actually ran — `rules` or a detector id),
`engine_requested` (what was asked for), `engine_fallback_reason` (engine or
device fallback detail, else `null`), `detectors` (learned passes that ran on
top of the rule layer), `backend_model` (the loaded weight file name, else
`null`), `device` (provider actually used), and `device_requested`.

## Engine seam (opt-in ML detectors)

The rule layer is the always-on baseline. Native `onnx_defect` reuses the
process-wide ORT session pool and the managed model-path resolver. It accepts
one float32 RGB NCHW input, letterbox-resized to the model's fixed spatial
shape (dynamic axes use 640), with optional ImageNet normalisation from the
sidecar. It accepts either strict `boxes [N,4]` / `scores [N]` / integer
`labels [N]` outputs or one DB probability map `[1,1,H,W]`; the latter is
thresholded at 0.3 and split into 4-connected components. Score floor is 0.35.

The sidecar is `<weight>.labels.json`, either a bare class map or
`{"labels":{"0":"text"},"normalize":"imagenet"}`. Only mapped targets are
removed from `skipped_targets`, even when no defect is found. The supplied
Windows fetch script installs the Apache-2.0 PP-OCRv3 text detector, so that
weight covers `text` only; `hands` and `logo` remain skipped until compatible
trained weights are integrated. No Python, Paddle runtime, Torch or OpenCV is
added.

| Engine | Deps | Weight | Covers | Emits |
| --- | --- | --- | --- | --- |
| `rules` | none | none | `face`, `product_edges` (+ global blur / colour) | `low_resolution`, `face_blur`, `edge_halo`, `color_mismatch` |
| `onnx_defect` | vendored Windows x64 ORT runtime | managed `watchdog_defect.onnx` + sidecar | sidecar-mapped subset of `hands`, `text`, `logo` | `malformed_hands`, `garbled_text`, `deformed_logo` |

Install the current text detector from a Windows checkout:

```powershell
.\scripts\fetch-watchdog-text.ps1
cargo test -p hgripe-desktop onnx_defect_inference_when_weight_present -- --nocapture
```

## Outputs (ports)

| Port | Type | Notes |
| --- | --- | --- |
| `fixed_image` | image path | The candidate, **unchanged** in Phase 1 (detect-only). |
| `quality_report` | JSON | The report above. |
| `issue_masks` | image path \| null | Overlay PNG with a red box per flagged region; null when no issues are found. |
| `watchdog_report` | JSON | The diagnostics above. |

## Tests

- `src-tauri/src/studio/detail_watchdog_cpu.rs` — sharp image passes and
  reports the hardening fields, low-resolution below target, edge halo on a rim,
  unsupported targets recorded as skipped, overlay written / suppressed, decode
  guard, CMYK and palette source mode, the advisory mask, invalid mode / watch
  target, missing image, and the `engine` dispatch (default `rules`,
  unknown-engine fallback) (run: `cargo test`).
- `src-tauri/src/studio/detail_watchdog.rs` — the connected-image-input guard
  and `WatchdogReport` deserialization of the v1 hardening fields, the engine-
  seam telemetry fields, and legacy JSON defaults.
- `src-tauri/src/studio/detail_watchdog_onnx.rs` — model/sidecar resolution,
  letterbox and ImageNet preprocessing, probability-map connected components,
  strict output validation, inverse box scaling, and the weight-gated real ORT
  inference path.
