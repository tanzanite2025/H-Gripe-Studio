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

A broad RAW container decoder is necessary; hand-writing CR3, NEF, ARW, RAF,
and every vendor compression format is not a useful product investment.
However, the selected dependency must not own final colour rendering.

- The decoder boundary is unpacked sensor samples plus metadata, not an 8-bit
  RGB convenience image.
- H-Gripe-owned Rust/WGPU stages own development from `RawFrame` to
  `SceneImage`.
- Embedded JPEG previews are for immediate thumbnails only and can never become
  the editable full-resolution source.
- No candidate is added to the workspace, offline vendor tree, installer, or CI
  until the R0 evidence gate below passes.

Current candidates:

| Candidate | Strength | Blocking concern |
| --- | --- | --- |
| LibRaw | Mature camera/container coverage and metadata extraction | Native C++ payload; built-in post-processing is not the professional renderer and must stay outside the product contract |
| `rawler` / DNGLab | Rust-native and broad published format list | Upstream describes it as alpha, API-unstable, Windows-untested, and unsuitable for hostile files |
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

### R0 - Evidence And Dependency Gate (first step)

Build a disposable Windows x64 comparison harness outside product runtime
registration. It probes candidates against a representative local corpus and
records facts before any dependency is vendored.

Required corpus families:

- DNG: uncompressed and lossless compressed Bayer;
- Canon CR2 and CR3/C-RAW;
- Nikon NEF;
- Sony ARW;
- Fujifilm RAF with X-Trans;
- Olympus ORF and Panasonic RW2.

The harness must report, without producing a final RGB render:

- make/model, dimensions, active area, orientation, bit depth and compression;
- CFA/X-Trans layout;
- black/white levels and masked areas;
- as-shot neutral/white balance;
- colour matrices and available DCP/embedded profile metadata;
- embedded preview and thumbnail locations;
- decode time, peak memory, binary/runtime payload size, license, and failure.

R0 passes only when one candidate provides the raw samples and metadata needed
by the owned pipeline on Windows x64 with acceptable failure isolation. Its
output is a written decision record. R0 does not add file extensions to the
product UI and does not claim RAW import support.

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
