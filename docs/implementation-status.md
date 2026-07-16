# Implementation Status

Updated 2026-07-16.

## Product Boundary

H-Gripe Studio is API-first and Windows-only.

- Generative and model-backed work runs through configured API profiles.
- Deterministic image, mask, grading, PSD, and media operations run locally in
  native Rust.
- Downloaded in-process inference is retired from the current product scope. The desktop
  bundle contains no inference runtime, model weights, model download hooks, or
  executable local-model defaults.
- The former model-path commands are removed. Old files on disk are ignored,
  and retired engine requests fail explicitly.
- Windows NVIDIA/CUDA and AMD/Intel GPU compatibility remain future device and
  media/kernel work. They are not a reason to ship an unused inference runtime.
- Professional, non-destructive camera RAW development is a decided native
  product direction. It does not change the API-only model boundary.

## Professional RAW Target

The target architecture is defined by
`plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md` and
`design/colour-pipeline.md`:

- immutable camera RAW sources plus versioned, revisable development settings;
- one unbounded f32 linear-ProPhoto scene working surface with no working-space
  selector;
- owned Rust/WGPU normalization, demosaic, camera colour, adjustment, display,
  and export stages;
- colour-managed Windows preview and tagged RGB handoff files;
- no local inference, CMYK/YCCK authoring/printing, or creative LUT feature.

The product target has not landed. Its R0-A metadata foundation has landed as a
standalone, unintegrated crate:

- `hgripe-raw` defines probe schema version 1 and structured errors;
- its owned classic-TIFF/DNG parser supports both byte orders, bounded
  IFD/SubIFD traversal, checked ranges, exact rational metadata, CFA/level/crop
  validation, and raw/preview references without decoding payloads;
- a generated 6x6 RGGB DNG fixture and 31 valid/malformed-input tests pass
  offline; CI runs the crate explicitly;
- the desktop crate has no dependency on `hgripe-raw`, so this is not product
  RAW import support.

R0-B1 evidence infrastructure has also landed without product integration:

- `hgripe-raw-evidence` validates local rights-aware corpus manifests, hashes,
  safe relative paths, expected facts, and all required camera-family slots;
- every owned-probe case runs in a separate Windows process and records the
  runner binary identity, bounded process evidence, timings, peak working set,
  R0-A report, and failure;
- manifest hashing/parsing and camera-file hashing/probing use single bound
  snapshots/handles; Windows paths, child records, and evidence publication are
  checked against alias, escape, tampering, timeout, and overwrite races;
- the schema distinguishes metadata success from sensor unpack. The owned
  runner reports unpack as not attempted and cannot mark the R0-B gate ready;
- R0-B2a upgrades manifest/evidence to schema 2 and defines one canonical
  full-sensor `u16` little-endian sample stream plus structured producer and
  candidate decoder lineage/artifact identity. The parent omits the expected
  sensor reference from the child snapshot and computes count/digest from a
  retained output-file handle; direct protocol self-certification cannot
  satisfy the gate, while actual independence still requires manual audit;
- generated DNG, blind-protocol, Windows containment, integrity, and CLI tests
  pass, but no real camera corpus or external candidate decoder is present.

Remaining implementation gaps include:

- no DNG/CR2/CR3/NEF/ARW/RAF/ORF/RW2 registration or decoder;
- no `RawSource`, `RawFrame`, or `RawDevelopDoc` contract;
- gamma-encoded u16 `WorkingImage` rather than unbounded f32 scene pixels;
- incomplete external RGB ICC handling and no monitor-profile presentation;
- HEIC/AVIF narrowed to untagged RGBA8;
- fixed Rec.709 assumptions inside parts of the grade kernel.

The next approved code work is R0-B2b on Windows x64: add read-only corpus
preflight and explicit-path fingerprinting against the schema in
`design/raw-r0-windows-evidence.md`. Real completion still requires a
rights-cleared local camera corpus, independently produced canonical sensor
references, and a clean release owned baseline. This does not authorise a RAW
dependency, maintained vendor tree, product extension, or claimed import
support. Candidate comparison follows the corpus baseline, and source adoption
occurs only after the R0-C ownership record.

## API Runtime

The hgripe-api broker owns provider profiles, credentials, retries, caching,
cancellation, task state, and history. Built-in adapters include
OpenAI-compatible HTTP, custom HTTP, Replicate, and mock providers.

Studio API-lane cards include generation, provider-backed detail repaint, and
prompt optimization. This execution chain is independent of native image
kernels.

## Native Image Cards

| Card | Current implementation |
| --- | --- |
| Match Light & Color | Rust Lab transfer, histogram match, tone protection, and brand-colour guard. CPU engine only. |
| Subject Mask | Deterministic border-colour segmentation, connected components, point constraints, and full manual mask editor. |
| Alpha Matting | Weight-free trimap plus image-guided filter. |
| Refine Mask Edge | Rust morphology, guided filtering, feathering, decontamination, and background blend. CPU engine only. |
| Image Enhance | Rust denoise, linear-light resize, unsharp detail, and independent alpha resize. CPU engine only. |
| Detail Watchdog | Rust blur/resolution/halo/colour rules. Semantic targets remain explicitly skipped. |
| PSD Export | Native PSD composition and artifact reporting. |

All current cards use the hardened image boundary for decode limits, EXIF
orientation, RGB colour management, and supported digital-media formats.

## Colour And File Interoperability

The product does not expose CMYK/YCCK conversion controls, document modes,
authoring, export, proofing, or print settings. This does not narrow input
compatibility: supported source images must still import and remain fully
editable. Standard RGB/RGBA exports are the handoff to downstream applications,
which own any printer-profile conversion and printing.

The current cleanup worktree has two known deviations from that contract:

- shared image ingress still rejects four-component JPEG sources in two guard
  paths instead of allowing normal import;
- editor-frame PNG/JPEG export writes intended sRGB pixels without embedding an
  sRGB ICC profile.

Cleanup is not complete until input compatibility is restored and
profile-capable editor exports provide an unambiguous RGB colour-space handoff.
Neither correction requires a CMYK/YCCK editor or export subsystem.

## Media And GPU

- Native FFmpeg decode/encode remains integrated from the maintained Windows
  shared-library payload.
- WGPU grading and viewport presentation remain available behind their existing
  feature gates and deterministic CPU fallbacks.
- The shared device report remains for WGPU and FFmpeg diagnostics.
- No local-model provider probing or model-session scheduling remains.

## Dependency Ownership

- third_party/ffmpeg is the maintained native media payload.
- third_party/moxcms is the maintained RGB colour-management fork.
- third_party/cargo-vendor is the offline Cargo snapshot for packages still in
  Cargo.lock.
- The former inference runtime, Rust bindings, model resources, fetch scripts,
  and weight-gated CI lanes have been removed.

## Verification

Normal verification covers:

- cargo check and cargo test with default features
- cargo check and cargo test without default features
- frontend tests, type checking, and production build
- repository audits that reject deleted inference runtime/model integration
