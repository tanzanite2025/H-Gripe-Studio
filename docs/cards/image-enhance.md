# Image Enhance / Super Resolution card

Executor: **local** (in-process native Rust, never networks).
Backend: `enhance_image` Tauri command → `studio/image_enhance_cpu.rs` plus
`studio/image_enhance_onnx.rs` (native Rust). The Python bridge and its Torch
engines remain deleted.

Upscales and restores a low-resolution subject so it fills a PSD placeholder at
print DPI without going soft. This document is the card's contract: what it
accepts, what it guarantees, and how it behaves at the edges. The default
`cpu` engine is always available; the optional `realesrgan` engine runs a
strict native ONNX contract and preserves the CPU path as its complete fallback.

## Inputs (ports)

| Port | Type | Required | Notes |
| --- | --- | --- | --- |
| `image` | image path | yes | The subject to enhance. |
| `target_bounds` | `{x, y, width, height}` | no | Connected PSD placeholder rect; used to derive the target size when no explicit target is set. |

## Parameters

| Param | Type | Default | Range / values | Notes |
| --- | --- | --- | --- | --- |
| `mode` | enum | `conservative` | `conservative` \| `texture_rebuild` \| `print_ready` \| `custom` | Presets set denoise/texture; `custom` uses the sliders below. |
| `engine` | enum | `cpu` | `cpu` \| `realesrgan` | Upscale backend. `cpu` is the built-in Lanczos+sharpen path; `realesrgan` is the optional native ORT model. Legacy `ccsr` / `supir` values remain readable and fall back to `cpu` with a migration reason. |
| `device` | enum | `auto` | `auto` \| `gpu` \| `cpu` | Compute request for `realesrgan`; ignored by `cpu`. The current ORT payload is CPU-only, so `auto`/`gpu` report the provider fallback. Legacy `cuda` / `directml` values remain accepted. |
| `precision` | enum | `auto` | `auto` \| `fp32` | Model precision request; ignored by `cpu`. The supported weight is FP32, so `auto` resolves to `fp32`. A legacy `fp16` request runs FP32 and reports that downgrade. |
| `target_width` | int px | `0` | `>= 0` (0 = auto) | Explicit target wins over `target_bounds`. |
| `target_height` | int px | `0` | `>= 0` (0 = auto) | |
| `target_dpi` | int | `300` | `>= 1` | Written into the output PNG metadata only. |
| `scale` | float | `2.0` | `> 0` | Fallback factor when no target size is resolved (`custom`). |
| `denoise_strength` | float | `0.3` | `0..1` | Edge-preserving median blend (`custom`). |
| `texture_strength` | float | `0.25` | `0..1` | Unsharp-mask detail (`custom`). |
| `preserve_text_logo` | bool | `true` | | On `cpu`, caps `texture_strength` at `0.4` so logos/packaging text are not mangled. Real-ESRGAN adds no CPU post-sharpen. |
| `max_pixels` | int | `48_000_000` | `>= 0` (0 disables) | Caps **output** pixels; the scale is reduced to fit and `clamped` is reported. |
| `output_dir` | path | run output dir | | Validated server-side. |
| `output_name` | basename | `<image>_enhanced` | plain basename | Rejected if it contains `..` or a path separator (`reject_unsafe_output_name`). |

### Presets

| Preset | scale | denoise | texture |
| --- | --- | --- | --- |
| `conservative` | 2.0 | 0.30 | 0.25 |
| `texture_rebuild` | 2.0 | 0.15 | 0.70 |
| `print_ready` | 2.0 | 0.20 | 0.50 |

## Target-size resolution

1. Explicit `target_width` / `target_height` (if either > 0).
2. Else `target_bounds.{width,height}` from a connected placeholder.
3. Else the preset/`custom` `scale`.

The factor is **uniform** (aspect ratio preserved) and **covers** the target so
both dimensions reach it; the final crop/fit into the placeholder is left to PSD
Export. If the output would exceed `max_pixels`, the scale is reduced to fit and
`clamped: true` is reported.

## Pipeline

