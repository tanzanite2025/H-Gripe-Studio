# Colour Pipeline

**Target status:** Decided architecture for the professional RAW developer.

**Current implementation:** Transitional. The landed code still uses the
legacy gamma-encoded u16 `WorkingImage` described under *Current Gaps*.

This document is the colour-space and bit-depth source of truth for the Windows
desktop application. Camera RAW delivery is governed by
`../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md`.

## Product Contract

- H-Gripe Studio has one internal scene working space, not a user-selectable
  collection of working spaces.
- The target scene carrier is unbounded f32 linear RGB using ProPhoto RGB
  primaries and D50. Values may be negative or greater than `1.0`.
- Source colour descriptions are interpreted at ingress. sRGB, Adobe RGB,
  Display P3, standard gamma-1.8 ProPhoto RGB, ICC/CICP profiles, and camera
  matrices/DCP data are not editor modes.
- DCI-P3 is a cinema projection target, not the still-image working space.
  Display P3 may be a display or export target.
- A supported source must remain importable and fully editable regardless of
  whether its file encoding is RGB, grayscale, palette, CMYK/YCCK JPEG, HEIF,
  or camera RAW. Source encoding must not disable canvas, layer, adjustment, or
  export operations.
- The editor exposes no CMYK/YCCK conversion button, document mode, authoring,
  proofing, print setting, or CMYK/YCCK export.
- `.cube`, creative LUT import/export, and LUT adjustments remain absent.
  Internal camera and monitor calibration tables are profile data, not creative
  LUT features.
- Masks and alpha are coverage. They are never colour transformed.

## Surface Model

| Surface | Representation | Colour meaning |
| --- | --- | --- |
| `RawFrame` | Native sensor samples plus CFA and camera metadata | Camera-native scene measurements; not RGB editing pixels |
| `SceneImage` | Unbounded straight-alpha f32 RGBA | Linear ProPhoto primaries, D50; canonical editing surface |
| Mask/alpha | u8/u16/f32 coverage as required by the owning operation | No RGB colour space |
| `DisplayImage` | Bounded pixels appropriate for the viewport surface | Result of scene-to-display rendering plus monitor transform |
| `ExportImage` | Container-specific integer or float pixels | Explicit, embedded output profile |

The CPU reference representation for canonical scene pixels is f32. GPU
representations are implementation choices and must pass error-bounded goldens;
they cannot silently become the precision authority.

## Ingress

### Ordinary Images

The shared loader owns format sniffing, guarded dimensions, EXIF orientation,
metadata extraction, and colour interpretation.

- Tagged RGB input is transformed from its embedded ICC/CICP description into
  `SceneImage`.
- Untagged ordinary RGB uses an explicit sRGB assumption recorded in
  provenance.
- A profile must never be read and then ignored while its samples are relabelled
  as sRGB.
- Decoder-supported CMYK/YCCK source files remain valid imports. Their source
  encoding does not create a CMYK/YCCK editor mode.
- HEIC/HEIF/AVIF ingress must preserve available bit depth and ICC/NCLX/CICP
  information instead of forcing every still through untagged RGBA8.

### Camera RAW

RAW does not contain ready-to-edit RGB pixels. It enters through `RawFrame`,
then the versioned development pipeline applies sensor normalization, white
balance, highlight handling, demosaic, and camera calibration before producing
`SceneImage`. Embedded JPEG previews are presentation placeholders only.

The original RAW remains immutable. Development parameters live in a versioned
`RawDevelopDoc` and every output must be reproducible from the original plus
that document.

## Editing And Grading

- Scene-referred exposure, white balance, highlight reconstruction, and camera
  development operate before any display rendering.
- Layer compositing and colour adjustments use the same canonical scene
  carrier; RAW does not create a second image editor or pixel core.
- `hgripe-grade` must gain a linear-ProPhoto space tag and primaries-aware
  colour math. Fixed Rec.709 luma, white-balance, and vectorscope coefficients
  cannot be applied to linear-ProPhoto samples as if they were Rec.709.
- Display-referred operations must be explicit stages. They cannot be hidden in
  file decode or mutate the canonical scene surface.
