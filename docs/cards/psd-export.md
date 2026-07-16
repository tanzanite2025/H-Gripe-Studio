# PSD Export (compose) card

Executor: **local** (in-process native Rust, never networks).
Backend: `compose_psd` Tauri command → the native PSD writer
(`psd/compose.rs` + `psd/write.rs` + `psd/smart.rs`, CPU-only). There is no
secondary scripting backend or runtime fallback.

The **final assembler** of the PSD chain: it writes a generated image into a PSD
template's placeholder — using true smart-object content replacement when the
placeholder is a smart object — and exports the production triplet
`<filename>.psd` + `<filename>_preview.png` + `<filename>_metadata.json`. Every
upstream card (analyze → match → refine → enhance → watchdog → repaint) feeds
this one, so its loader is hardened to accept whatever those cards (or a user's
own asset) hand it. This document is the card's contract.

## Inputs (ports)

| Port | Type | Required | Notes |
| --- | --- | --- | --- |
| `image` | image path | yes | The generated subject to place. |
| `template` | PSD template | yes | The `.psd` whose placeholder is filled. |
| `mask` | image path | no | Refined matte; multiplied into the image's alpha. |
| `metadata` | object | no | JSON object merged into the exported metadata. |

## Parameters

| Param | Type | Default | Range / values | Notes |
| --- | --- | --- | --- | --- |
| `filename` | basename | `final` | plain basename | Rejected server-side if it contains `..` or a path separator (`studio_reject_unsafe_basename`). |
| `output_dir` | path | run output dir | | The triplet is written here. |
| `placeholder` | text / JSON | `{}` (whole canvas) | `{"name": "<layer>"}` or `{left,top,width,height}` | Layer name or explicit box; a zero-area box falls back to the whole canvas. |
| `fit_mode` | enum | `contain` | `contain` \| `cover` \| `stretch` | How the image fits the placeholder box. |
| `z_order` | enum | `above_background` | `above_background` \| `placeholder` \| `top` | Where the pixel-fallback layer is inserted. |
| `smart_object_mode` | enum | `disable` | `disable` \| `replace_content` | `replace_content` rewrites the smart object (stays editable in Photoshop) when the placeholder is one. |
| `hide_placeholder` | enum | `enable` | `enable` \| `disable` | Hide the original placeholder in the pixel-fallback path. |
| `save_preview` | enum | `enable` | `enable` \| `disable` | Whether `_preview.png` is rendered. |
| `max_decode_pixels` | int | `96_000_000` | `>= 0` (0 disables) | Rejects an **input** image / mask larger than this before decoding (decompression-bomb guard). |

## Placeholder resolution

1. `placeholder.name` → resolve that template layer (errors if not found); its
   bbox is the box, and the layer's kind (`smartobject` / `pixel`) is reported.
2. Else `placeholder.{left,top,width,height}` → an explicit box (missing
   width/height fall back to the canvas).
3. A resolved box with zero area falls back to the full canvas.

`replace_content` only takes the true smart-object path when the resolved
placeholder is actually a smart object; otherwise the image is inserted as a new
pixel layer (`03_GENERATED`) at `z_order`, optionally hiding the placeholder.

## Colour space & bit depth

> Working space / bit depth / ICC handling is defined once in
> [`docs/design/colour-pipeline.md`](../design/colour-pipeline.md) (the source
> of truth). That pipeline has **landed**: this card consumes API-produced and
> preview-ready imagery at the 8-bit sRGB boundary below. This is the *decided
> contract*, not a gap. ProPhoto-tagged 16-bit manual products are
> colour-managed to sRGB at ingress.

The generated-image decoder returns an 8-bit RGBA working surface.
`source_mode` describes that decoded carrier, not a persistent editing mode for
the source file's original encoding:

| Decoded/source form | Handling |
| --- | --- |
| `RGB` / `RGBA` / `L` / `LA` | Promoted to RGBA directly. |
| `P` (palette) | Expanded to RGBA; transparency in `info` is treated as alpha. |
| CMYK/YCCK-encoded JPEG | Accepted through the shared image loader. Composition receives its normal RGBA surface; the source encoding does not add a CMYK/YCCK export mode. |
| `I` / `I;16*` / `F` (high bit) | Data range tone-scaled down to 8-bit before RGB(A) conversion. |

The optional mask is loaded as 8-bit `L` (high-bit mattes tone-scaled, not
clipped), resized to the image, and multiplied into the existing alpha so a
pre-cut subject is never re-opened.

## Boundary behaviour

| Condition | Behaviour |
| --- | --- |
| Missing `template` / `image` / `mask` file | `<which> not found: <path>`. |
| Placeholder layer name not in template | `placeholder layer '<name>' was not found in template`. |
| Zero-area placeholder box | Falls back to the whole canvas. |
| Invalid `placeholder` / `metadata` JSON | `... must be valid JSON` / `... must be a JSON object`. |
| Input image / mask larger than `max_decode_pixels` | `input image too large to decode safely: <path> WxH ...` (before decode). |
| EXIF-rotated image | Orientation normalised; `exif_transposed: true`. |
| Broken EXIF block | Ignored; compose proceeds. |
| Unsafe `filename` (`..`, separators) | Rejected server-side. |

## Output

On success a single JSON object is printed:

`status`, `psd_path`, `preview_path` (empty when disabled), `metadata_path`,
`placeholder_kind`, `smart_object_mode`, and an additive **`export_report`**:

`source_mode`, `mask_source_mode`, `exif_transposed`, `max_decode_pixels`,
`image_size`, `canvas`, `placeholder` (`{left,top,width,height}`),
`placeholder_kind`, `fit_mode`, `fit_offset`, `mask_applied`,
`triplet` (`{psd, preview, metadata}` completeness), `processing_time_ms`.

The same fields (plus `created_at`, `template_path`, `source_image`,
`generated_layer`, `z_order`) are merged into `<filename>_metadata.json`.

## Tests

- `src-tauri/src/psd/compose.rs` / `psd/write.rs` / `psd/smart.rs` — triplet +
  report shape, mask alpha multiply, high-bit / grayscale handling, unsupported-source rejection, the
  input / mask decode guard, metadata merge, the missing-file / invalid-JSON
  errors, and golden round-trip tests of the written PSD (run: `cargo test`).
