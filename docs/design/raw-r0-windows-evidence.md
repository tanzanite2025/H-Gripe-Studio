# RAW R0 Windows Evidence

**Status:** R0-B1 evidence contract and owned runner implemented on 2026-07-16.

This document defines the Windows x64 evidence harness used after the R0-A
metadata contract and before any external RAW decoder is adopted. The
implementation is the standalone crates/hgripe-raw-evidence workspace crate.
The desktop crate does not depend on it.

Read this with:

- raw-probe-contract.md for the candidate-neutral metadata report;
- ../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md for R0-A/R0-B/R0-C;
- rust-dependency-vendoring.md for the later source-ownership gate.

## Boundary

R0-B1 adds no RAW decoder, camera extension, product loader, sensor unpacker,
demosaic path, RGB renderer, model runtime, network hook, or runtime download.
It uses only the owned hgripe-raw probe and repository-maintained Rust packages
already present in the offline Cargo snapshot.

The evidence tool:

- validates a local corpus manifest before opening camera files;
- reads the bounded manifest once, then hashes and deserializes that exact byte
  snapshot;
- opens each camera file once, verifies the final Windows handle remains under
  the corpus root, and hashes the bytes read from that same handle;
- runs every case in a separate Windows Job Object with kill-on-close, a
  120-second deadline, one active process, a 4 GiB process/job memory limit,
  and 4 MiB bounds on each captured output stream. The child blocks on a parent
  handshake until Job assignment succeeds;
- records runner revision, dirty state, executable hash/size, Windows peak
  working set from both child and parent observation, timings, expectations,
  structured probe output, and failure;
- verifies each returned record against the parent manifest and recomputes
  expectation checks from the returned R0-A report;
- pins the exact manifest snapshot SHA-256 across the parent and every child
  process;
- never embeds an absolute corpus path in the evidence bundle;
- publishes evidence with an atomic Windows no-replace move, so concurrent runs
  cannot overwrite an existing evidence file.

Corpus files and generated evidence are local data, not product assets. The
repository ignores /raw-corpus/ and /raw-evidence/ to reduce accidental commits
of licensed camera files or personal metadata.

## Corpus Manifest

RawCorpusManifest.schema_version is 1. A case requires:

- a unique stable ASCII ID;
- one required camera family and a human-readable variant;
- a forward-slash relative path with no root, drive, dot, or parent component;
- an exact lowercase SHA-256;
- source origin, rights reference, redistribution policy, and personal-metadata
  flag;
- optional expected make/model, dimensions, TIFF compression code/description,
  CFA repeat dimensions, and a trusted sensor sample count/digest/reference
  set. CR3 and CR3 C-RAW require the normalized descriptions `canon_cr3_raw`
  and `canon_cr3_c_raw`, respectively.

The required coverage set is:

| Family | Required distinction |
| --- | --- |
| DNG | Uncompressed Bayer |
| DNG | Lossless-compressed Bayer |
| Canon | CR2 |
| Canon | CR3 |
| Canon | CR3 C-RAW |
| Nikon | NEF |
| Sony | ARW |
| Fujifilm | RAF X-Trans |
| Olympus | ORF |
| Panasonic | RW2 |

An incremental manifest may omit families and remains valid, but validation
returns one warning per missing family and coverage.complete = false. R0-B
cannot pass until coverage is complete.

Illustrative case shape:

~~~json
{
  "schema_version": 1,
  "corpus_id": "r0-local-2026-07",
  "cases": [
    {
      "id": "dng-uncompressed-owned-001",
      "family": "dng_uncompressed_bayer",
      "variant": "owned capture, full-resolution uncompressed Bayer DNG",
      "relative_path": "dng/uncompressed-owned-001.dng",
      "sha256": "replace-with-64-lowercase-hex-characters",
      "provenance": {
        "origin": "owned_capture",
        "rights_reference": "local capture owned by the evaluator",
        "source_uri": null,
        "redistribution": "prohibited",
        "contains_personal_metadata": true
      },
      "expected": {
        "make": null,
        "model": null,
        "dimensions": null,
        "compression_code": 1,
        "compression_description": "uncompressed",
        "cfa_repeat_rows": 2,
        "cfa_repeat_columns": 2,
        "sensor_sample_count": null,
        "sensor_sample_digest_sha256": null,
        "sensor_reference": null
      }
    }
  ]
}
~~~

The example hash is intentionally invalid. A runnable manifest must use the
actual file digest. Unknown JSON fields, unsafe paths, duplicate IDs/paths,
missing rights references, uppercase/invalid hashes, and contradictory
expectations are errors.