- Canonical scene values are not clamped or quantized to u16 between adjustment
  layers. Clamp and encoding happen only at an explicit display/export boundary.

## Display

```text
SceneImage
  -> display render / tone mapping
  -> active Windows monitor profile
  -> viewport surface
```

- The application resolves the active monitor profile on Windows and transforms
  preview pixels for that monitor.
- sRGB is the explicit fallback when no usable monitor profile is available.
- Display P3 capability alone is not sufficient; the active monitor profile and
  the complete presentation path must be honoured.
- A native WGPU surface and the browser fallback must present equivalent colour.
  A non-sRGB swapchain does not by itself make a viewport colour-managed.

## Export

- Standard handoff: tagged sRGB PNG/JPEG/TIFF as supported by the container.
- Wide-gamut display handoff: tagged Display P3 output.
- Master handoff: high-bit standard ProPhoto RGB with its ICC profile embedded,
  or a later explicitly approved scene-linear interchange container.
- Standard gamma-1.8 ProPhoto is an encoded file boundary; it is not the linear
  internal representation.
- Export intents are boundary presets, not alternate working spaces.
- Profile-capable formats must embed the correct profile. Untagged intended-sRGB
  output is not a complete professional handoff.
- Downstream software owns printer-specific CMYK conversion and print settings.
  H-Gripe does not export CMYK or YCCK.

## Colour Engine Ownership

`studio/color` owns transforms between input profiles, the canonical scene
space, display profiles, and export profiles. The grade kernel receives an
explicit space tag and numerical samples; it does not parse ICC or DCP files.

The current `third_party/moxcms` fork retains fixed RGB matrix-shaper transforms
but no arbitrary ICC parser. Professional input compatibility therefore needs
an explicit design choice: a narrowly restored RGB profile reader, a Windows
colour-management boundary, or another bounded solution. Restoring CMYK,
multi-ink, print, generic creative-LUT, or unrelated upstream surfaces is not
authorised by the RAW decision.

Camera DCP matrices and calibration maps are owned by the RAW development
boundary. Their presence is required colour calibration, not an editor LUT
feature.

## Current Implementation Gaps

As of 2026-07-16, the code does not yet satisfy the target contract:

- `WorkingImage` is gamma-encoded u16 and tagged only as sRGB or ProPhoto.
- Only the exact ICC bytes generated by this application restore ProPhoto at
  full precision. External Adobe RGB, Display P3, ProPhoto, and other RGB ICC
  inputs are decoded and then treated as sRGB.
- Camera RAW formats and a `RawFrame`/`RawDevelopDoc` model do not exist.
- HEIC/AVIF decode currently returns untagged 8-bit RGBA and loses wide-gamut
  metadata/high-bit precision.
- The viewport and export-frame paths operate on intended-sRGB RGBA8; monitor
  ICC is not integrated and PNG/JPEG frame export does not embed sRGB ICC.
- The grade kernel contains fixed Rec.709 luma, white-balance, and scope math.
- Four-component JPEG and `Cmyk8` sources are currently rejected in shared
  ingress guards, contrary to the import-compatibility contract.

These are migration facts, not permission to add parallel colour modes or
fallback silently.

## Verification

Colour-pipeline work must eventually cover:

- tagged sRGB, Adobe RGB, Display P3, and ProPhoto input transforms into the
  same canonical scene values;
- untagged-sRGB provenance;
- full-precision RAW stage goldens across Bayer and X-Trans cameras;
- negative values, highlight headroom, and no intermediate clamp;
- CPU/GPU parity for development and grade stages;
- real Windows monitor-profile preview checks;
- tagged sRGB, Display P3, and master ProPhoto files opened in external
  colour-managed applications;
- supported CMYK/YCCK source import without adding an editor/output mode;
- decode budgets and corrupt-input failure isolation.

Current legacy tests remain useful during migration but do not prove the target
architecture merely by passing.

## Related

- `../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md`
- `grade-kernel.md`
- `image-kernel.md`
- `rust-dependency-vendoring.md`
- `../implementation-status.md`
