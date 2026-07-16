# Professional RAW Development Plan

**Status:** Active architecture and delivery plan.

**Decision date:** 2026-07-16.

H-Gripe Studio is a Windows x64, API-first editor whose native image core will
also become a professional, non-destructive camera RAW developer. Generative
and model-backed work remains API-only. RAW development is deterministic native
image processing and must not introduce a model runtime, downloadable weights,
or hidden CPU inference.

This plan is the execution authority for camera RAW ingestion, scene-referred
working pixels, RAW development parameters, colour-managed preview, and RAW
export handoff. It must be read with:

- `../../design/colour-pipeline.md` for the colour-space contract;
- `../../design/grade-kernel.md` for shared f32 adjustment math;
- `../../design/raw-probe-contract.md` for the implemented R0-A probe schema,
  safety budgets, and non-integration boundary;
- `IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md` for tiles, viewport state,
  layer placement, drag, and presentation ownership;
- `../../design/rust-dependency-vendoring.md` for dependency ownership.

## Product Boundary

- Camera RAW is a first-class immutable source, not a one-time conversion into
  an 8-bit proxy.
- The editor exposes one internal scene working space. Users do not choose from
  a collection of working spaces.
- sRGB, Adobe RGB, Display P3, standard ProPhoto RGB, camera-native colour, and
  monitor profiles are ingress, display, or export boundaries. They are not
  parallel editor modes.
- The editor does not provide CMYK/YCCK authoring, document conversion,
  proofing, print settings, or CMYK/YCCK export. This must not reduce source
  image import compatibility.
- `.cube`, creative LUT import, LUT adjustment layers, and LUT export remain
  absent.
- Camera DCP calibration maps and monitor calibration tables are permitted
  internal colour-science data. They are not creative LUT features and must not
  appear as LUT controls.
- WGPU is the vendor-neutral acceleration baseline. CUDA and AMD/Intel-specific
  native kernels may be added later only for measured consumers and with the
  same CPU reference results.

## Canonical Surface Decision

The target colour carrier is an unbounded, scene-linear f32 RGBA surface using
ProPhoto RGB primaries and a D50 white point. The internal linear variant is not
the standard gamma-1.8 ProPhoto file encoding.

```text
SceneImage {
    width,
    height,
    rgba: f32,              // straight alpha
    space: LinearProPhoto,  // fixed; no UI selector
}
```

- RGB values may be negative or greater than `1.0`. Import, development, and
  editing must not clamp scene information.
- The CPU reference carrier is f32. GPU storage may use a more compact format
  only after error-bounded CPU/GPU goldens prove that it preserves the contract.
- Alpha and masks remain coverage data. They are not colour transformed and do
  not need a scene-linear RGB representation.
- Standard gamma-1.8 ProPhoto exists only when writing or reading a tagged file
  boundary. Display P3 is a modern display/export target; DCI-P3 is a cinema
  projection target and is not the still-image working space.

## Data Model

| Type | Purpose | Persistence |
| --- | --- | --- |
| `RawSource` | Immutable original file identity plus make/model and embedded preview references | Project manifest references the original; never overwrites it |
| `RawFrame` | Unpacked sensor samples, CFA layout, crop, black/white levels, as-shot neutral, camera matrices and metadata | Decode cache; not a user-authored image |
| `RawDevelopDoc` | Versioned, revisable development parameters | Project/sidecar data |
| `SceneImage` | Developed unbounded linear ProPhoto f32 pixels | Tile/pyramid cache and downstream native editing |
| `DisplayImage` | Monitor-targeted preview pixels | Ephemeral viewport cache |
| `ExportImage` | Explicitly encoded and profile-tagged output | User-selected file |

`RawDevelopDoc` begins with only parameters that can be replayed
deterministically: orientation/crop, white balance, exposure, highlight
reconstruction mode, demosaic mode, input profile choice, noise controls, and
the display-render preset. Defaults and migrations are versioned; changing a
parameter invalidates only affected cache stages.

## RAW Pipeline

```text
RAW container
  -> probe metadata and embedded preview
  -> unpack sensor samples
  -> active-area crop + black/white normalization
  -> bad-pixel/line correction and linearization
  -> white balance and highlight reconstruction
  -> Bayer/X-Trans demosaic
  -> camera matrix/DCP colour calibration
  -> unbounded LinearProPhoto SceneImage
  -> scene-referred adjustments and layer compositing
  -> display transform + monitor profile for preview
  -> tagged RGB export
```

The exact ordering of denoise, highlight reconstruction, chromatic-aberration
correction, and demosaic variants is versioned by the development engine. It
must be fixed by real-camera goldens before those controls become user-visible.

## Decoder Ownership

The implementation policy is Rust-first:

1. Implement product-specific contracts and feasible processing stages in
   owned Rust.
2. Reuse already-maintained Rust primitives when their retained surface is
   sufficient.
3. For proprietary container/compression coverage that is not practical to
   recreate, prefer a Rust codebase that can be copied, audited, hardened, and
   physically reduced to the required parsers.
4. Consider a C/C++ decoder only when the evidence gate proves that Rust options
   cannot meet required camera coverage or correctness.

