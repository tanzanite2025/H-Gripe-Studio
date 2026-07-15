# Match Light & Color card

Executor: **local** (in-process native Rust, never networks).
Backend: `match_light_color` Tauri command -> `studio/color_match_cpu.rs`
(complete native CPU baseline) plus the opt-in `studio/color_match_onnx.rs`
PCT-Net path. The Python bridge was deleted in Phase 7 (#314).

Nudges a generated/cut-out subject toward a PSD background's light & colour so a
composite stops looking pasted-on. This document is the card's contract: what it
accepts, what it guarantees, and how it behaves at the edges. The default match
is a heuristic Reinhard / histogram transfer in Lab. The optional
`onnx_harmonize` engine runs a native PCT-Net model behind the same contract and
keeps the complete CPU result whenever learned inference cannot run safely.

## Inputs (ports)

| Port | Type | Required | Notes |
| --- | --- | --- | --- |
| `image` | image path | yes | The subject to correct. Its alpha defines the corrected region. |
| `background` | image path | no | The reference whose light/colour the subject is matched to. Without it the pixels pass through unchanged (`prompt_only`-like). |
| `mask` | image path | no | Narrows the corrected region further (multiplied into the subject alpha). |
| `visual_context` | JSON | no | Upstream PSD context; its `prompt_suffix` / `lighting` drives the emitted prompt suffix. |

## Parameters

| Param | Type | Default | Range / values | Notes |
| --- | --- | --- | --- | --- |
| `mode` | enum | `color_transfer` | `prompt_only` \| `color_transfer` \| `histogram_match` \| `hybrid` | `prompt_only` never touches pixels; `hybrid` runs transfer then a gentler histogram pass. |
| `strength` | float | `0.6` | `0..1` | Overall correction weight (base per-pixel blend). |
| `shadow_strength` | float | `0.0` | `0..1` | Extra correction weight in shadows (low L). |
| `highlight_strength` | float | `0.0` | `0..1` | Extra correction weight in highlights (high L). |
| `protect_saturation` | bool | `false` | | Match **luminance only**; the subject keeps its own a/b chroma. |
| `protect_brand_color` | bool | `true` | | Damps the shift on high-chroma (brand) pixels so a logo colour is not pulled toward the background. |
| `engine` | enum | `cpu` | `cpu` \| `onnx_harmonize` | The learned engine is opt-in; every failure keeps the complete CPU result. |
| `device` | enum | `auto` | `auto` \| `cpu` \| `gpu` | Used only by `onnx_harmonize`. Legacy `cuda` / `directml` requests remain accepted. The current ORT package is CPU-only, so accelerated requests report a CPU fallback. |
| `max_decode_pixels` | int | `96_000_000` | `>= 0` (0 disables) | Rejects an **input** (subject or background) larger than this before decoding (decompression-bomb guard). |
| `output_dir` | path | run output dir | | Validated server-side. |
| `output_name` | basename | `<image>_matched` | plain basename | Rejected if it contains `..` or a path separator (`reject_unsafe_output_name`). |

## Corrected region

The correction is applied inside the **subject alpha**, optionally narrowed by a
connected `mask`. If that leaves no coverage (fully transparent or empty mask),
the whole frame is used as a fallback. Transparent subject pixels keep their
original RGB (their correction weight is zero); the alpha channel is recombined
unchanged.

## Background statistics

Only **opaque** background pixels describe the target light/colour. The
background's own alpha is used as a weight, so a cut-out background plate's
transparent regions do not skew the target mean/std (in either the Reinhard
transfer or the histogram reference). If the background is fully transparent the
whole frame is used as a fallback.

## Modes

- **`prompt_only`** — writes a copy of the subject unchanged and emits only the
  prompt suffix. `applied: false`.
- **`color_transfer`** — Reinhard mean/std transfer in Lab toward the background
  stats. The per-channel std ratio is clamped to `0.5..2.0` so a near-flat
  subject channel cannot blow up.
- **`histogram_match`** — per-channel CDF match of the subject onto the
  (opaque) background.
- **`hybrid`** — transfer first, then a gentler (0.5×) histogram pass so the
  transfer stays dominant.

`protect_saturation` restricts every mode to the L channel. `protect_brand_color`
multiplies the correction weight by `1 - clamp(chroma/110, 0, 1)`, sparing
saturated pixels.

## Native PCT-Net engine

`onnx_harmonize` is a concrete PCT-Net ViT integration, not a generic
first-input/first-output ONNX hook. It composites the subject over the resized
visible background using the effective soft matte (subject alpha multiplied by
the optional connected mask), then feeds four named float32 NCHW tensors in
`[0, 1]`:

At least one percent of the model frame must expose background through that
matte. A fully opaque subject with no connected subject mask cannot carry any
reference-background context in PCT-Net's composite input, so that case is
reported and keeps the CPU match instead of claiming learned success.

| Tensor | Shape | Purpose |
| --- | --- | --- |
| `image_lr` | `1x3x256x256` | Composite image for the fixed low-resolution transformer branch. |
| `image_fullres` | `1x3xHxW` | Composite image at subject resolution. |
| `mask_lr` | `1x1x256x256` | Foreground alpha mask for the low-resolution branch. |
| `mask_fullres` | `1x1xHxW` | Foreground alpha mask at subject resolution. |

The named float32 `output` is `1x3xHxW`, so learned RGB returns at full
resolution. The exported low-resolution axes are dynamic, but the native
contract deliberately supplies 256x256. PCT-Net returns a background-composited
RGB image; the native postprocess removes that reference background through the
same effective matte before treating the result as straight RGB. This prevents
soft alpha edges from receiving the background twice when the output is later
composited. The learned candidate is still blended through `strength`,
shadow/highlight weighting, subject alpha, the optional connected mask, and
brand/saturation protections. The original subject alpha is recombined
unchanged.

The supported local artifact is `color_harmonize.onnx` (`24819882` bytes,
SHA-256
`5ac3c8f59ad3a58a55baae79f3886e06826e7acb932179aaed034b61d62f5997`).
It is an unofficial third-party conversion from
[`pccaza/harmonizer-onnx`](https://github.com/pccaza/harmonizer-onnx) commit
`046a31654875432fe303d5342aa036782270c520`; that conversion repository is MIT.
The official
[`rakutentech/PCT-Net-Image-Harmonization`](https://github.com/rakutentech/PCT-Net-Image-Harmonization)
upstream review reference is commit
`1572176ed1a72217dad7395391615329b98d30c7` and is MPL-2.0. The converter did
not identify its exact upstream revision/checkpoint or export procedure, so
that reference is not verified artifact lineage. This is not an official
Rakuten/PCT-Net ONNX export, is not release-ready by default, and is not bundled
by default. See the tracked
[`COLOR_HARMONIZE_NOTICE.md`](../../apps/desktop-tauri/src-tauri/resources/models/COLOR_HARMONIZE_NOTICE.md)
before any distribution decision.

The resolver checks `HGRIPE_COLOR_MODEL`, the persisted `onnx_harmonize` model
path, environment/configured shared caches, and finally packaged/development
resource locations. The model reuses the process-wide warm ORT session pool.

The current Windows x64 ORT 1.24.2 package binds the CPU execution provider
only. Provider resolution already drives session creation, and the warm-pool key
includes runtime flavor, actual provider, and device id; accelerated requests
therefore share the real CPU fallback session without being reported as GPU. A
later Windows provider stage must add NVIDIA CUDA and AMD/Intel DirectML locked
runtimes, strict registration, CPU retry, packaging, and hardware tests before
either device can be reported as active. ROCm is not a Windows target.

### Fallback contract

The full Lab/histogram CPU match is computed first. A validated PCT-Net result
replaces it only after successful model resolution, session creation, strict
input/output validation, and inference. Missing or malformed weights, runtime
or session failures, invalid tensors, inference errors, and panics keep the CPU
image and record `engine_fallback_reason`. `prompt_only`, zero strength, and a
missing background also keep the CPU pass-through with an explicit reason.
Unknown engine ids follow the same CPU fallback contract.

## Colour space & bit depth

> Working space / bit depth / ICC handling is defined once in
> [`docs/design/colour-pipeline.md`](../design/colour-pipeline.md) (the source
> of truth). That pipeline (P1–P5) has **landed**: this card sits at the
> model/preview boundary, so the 8-bit sRGB working space below is the
> *decided contract*, not a gap. ProPhoto-tagged 16-bit manual products are
> colour-managed to sRGB at ingress (wide-gamut ingress in the native decode path, #202).

Both inputs are normalised to an 8-bit RGB working space; the subject's original mode is
recorded as `source_mode`, the background's as `background_mode`:

| Source mode | Handling |
| --- | --- |
| `RGB` / `RGBA` / `L` / `LA` | Used directly; alpha (when present) defines the region. |
| `P` (palette) | Expanded to RGB(A); transparency in `info` is treated as alpha. |
| `CMYK` | Converted to sRGB via the embedded ICC profile when present, else a naive convert. |
| `I` / `I;16*` / `F` (high bit) | Data range normalised down to 8-bit before RGB conversion. |

## Boundary behaviour

| Condition | Behaviour |
| --- | --- |
| Missing / blank `image` input | Rust handler errors `Light & Color Match needs a connected image input`. |
| Missing file on disk | `subject image not found: <path>` (or `background image not found`). |
| No `background` connected (pixel mode) | Subject passed through unchanged; `applied: false`, `note` records why. |
| `strength = 0` | Pass-through; `applied: false`. |
| Unknown `mode` | `ValueError: unknown mode ...`. |
| Input larger than `max_decode_pixels` | `ValueError: input image too large to decode safely: WxH ...` (before decode). |
| Transparent background regions | Excluded from the target statistics (alpha-weighted). |
| Fully transparent background with `onnx_harmonize` | Learned inference is skipped; the complete CPU result remains. |
| Fully opaque subject with no mask exposing background | PCT-Net has no reference context, so learned inference is skipped and the complete CPU match remains. |
| Transparent subject regions | Left unchanged (zero correction weight). |
| Missing/invalid `color_harmonize.onnx` or ORT failure | Complete CPU match remains; `engine_fallback_reason` records why. |
| PCT-Net subject or background above a 4096 px edge or 4194304 total pixels | Learned inference is skipped; complete CPU match remains. The bound prevents unbounded retained RGBA/matte and ORT peaks; larger images retain the CPU match. |
| Invalid `visual_context` JSON | Ignored; the suffix is synthesised from the background. |
| EXIF-rotated input | Orientation normalised; `exif_transposed: true`. |
| Unsafe `output_name` (`..`, separators) | Rejected server-side. |

## `match_report` fields

`mode`, `strength`, `shadow_strength`, `highlight_strength`,
`protect_saturation`, `protect_brand_color`, `source_mode`, `background_mode`,
`exif_transposed`, `max_decode_pixels`, `applied`, `before`, `after`,
`output_size`, optional `note`, and (when a transfer runs) `src_mean_lab`,
`dst_mean_lab`, `src_std_lab`, `dst_std_lab`. `before` / `after` each carry
`mean_color`, `color_temperature`, `contrast`. Engine telemetry adds `engine`,
`engine_requested`, `engine_fallback_reason`, `backend_model`, `device`, and
`device_requested`. Successful PCT-Net inference clears the CPU Lab statistics
because those statistics did not produce the learned candidate.

## Outputs (ports)

| Port | Type | Notes |
| --- | --- | --- |
| `matched_image` | image path | The corrected RGBA PNG (alpha unchanged). |
| `match_report` | JSON | The report above. |
| `prompt_suffix` | string | Lighting hint reused from `visual_context` or synthesised from the background colour temperature. |

## Tests

- `src-tauri/src/studio/color_match_cpu.rs` — transfer moves the mean toward
  the background, hybrid stats, `protect_saturation` keeps chroma, background-
  alpha weighting, subject transparent region untouched, decode guard, CMYK /
  high-bit source modes, invalid context, output naming, unknown-engine and
  learned-engine CPU fallback (run: `cargo test`).
- `src-tauri/src/studio/color_match_onnx.rs` - strict four-input PCT-Net model
  contract, effective-matte composite, fixed 256x256 branch, straight-RGB
  recovery for soft alpha, output validation, resource limits, and
  preprocessing.
- `src-tauri/src/studio/color_match.rs` — the connected-image-input guard and
  param defaults.

The real model test is Windows-only and skips without the optional weight:

```powershell
.\scripts\fetch-color-harmonize.ps1
cargo test -p hgripe-desktop pctnet_inference_when_weight_present -- --nocapture
```

The manual `tauri (PCT-Net harmonize e2e)` CI job runs the same locked fetch and
test. It does not make the third-party artifact a default release bundle.
