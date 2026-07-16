# Rust Dependency And Native Runtime Ownership

The desktop product targets Windows x64 and supports offline Cargo builds from
the repository-maintained dependency snapshot.

## Owned Trees

| Tree | Purpose |
| --- | --- |
| third_party/cargo-vendor | Registry package snapshot for dependencies present in Cargo.lock |
| third_party/ffmpeg | Native shared FFmpeg libraries, import libraries, headers, notices, and version lock |
| third_party/moxcms | Locally maintained RGB colour-management fork |

Cargo.lock is the authority for which registry packages remain required. When a
direct dependency is removed, regenerate the lock file first, then delete only
vendored package versions that no longer appear in the resolved graph.

## FFmpeg

Native FFmpeg is a product feature, not a development-only tool. The default
desktop feature links the Windows shared libraries and build.rs copies their
runtime DLLs beside application and test binaries. Git LFS materialises the
binary payload; normal builds do not download it.

The media integration owns still/video probe, decode, scrub, poster, trim, and
assemble behavior. Hardware decode/encode capabilities are reported separately
from the software baseline and require real runtime evidence.

## Colour Management

The moxcms fork is limited to the RGB and grayscale transforms used by the
digital-media working surface. Unsupported print-oriented and lookup-table
features are excluded from the maintained fork and dependency feature set.

The decided professional-RAW target uses one unbounded f32 linear-ProPhoto
scene surface. The current fork's fixed sRGB/ProPhoto matrix-shaper support is a
useful implementation baseline, but it is not evidence of complete input ICC,
camera DCP, monitor-profile, or scene-linear support. Any expansion must be
limited to the RGB/profile functionality required by the colour-pipeline
contract; the RAW decision does not authorise restoring CMYK, multi-ink,
printing, `.cube`, or creative-LUT product surfaces.

Source-file decoding is separate from CMYK/YCCK authoring. Dependency pruning
must preserve the ability to import and normally edit every source encoding
supported by the selected general image decoder. Conversely, hypothetical
CMYK/YCCK document conversion, export, proofing, or print workflows do not
justify a new dependency, maintained fork surface, UI control, or dedicated
encoder. Any retained colour code must be justified by current RGB working
surfaces, source compatibility, or interoperable RGB export.

## Camera RAW Dependency Gate

Camera RAW requires broad vendor-container parsing, but no candidate decoder is
approved yet. The selection order is owned Rust, an auditable/prunable Rust
codebase, and only then a native C/C++ decoder when coverage evidence requires
it. Follow R0 in
`../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md` before changing Cargo,
the offline snapshot, native payloads, CI, packaging, file-extension lists, or
resource registration.

R0-A is implemented by the standalone `hgripe-raw` crate and
`raw-probe-contract.md`: a neutral schema plus a bounds-checked Rust DNG
reference with no decoder dependency or product-loader integration. R0-B then
proves on Windows x64 how much of DNG, CR2/CR3, NEF, ARW, RAF, ORF, and RW2
each candidate can expose. R0-C
records the ownership decision, license, update model, binary size, memory,
failure isolation, and camera coverage.

The owned `hgripe-raw-evidence` R0-B1 harness adds no decoder. It uses the
existing offline `sha2`, `serde_json`, and `windows-sys` packages for file and
runner identity, evidence JSON, handle-bound Windows path checks, Job Object
limits, peak-memory reporting, atomic no-replace evidence publication, and
manifest enforcement. It is not linked by the desktop crate. Real corpus files
and generated evidence remain local and ignored by Git.

R0-B2a adds no decoder or package. It uses the existing `sha2` dependency to
define SHA-256 over an already-unpacked canonical little-endian `u16` sensor
stream. The helper cannot open or decode a camera file. The evidence schema
records producer and candidate decoder lineage/artifacts, and the blind child
protocol avoids directly supplying the expected digest; actual independence
still requires the R0-B2/R0-C source and rights audit.

R0-B2b also adds no package or decoder. Its preflight and fingerprint commands
reuse `sha2`, `serde_json`, and `windows-sys` already present in the maintained
offline snapshot. They open only explicit corpus-root-relative files, verify
final Windows handles, and hash bounded bytes; they do not inspect payloads to
infer formats, rights, privacy, or sensor facts.

Dependency ownership after selection is deliberately narrow:

- the external decoder may unpack proprietary containers and report metadata;
- embedded previews may accelerate thumbnails only;
- H-Gripe-owned Rust/WGPU code owns sensor normalization, demosaic, camera
  colour, scene pixels, adjustments, display rendering, and export;
- an external decoder's convenience 8-bit RGB post-process cannot define the
  editable image or professional colour result;
- no decoder tree is vendored before the evidence record names the retained
  source surface and the upstream features/files that remain necessary.

If external code is selected, "vendored" means locally owned rather than merely
cached:

- copy a reviewed source snapshot into `third_party`; do not use a Git submodule
  or live crates.io/Git resolution;
- record upstream URL, exact revision/release, license, local changes, and
  upgrade procedure in `VENDOR.md`;
- physically remove unused CLI tools, final RGB post-processing, encoders,
  unsupported targets, downloads, and unrelated features;
- expose it only through an H-Gripe-owned Rust adapter with a stable contract;
- keep builds and tests offline and package only runtime artifacts the retained
  path actually loads;
- treat every upstream update as a manual port and reapply all removals,
  hardening, and evidence tests.

## API-First Boundary

The repository does not ship an inference runtime or model weights.
Generative and model-backed tasks use API profiles through hgripe-api.
Deterministic local cards must not add an inference dependency, model download
hook, bundled weight, or hidden CPU inference fallback.

Future Windows CUDA or AMD/Intel GPU work must be justified by an actual
shipping kernel/media consumer and must land packaging, capability reporting,
fallback, and real-hardware tests together.

## Update Checklist

1. Change the direct dependency or maintained native payload.
2. Regenerate Cargo.lock without network hooks in builds.
3. Remove only unreferenced vendored package versions.
4. Run cargo check and cargo test with default and no-default feature sets.
5. Verify CI and packaging copy only runtime DLLs that current features use.
6. Update the relevant VENDOR or design document in the same change.
7. For a new native/RAW dependency, attach the completed evidence gate and the
   exact retained ownership boundary before vendoring or packaging it.