H-Gripe will not hand-write every undocumented vendor compression format merely
to avoid a dependency. It will own every stage where product quality and colour
science are the differentiator, and it will keep any unavoidable container
decoder behind a narrow boundary.

- The decoder boundary is unpacked sensor samples plus metadata, not an 8-bit
  RGB convenience image.
- H-Gripe-owned Rust/WGPU stages own development from `RawFrame` to
  `SceneImage`.
- Embedded JPEG previews are for immediate thumbnails only and can never become
  the editable full-resolution source.
- No candidate is added to the workspace, offline vendor tree, installer, or CI
  until the R0 evidence gate below passes.
- A selected dependency is never consumed as a live upstream crate, Git
  submodule, runtime download, or subprocess. Its reviewed source snapshot is
  copied under `third_party`, disconnected from automatic upstream updates,
  physically pruned, documented in `VENDOR.md`, and exposed through an
  H-Gripe-owned Rust adapter.
- Upstream upgrades are deliberate source ports that reapply local removals and
  tests. They are not version bumps.

Current candidates:

| Candidate | Strength | Blocking concern |
| --- | --- | --- |
| Owned Rust DNG/TIFF path | No new runtime dependency; establishes the H-Gripe contracts and reference safety behavior | Does not provide broad proprietary camera/compression coverage |
| `rawler` / DNGLab | Rust-native and broad published format list | Upstream describes it as alpha, API-unstable, Windows-untested, and unsuitable for hostile files |
| LibRaw | Mature camera/container coverage and metadata extraction | Last-resort native C++ payload; built-in post-processing is not the professional renderer and must stay outside the product contract |
| Windows Imaging Component | No bundled decoder when a codec exists | Machine-dependent coverage and results cannot define a reliable product contract |

## ICC And Calibration Boundary

- Tagged RGB input must be transformed from its embedded ICC/CICP description
  into `LinearProPhoto`; it must never be relabelled as sRGB.
- Untagged ordinary RGB input uses an explicit sRGB assumption recorded in
  provenance.
- RAW camera colour uses camera matrices and, where required for professional
  accuracy, DCP calibration data. Matrix-only support is a valid first stage but
  cannot be described as complete camera colour for every body/illuminant.
- Monitor ICC belongs at the Windows display boundary. A display transform must
  not mutate scene pixels.
- Source/calibration tables are internal profile data. The product still has no
  creative LUT file or LUT adjustment surface.

## Display And Export

- Viewports are colour-managed from `LinearProPhoto` through a display render
  and the active Windows monitor profile. An sRGB fallback is required when the
  profile cannot be resolved.
- Standard export produces tagged sRGB files for maximum compatibility.
- Wide-gamut display export produces tagged Display P3 files.
- Master handoff converts the linear scene surface into a standard tagged
  high-bit ProPhoto RGB TIFF/PNG representation, or a later explicitly chosen
  scene-linear interchange format.
- Export presets are boundary intents, not alternate working spaces.
- No export path writes CMYK or YCCK. Downstream software owns any print-space
  conversion.

## Performance And Safety

- Full-resolution RAW development must become tile/pyramid based; a 50-100 MP
  source must not require every intermediate stage to allocate a full f32 image.
- The embedded preview appears first, followed by progressively refined native
  renders. Preview replacement must be atomic and must not change layer or
  selection geometry.
- Decode and render work is cancellable and keyed by source hash, engine
  version, camera data version, and `RawDevelopDoc` hash.
- Decode budgets apply to sensor dimensions, output dimensions, metadata sizes,
  and intermediate allocation estimates.
- Native decoder failures must be contained and reported; a corrupt RAW must
  not silently fall back to its embedded JPEG as the editable image.

## Delivery Phases

### R0 - Rust Contract And Dependency Gate

R0 is deliberately split so the first step neither downloads nor adopts a RAW
library.

#### R0-A - Owned Rust Probe Contract (first step)

Define a candidate-neutral Rust/JSON probe contract for:

- container/make/model and source identity;
- sensor dimensions, active area, orientation, bit depth, and compression;
- Bayer/X-Trans layout;
- black/white levels, masked areas, and as-shot neutral;
- camera colour matrices/profile references;
- embedded preview/thumbnail offsets and dimensions;
- diagnostics, elapsed time, and estimated allocations.

Build a bounds-checked DNG/TIFF metadata probe using already-maintained Rust
primitives or a small owned parser. Use an H-Gripe-generated minimal DNG fixture
whose tags and sensor samples are fully known. R0-A does not demosaic, create an
RGB image, register RAW extensions, touch the product loader, or add a
dependency. Its output fixes the neutral contract that every later candidate
must satisfy.

**Implemented 2026-07-16.** The standalone `hgripe-raw` crate now owns schema
version 1 and a bounds-checked classic-TIFF/DNG probe. It supports both byte
orders, traverses bounded IFD/SubIFD graphs, validates metadata and payload
references without reading sample values, and uses a generated 6x6 RGGB DNG
fixture. Its offline suite has 31 valid/malformed-input and JSON contract tests.
The desktop crate does not depend on it, and no RAW extension or decoder
dependency was added. `../../design/raw-probe-contract.md` is the detailed
authority for this landed boundary.