Ingress, target resolution, colour management, alpha, output naming, ICC and
DPI are shared by both engines. The alpha channel is split before either colour
pipeline, resized independently, and recombined only at the end; the learned
model never receives or changes alpha.

- **CPU upscale** (`scale > 1`): median denoise → Lanczos resample → unsharp.
- **CPU downscale** (`scale < 1`): triangle filter; unsharp is **skipped**
  (`texture_strength` is reported as `0.0`) — sharpening a shrink only amplifies
  resampling artefacts.
- **CPU denoise**: an edge-preserving median filter blended in by `denoise_strength`
  (a Gaussian blur would smear the very edges we are about to sharpen).
- **Real-ESRGAN upscale**: RGB `[0,1]` NCHW inference in 128px core tiles with
  a 16px context halo. The halo is cropped in native 4x output space, tiles are
  assembled once, then the result is resampled in linear light to the exact
  resolved output size. CPU denoise/unsharp are not applied, so both strengths
  report `0.0` on model success.
- **Real-ESRGAN bounds**: the native 4x intermediate is capped at 48,000,000
  pixels. A non-enlarging request or larger intermediate keeps the complete CPU
  result and records the reason.

## Colour space & bit depth

> **Source of truth:** the working space, bit depth, ICC handling, and the
> manual/model split are defined in
> [`docs/design/colour-pipeline.md`](../design/colour-pipeline.md). That
> pipeline (P1–P5) has **landed**: this card sits at the model/preview
> boundary, so its 8-bit sRGB working space below is the *decided contract*,
> not a gap. ProPhoto-tagged 16-bit manual products (the Rust chain's
> outputs) are colour-managed to sRGB at ingress (#202; the cpu path drops
> the stale profile on output, #203), and the colour resample runs in linear
> light (#205).

The input is normalised to an 8-bit RGB working space according to its probed
source type:

| Source mode | Handling |
| --- | --- |
| `RGB` / `RGBA` / `L` / `LA` | Used directly; a compatible embedded ICC profile is preserved on output. |
| `P` (palette) | Expanded to RGB(A); transparency in `info` is treated as alpha. |
| `CMYK` | Converted to sRGB via the embedded ICC profile when present, else a naive convert; the CMYK profile is not carried onto sRGB output. |
| single-channel 16-bit (`L16` / `I;16*`) | Data range normalised down to 8-bit before RGB conversion. |
| other 16-bit integer RGB(A) / LA | Narrowed to 8-bit with the same high-byte behaviour as the native decoder. |
| `Rgb32F` / `Rgba32F` | Unsupported by the card's defined 8-bit sRGB boundary; returns the native unsupported-source error. |

### `engine = cpu` in-process pipeline (Rust)

The `cpu` engine runs entirely in-process: `studio/image_enhance_cpu.rs`
implements the pipeline (Lanczos3 / triangle resample, unsharp, edge-preserving
median denoise, independent alpha track). It was originally built as a
behaviour-preserving fast path mirroring the Python CLI and is now, post
Phase 7, the always-available implementation and model fallback.

| Source colour | In-process (Rust) | Notes |
| --- | --- | --- |
| 8-bit `RGB` / `RGBA` / `L` / `LA` | ✅ | Embedded ICC re-embedded on output (iCCP) + DPI (pHYs). |
| 16-bit `Rgb16` / `Rgba16` / `La16` | ✅ | High byte kept (PIL / `into_rgba8` parity). |
| single-channel 16-bit (`I;16`, `L16`) | ✅ | Range-scaled by the source's own peak to 8-bit, not a naive `>>8`. |
| `CMYK` (TIFF) | ✅ | Raw ink samples + embedded ICC read via `cmyk_decode` (bypassing the `image` crate, which drops them at decode), then colour-managed to sRGB via `cmyk_transform` (the profile's A2B LUT through `moxcms`, else PIL's naive formula). Output is sRGB, so the source CMYK profile is dropped (`icc_preserved: false`). See below. |
| `CMYK` (Adobe JPEG) | ✅ | APP14 transform-0 JPEGs store *inverted* ink (0 = full ink); `cmyk_decode` undoes it (`255 - v`) so the samples match TIFF Separated, then the same `cmyk_transform` path applies. |
| `CMYK` (YCCK JPEG) | ✅ | APP14 transform-2 JPEGs (`zune` reports a `YCCK` input colourspace). Instead of `zune`'s lossy YCCK→RGB (which drops the ICC), the output colourspace is pinned to `YCCK` so `zune` copies the raw Y/Cb/Cr/K planes through; `cmyk_decode` reconstructs CMYK (libjpeg's `ycck_cmyk_convert`) and undoes the inversion, keeping the ICC, then the same `cmyk_transform` path applies. |
| `CMYK` (unmarked JPEG) | ✅ | A 4-component JPEG with no APP14 Adobe marker (`zune` defaults it to `CMYK`). Treated exactly like Adobe CMYK (`255 - v`); the same `cmyk_transform` path applies. |
| `Rgb32F` / `Rgba32F` (float) | ⛔ | No defined range mapping at the card's 8-bit sRGB boundary; the historical Python fallback is gone. |

Landed: [#172](https://github.com/tanzanite2025/H-Gripe-Studio/pull/172)
(8-bit fast path), [#174](https://github.com/tanzanite2025/H-Gripe-Studio/pull/174)
(16-bit range-scale + ICC/DPI preserve),
[#176](https://github.com/tanzanite2025/H-Gripe-Studio/pull/176) /
[#177](https://github.com/tanzanite2025/H-Gripe-Studio/pull/177) /
[#178](https://github.com/tanzanite2025/H-Gripe-Studio/pull/178) (CMYK TIFF c1–c3).

### CMYK → sRGB in-process (landed: TIFF + Adobe JPEG)

CMYK samples and the embedded profile are read straight from the container
(bypassing the `image` crate, which converts CMYK→RGB and drops the profile at
decode) and colour-managed to sRGB before the normal pipeline. Shipped as small,
independently reviewable, CI-verifiable steps:

- **c1 — raw CMYK decoder ([#176](https://github.com/tanzanite2025/H-Gripe-Studio/pull/176)).**
  `studio/cmyk_decode.rs` returns the raw 4-channel CMYK samples + optional ICC
  from JPEG (`zune-jpeg`, output colourspace pinned to CMYK) and TIFF (`tiff`,
  `ColorType::CMYK(8)`) sources, reusing the shared decompression-bomb budget.
- **c2 — `moxcms` CMYK→sRGB transform ([#177](https://github.com/tanzanite2025/H-Gripe-Studio/pull/177)).**
  `cmyk_transform::cmyk_to_rgb8` runs the embedded profile's A2B LUT into sRGB
  (perceptual intent, mirroring the CLI's `ImageCms.profileToProfile`), and
  falls back to PIL's *naive* formula (`out = (255-K) - muldiv255(255-K, ink)`,
  byte-exact) when there is no usable profile.
- **c3 — wired behind the gate ([#178](https://github.com/tanzanite2025/H-Gripe-Studio/pull/178)).**
  `try_enhance` routes **TIFF** CMYK through `cmyk_decode` + `cmyk_to_rgb8` →
  the normal pipeline → sRGB PNG (source profile dropped, `icc_preserved: false`).
  At the time, CMYK **JPEGs** and any decode/transform miss returned
  `Ok(None)` → the then-extant Python fallback (since removed; c3b/c3c below
  closed the JPEG gaps natively).
- **c3b — Adobe CMYK JPEG in-process.**
  `cmyk_decode` now also takes **Adobe** CMYK JPEGs (an APP14 marker with
  transform 0): Adobe stores inverted ink (0 = full ink) that PIL/libjpeg
  normalise on load, so we apply `255 - v` after `zune-jpeg` decode to land in
  the device direction (0 = no ink) that TIFF Separated and `cmyk_transform`
  expect. A committed PIL-generated fixture
  (`tests/fixtures/cmyk_adobe_app14.jpg`, regenerable via
  `scripts/gen_cmyk_jpeg_fixture.py`) is decoded + transformed in Rust and
  compared to Pillow's RGB within tolerance, so an inversion-direction error
  fails CI immediately.
- **c3c — YCCK JPEG in-process + probe routing fix.**
  Two parts:
  - **Routing.** The `image` crate decodes *both* CMYK and YCCK JPEGs to RGB and
    reports them as `Rgb8`, so `probe_source` never saw `Cmyk8` for a JPEG and
    CMYK/YCCK JPEGs silently took the generic RGB path (dropping the ICC) rather
    than `cmyk_decode` — the c3b Adobe path was effectively unreachable in
    production. `probe_source` now sniffs the JPEG itself
    (`cmyk_decode::is_cmyk_family_jpeg`, via `zune`'s input colourspace) and
    reclassifies CMYK-family JPEGs as `Cmyk8` so they reach the CMYK fast path;
    `decode_cmyk` still returns `None` for shapes it won't take (float, etc.),
    which now fall through to the generic `image`-crate decode.
  - **YCCK decode.** `zune` only offers a lossy YCCK→RGB that drops the ICC.
    Instead the output colourspace is pinned to `YCCK`, so `zune`'s same
    4-channel straight-through copy hands back the raw Y/Cb/Cr/K planes with the
    ICC intact; `cmyk_decode` reconstructs CMYK the way libjpeg's
    `ycck_cmyk_convert` does (YCbCr→RGB, then C=255-R, M=255-G, Y=255-B, K
    passthrough) and undoes the Adobe inversion to reach the device direction.
    No `zune` fork/patch is needed. A committed fixture
    (`tests/fixtures/cmyk_ycck_app14.jpg`, regenerable via
    `scripts/gen_ycck_jpeg_fixture.py` using `imagecodecs`, since Pillow only
    emits transform 0) is decoded + transformed in Rust and compared to Pillow's
    RGB within tolerance.
- **c4 — colour-accuracy regression + docs (this section).** The naive CMYK→sRGB
  table is asserted byte-for-byte in Rust against a PIL-derived reference
  (`cmyk_transform` test `naive_matches_pil_convert_rgb`). The ICC (profiled)
  path is checked against a littleCMS reference locally (moxcms is not
  byte-identical to littleCMS; small ΔE), skipped on runners without a system
  CMYK profile. (The live-Pillow cross-language half of this regression was
  deleted with the Python CI in Phase 7.)
- **c5 — ICC fidelity: tetrahedral interpolation + rendering intent
  ([#185](https://github.com/tanzanite2025/H-Gripe-Studio/pull/185)).** The
  profiled path now walks the CMYK A2B LUT with **tetrahedral** interpolation
  and high-precision barycentric weights (moxcms `options` feature), matching
  littleCMS/lcms2 instead of moxcms's default quadlinear, so the residual ΔE vs
  the Python reference shrinks. Rendering intent is configurable
  (`cmyk_to_rgb8_with_intent`) but defaults to Perceptual, mirroring Pillow's
  `profileToProfile`. No black-point compensation: Pillow defaults to `flags=0`
  (BPC off) and moxcms 0.8.1 does not expose it, so adding it would *diverge*
  from the reference rather than align.
- **c6 — unmarked CMYK JPEG in-process
  ([#186](https://github.com/tanzanite2025/H-Gripe-Studio/pull/186)).** A
  4-component JPEG with no APP14 Adobe marker (`zune` defaults it to `CMYK`).
  Pillow inverts the stored ink to the device direction *unconditionally* —
  marker or not — so `cmyk_decode` now takes `(CMYK, transform 0 | no marker)`
  and applies the same `255 - v` as Adobe CMYK. A committed fixture
  (`tests/fixtures/cmyk_unmarked.jpg`, the Adobe fixture with its APP14 segment
  stripped, regenerable via `scripts/gen_unmarked_cmyk_jpeg_fixture.py`) is
  decoded + transformed in Rust and compared to Pillow's RGB within tolerance.


## Boundary behaviour

| Condition | Behaviour |
| --- | --- |
| Missing / blank `image` input | Rust handler errors `Image Enhance needs a connected image input`. |
| Missing file on disk | `base image not found: <path>`. |
| Unknown `mode` | `unknown mode ...`. |
| Input larger than the fixed 96,000,000-pixel decode guard | `input image too large to decode safely: WxH ...` (before decode). |
| `Rgb32F` / `Rgba32F` source | `Image Enhance could not process ...: unsupported source for the native path`. |
| Cut-out subject (has alpha) | Alpha is isolated from denoise/model inference and follows only the resolved geometric resize. |
| EXIF-rotated photo | Orientation normalised; `exif_transposed: true`. |
| Broken EXIF block | Ignored; enhancement proceeds. |
| Unsafe `output_name` (`..`, separators) | Rejected server-side. |
| `realesrgan` weight/runtime/session/inference/tensor failure | Complete `cpu` image is written; reason appears in `engine_fallback_reason`. |
| `realesrgan` requested for scale `<= 1` | Model is skipped; complete `cpu` result is written. |
| `realesrgan` native 4x surface exceeds 48,000,000 pixels | Model is skipped before session resolution; complete `cpu` result is written. |

## Engines

The `engine` param is the **local-card backend seam** from
`docs/design/executor-split-and-psd-chain-hardening.md` (§2.5 / §3.4).
`probe_engines` reports both the always-on CPU baseline and whether the managed
Real-ESRGAN weight plus locked Windows ORT runtime resolve on this machine.
Probe readiness is advisory; session validation and the per-run report remain
the execution truth.

| Engine | Deps | Weight | Behaviour |
| --- | --- | --- | --- |
| `cpu` (default) | none (native Rust) | none | Lanczos resample + unsharp mask + edge-preserving median denoise. Always available. |
| `realesrgan` | repository-locked Windows ORT through Rust `ort` | optional `realesrgan_x4v3.onnx` | Deterministic Real-ESRGAN general x4v3 restoration, tiled with halo, then one exact-size resample. Current provider/precision is CPU/FP32. Missing or invalid model/runtime/inference always falls back to `cpu`. |

The optional weight resolves in this order: `HGRIPE_REALESRGAN_MODEL`, the
persisted `realesrgan` model-path override, `HGRIPE_MODEL_CACHE` / configured
cache, then packaged/development `resources/models/realesrgan_x4v3.onnx`.
It is not downloaded at runtime or bundled by default. The pinned verification
artifact is a third-party re-host and is not release-approved; see
[`../apps/desktop-tauri/src-tauri/resources/models/REALESRGAN_NOTICE.md`](../../apps/desktop-tauri/src-tauri/resources/models/REALESRGAN_NOTICE.md).

## `enhance_report` fields

`mode`, `scale_factor`, `source_size`, `output_size`, `target_size`,
`target_dpi`, `max_pixels`, `clamped`, `denoise_strength`, `texture_strength`,
`preserve_text_logo`, `engine`, `engine_requested`, `engine_fallback_reason`,
`backend_model`, `device`, `device_requested`, `precision`,
`precision_requested`, `processing_time_ms`.

## Tests

- `src-tauri/src/studio/image_enhance_cpu.rs` — alpha isolation, CMYK /
  high-bit handling, downscale path, decode guard, target resolution, clamp,
  logo guard, output naming, ICC preservation, engine fallback telemetry, and
  the weight-gated real tiled inference test.
- `src-tauri/src/studio/image_enhance_onnx.rs` — NCHW packing, tile coverage,
  halo cropping, output shape/value validation and native-surface limits.
- `src-tauri/src/studio/image_enhance.rs` plus `psd/cards.rs` — graph and direct
  command entry contracts.

Manual Windows verification:

```powershell
.\scripts\fetch-realesrgan.ps1
cargo test -p hgripe-desktop realesrgan_inference_when_weight_present -- --nocapture
```

Without the weight the real-inference test skips. The manual-dispatch Windows
CI job performs the same locked fetch and test; this validates integration but
does not approve the third-party artifact for release bundling.
