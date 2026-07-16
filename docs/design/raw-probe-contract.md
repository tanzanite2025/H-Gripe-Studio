# RAW Metadata Probe Contract

**Status:** R0-A implemented on 2026-07-16.

This document fixes the candidate-neutral boundary used to compare camera RAW
container implementations. The implementation is the standalone
`crates/hgripe-raw` workspace crate. It is not linked by the desktop crate and
does not register a file extension or make RAW files importable in the product.

Read this with:

- `../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md` for the complete RAW
  delivery sequence;
- `rust-dependency-vendoring.md` for external-source ownership rules;
- `colour-pipeline.md` for the later scene-pixel and display/export contract.

## R0-A Boundary

The public entry point is:

```rust
pub fn probe_dng(bytes: &[u8]) -> Result<RawProbeReport, RawProbeError>;
```

The probe may inspect classic-TIFF/DNG metadata and validate referenced byte
ranges. It must not:

- decode, decompress, copy, normalize, or demosaic sensor samples;
- decode an embedded thumbnail or preview;
- produce RGB pixels or a `SceneImage`;
- parse MakerNote data, EXIF graphs, or DCP HueSat/Look/Tone tables;
- register `.dng` or any camera extension with the desktop loader;
- add a decoder dependency, model runtime, network hook, or downloadable data.

Tests rewrite the complete synthetic sensor payload and require an identical
report after normalizing elapsed time. This is direct evidence that the probe
does not use sensor sample values.

## Container Support

R0-A supports little- and big-endian classic TIFF with magic `42`. BigTIFF
magic `43` is a structured unsupported error. The parser follows IFD0,
next-IFD, and SubIFD links with cycle and depth detection.

A DNG must contain one `DNGVersion` and exactly one candidate raw IFD. A raw IFD
is identified by CFA photometric interpretation `32803` or LinearRaw `34892`.
Multiple raw IFDs are deliberately reported as ambiguous in R0-A; the probe
does not guess by choosing the largest image.

`RawContainer` already names DNG, CR2, CR3, NEF, ARW, RAF, ORF, and RW2 so R0-B
runners can emit the same contract. Only the DNG parser is implemented in
R0-A. DNG versions live in an optional `dng` child object, and container byte
order is optional, so proprietary-format runners never have to fabricate
TIFF-only facts. Compression is a generic `{ code, description }` object whose
code is interpreted in the named container's namespace.

The implementation reads the TIFF storage topology, DNG identity, dimensions,
crop and masked areas, CFA definition, black/white levels, as-shot white
balance, camera matrices, calibration/profile identity, and strip/tile or JPEG
preview references. Large linearization and black-level-delta tables are
reported only as validated metadata references.

For a DNG whose IFD0 is a reduced-resolution preview and whose raw image is a
SubIFD, DNG identity, camera identity, orientation, as-shot white balance,
camera/profile matrices, illuminants, and embedded unique ID come from shared
IFD0 metadata. Sensor dimensions, CFA, crop, masked areas, levels, and raw
storage come from the raw IFD. The generated fixture locks this placement so a
preview IFD cannot cause real camera-profile metadata to be silently dropped.

Raw and preview payload ranges must be non-empty, remain inside the source, and
must not overlap the TIFF header, IFD tables, or external metadata values. Raw
strip/tile counts are cross-checked against image dimensions,
`RowsPerStrip`/tile dimensions, samples per pixel, and planar configuration.

## Stable Report

`RawProbeReport.schema_version` is `1`. The JSON contract contains:

- container, optional byte order, source byte length, and optional embedded
  unique ID;
- make, model, unique camera model, and optional DNG/backward versions;
- sensor dimensions, active/masked areas, default crop, and orientation;
- bit depths, structured compression identity, samples per pixel, and generic
  CFA pattern;
- exact rational black/white levels, as-shot neutral/white XY, and analog
  balance;
- typed camera, calibration, reduction, and forward matrices plus illuminant;
- profile identity fields and deferred large-metadata references;
- validated raw and preview data references;
- elapsed microseconds, materialized metadata bytes, estimated unpacked bytes,
  and stable diagnostics.

Rational values serialize as exact `{ "num", "den" }` objects. File sizes,
offsets, byte counts, elapsed time, and allocation estimates serialize as
decimal strings so JavaScript consumers cannot lose `u64` precision. Optional
fields remain explicit `null` values; a schema change requires incrementing
`RAW_PROBE_SCHEMA_VERSION` and updating the JSON contract test.

`RawProbeError` is also serializable and uses a stable snake-case `code` field.
Its `u64` sizes and offsets use the same decimal-string encoding as the report.
Malformed inputs return structured errors and never fall back to an embedded
preview as the editable source.

## Safety Budgets

| Resource | R0-A limit |
| --- | ---: |
| IFD nesting depth | 4 |
| Total IFDs | 32 |
| Entries per IFD | 512 |
| Total IFD entries | 4,096 |
| SubIFDs from one entry | 16 |
| One materialized metadata field | 64 KiB |
| Total materialized metadata | 256 KiB |
| One ASCII field | 4 KiB |
| CFA pattern values | 256 |
| Masked rectangles | 64 |
| Strip/tile ranges | 4,096 |
| Declared sensor pixels | 1,000,000,000 |
| Estimated unpacked samples | 16 GiB |

Every offset, count, type width, IFD size, payload extent, sensor size, and
allocation estimate uses checked arithmetic before conversion to `usize`.
Recognized tags reject zero counts, unsupported types, duplicate definitions,
out-of-range coordinates, mismatched matrix/CFA/level counts, and zero rational
denominators. No allocation is sized directly from an untrusted sensor
dimension or payload byte count.

## Verification

The test fixture is generated in Rust and contains the same known metadata and
samples in little- and big-endian forms: a 2x2 RGB thumbnail plus a 6x6,
16-bit, uncompressed RGGB raw SubIFD. No binary camera file is committed.

The R0-A suite covers both valid byte orders, every proper truncation prefix,
BigTIFF/non-DNG rejection, IFD and SubIFD cycles, duplicate tags, entry and
field budgets, invalid types/counts, out-of-bounds and metadata-overlapping
payloads, CFA/crop/level/storage contradictions, invalid ASCII, zero rational
denominators, stable report/error JSON, and payload-independence. CI runs:

```text
cargo test -p hgripe-raw
```

## R0-B Handoff

R0-B must consume this exact report rather than define a candidate-specific
shape. Its first deliverable is a Windows-local, license-safe corpus manifest
and evidence record for the required DNG, CR2/CR3, NEF, ARW, RAF, ORF, and RW2
families. The owned DNG probe is the baseline runner. The implemented manifest,
canonical unpacked-sensor reference, process-isolation, metrics, and gate
contract are defined in
`raw-r0-windows-evidence.md`.

No external decoder enters the workspace, offline Cargo snapshot, installer,
extension registry, or product loader during corpus preparation. Candidate
source adoption remains an R0-C decision and must follow the local ownership,
physical pruning, and `VENDOR.md` rules.