#### R0-B - Windows Candidate Evidence

**Current next phase.** Begin with a Windows-local, license-safe corpus manifest
and an evidence-record format that consumes the R0-A schema. Corpus preparation
does not authorise adding a candidate to the product workspace, loader,
installer, or extension registry.

**R0-B1 implemented 2026-07-16.** The standalone `hgripe-raw-evidence` crate
now validates versioned local manifests, rights metadata, relative paths,
SHA-256, and required-family coverage. Its owned DNG runner isolates each case
in a bounded Windows Job Object and records timings, Windows peak working set,
executable/source identity, R0-A output, expectations, and structured failures.
Manifest/file reads are snapshot-bound, parent-side record validation prevents
child evidence substitution, and evidence publication is atomic/no-replace. It
explicitly records sensor unpack as not attempted, so its `gate_ready` result
is false.
See `../../design/raw-r0-windows-evidence.md`.

**R0-B2a implemented 2026-07-16.** Manifest/evidence schema 2 now fixes a
candidate-neutral sensor reference: the complete sensor raster from the only
full-resolution RAW frame, before crop, orientation, normalization,
corrections, or demosaic;
row-major, one-sample CFA values encoded as little-endian `u16`; SHA-256 over
only those canonical bytes. The reference records producer implementation
lineage, wrapper/artifact, and immutable record artifact identity. The child
does not receive this reference; the parent computes count/digest from a
retained output-file handle, and the gate rejects matching candidate lineage.
This blocks direct protocol self-certification but does not automatically prove
independence. It defines comparison only and adds no sensor decoder.

R0-B2b is the current next code step: add read-only corpus preflight and
explicit-path fingerprinting. Actual R0-B2 completion still requires the
licensed local real-camera corpus, independent canonical sensor references,
and a clean release owned baseline. No real camera corpus or external candidate
source is present in the repository yet.

Build disposable Windows x64 runners outside product runtime registration. They
probe the owned Rust path and external candidates against a representative
local corpus before any dependency is vendored.

Required corpus families:

- DNG: uncompressed and lossless compressed Bayer;
- Canon CR2 and CR3/C-RAW;
- Nikon NEF;
- Sony ARW;
- Fujifilm RAF with X-Trans;
- Olympus ORF and Panasonic RW2.

Every runner must report the R0-A contract without producing a final RGB render,
plus:

- decode time, peak memory, binary/runtime payload size, license, and failure.

#### R0-C - Ownership Decision

Prefer the owned Rust path wherever it meets the contract. If proprietary
coverage requires external code, select the smallest candidate that exposes raw
samples and metadata with acceptable Windows x64 failure isolation. Before it
enters the main workspace:

- record the exact source release/commit, license, camera coverage, and failed
  alternatives;
- copy source into `third_party` and add `VENDOR.md`;
- remove CLI applications, final RGB post-processing, unsupported targets,
  unused encoders/exporters, network/download hooks, and unrelated formats;
- expose only the H-Gripe-owned Rust adapter and lock its feature surface;
- add offline builds, malformed-input tests, and upstream-port instructions.

R0 passes only after this written decision record. It does not add file
extensions to the product UI and does not claim RAW import support.

### R1 - Stable RawSource And RawFrame Contract

Add format sniffing, guarded probing, immutable resource registration, the
versioned Rust data contracts, and synthetic DNG contract tests. No demosaic and
no editable RAW surface yet.

### R2 - CPU Reference Development

Implement one deterministic Bayer path from normalized sensor samples through
white balance, reference demosaic, camera matrix conversion, and an unbounded
`SceneImage`. Validate against numerical fixtures before adding controls.

### R3 - Non-Destructive Document And Cache

Persist `RawDevelopDoc`, cache stage outputs, use embedded previews only for
fast presentation, and re-render affected stages on parameter changes.

### R4 - Colour-Managed Display And Export

Add monitor-aware preview plus tagged sRGB, Display P3, and master ProPhoto
handoff. Until this phase passes real-monitor and cross-application tests, the
RAW path is not professional-colour complete.

### R5 - WGPU Tiles And Camera Coverage

Move proven stages behind shared WGPU kernels, add tiled/pyramid scheduling,
broaden Bayer/X-Trans/camera coverage, and retain the CPU reference for goldens
and fallback.

### R6 - Image Editor Integration

Open a RAW source as the same `ImageEditorDocument` used by ordinary images,
with a revisable `RawDevelopDoc` before the layer/edit stack. No second RAW
editor shell or duplicate pixel core is allowed.

## Completion Criteria

Professional RAW support is not complete until:

- the required camera families load full sensor data, not embedded previews;
- scene data survives development without early clamp or 8-bit quantization;
- CPU and GPU stages pass shared numerical/visual goldens;
- monitor-aware preview and tagged exports agree in external colour-managed
  applications;
- edits remain non-destructive and replayable after project reopen;
- unsupported cameras fail explicitly with preserved originals and diagnostics;
- RAW work adds no local inference, CMYK/YCCK authoring, or creative LUT UI.