Path validation follows Windows semantics. It rejects alternate-data-stream
colons, control or wildcard characters, reserved device names, trailing dots
or spaces, and case-insensitive duplicate paths. After opening a case, the
runner asks Windows for the final path of that exact handle and rejects a
symlink or junction escape before reading it.

The DNG lossless-compressed slot accepts only TIFF compression 7 (lossless
JPEG) or 8 (Deflate); code 34892 is explicitly lossy and cannot satisfy it.
Bayer DNG evidence requires a 2x2 CFA repeat, while RAF X-Trans evidence
requires 6x6. CR3 and C-RAW must also return their distinct normalized
compression descriptions; the family label alone cannot satisfy the gate.
Sensor count, digest, and an independent reference must either all be absent or
all be present. The count serializes as a decimal string, the digest is
lowercase SHA-256, and the reference records how the trusted values were
established. Omitting them is allowed while assembling a corpus, but makes
`gate_ready` impossible.

The runner canonicalizes the corpus root, opens the relative case once, and
rejects the final handle path when it lies outside that root. One input is
limited to 2 GiB before allocation.

## Evidence Bundle

RawEvidenceBundle.schema_version is 1. All sizes, timings, and memory values
serialize as decimal strings to preserve u64 in JavaScript.
The bundle records the exact manifest SHA-256; collection fails if the manifest
changes before, during, or after a child run.

Each case records one outcome:

- probe_succeeded: contains the R0-A report plus explicit sensor-unpack
  evidence;
- integrity_mismatch: hash verification failed and the probe was not run;
- unsupported_family: this runner does not implement that container;
- probe_failed: the owned probe returned a structured error;
- input_failed: path, file, or size validation failed;
- child_process_failed: the isolated runner crashed or exited abnormally.

Every parent-run case also records bounded stdout/stderr sizes, truncation and
timeout flags, wall time, and the parent-observed child peak working set. A
timeout, output overflow, record/manifest mismatch, or malformed child JSON is
stored as child_process_failed rather than trusted as candidate evidence.
The record carries the manifest expectations used for that case so a bundle is
self-describing and the parent can reject substituted expectations.

The owned runner emits sensor_unpack.status = not_attempted. It must never
translate a successful metadata probe into a sensor-decode claim.

The bundle summary sets gate_ready = true only when:

- the runner is a clean release build with a known Git revision;
- required corpus coverage is complete;
- every case has a successful metadata report;
- every case has successful sensor-unpack evidence;
- every manifest expectation passes;
- case IDs are unique, all required families are represented, and the runner
  declares support for each of them;
- sensor evidence exactly matches an independently established manifest sample
  count and SHA-256, as well as the count derived from report dimensions;
- stage timings, child timing, and both peak-memory observations are complete;
- no child timed out or exceeded its output limit.

Therefore an owned R0-A-only evidence run is useful as a baseline but cannot
pass R0-B by itself.

Runner identity includes the build-time Git revision, a clean/dirty/unknown
state verified again against the source tree at runtime, the Cargo profile,
GPL-3.0 source license, executable SHA-256 and size, supported families, the
enforced child limits, and zero bundled runtime payload bytes. Unknown source
state is never gate-eligible. Peak working set is sampled through
K32GetProcessMemoryInfo in both the case process and its parent.

## Commands

Build the formal runner from a clean revision using the offline snapshot:

~~~powershell
cargo build -p hgripe-raw-evidence --release --offline
~~~

Validate a manifest:

~~~powershell
target\release\hgripe-raw-evidence.exe validate C:\path\to\manifest.json
~~~

Collect the owned baseline:

~~~powershell
target\release\hgripe-raw-evidence.exe run-owned C:\path\to\manifest.json C:\path\to\corpus-root C:\path\to\new-evidence.json
~~~

Use a new output name for every run. Evidence files are immutable run records.
Before any evidence is shared or committed, review source URIs, make/model
metadata, rights, and personal metadata.

## Current State And Next Gate

R0-B1 is implemented and tested with generated little- and big-endian DNG
fixtures, malformed manifests, Windows path escapes, concurrent evidence
writers, child timeout/output limits, and gate tampering cases. No real camera
corpus is present, no proprietary container is parsed, and no sensor samples
are unpacked.

R0-B2 is the next step:

1. acquire or identify license-safe local files for all required families;
2. remove or separately protect personal metadata as required by the rights
   basis;
3. calculate SHA-256 and fill expected facts in a local manifest;
4. establish trusted unpacked-sensor sample counts/digests independently of the
   candidate being evaluated; a candidate cannot certify its own reference;
5. run the release owned baseline and review every mismatch;
6. only then design disposable external-candidate runners against this same
   schema.

External source still does not enter the product workspace or maintained
third_party tree during R0-B. Any adoption, pruning, VENDOR.md, and H-Gripe
adapter begin only after the R0-C written decision.
