# RAW R0 Windows Evidence

**Status:** R0-B1 runner, R0-B2a canonical sensor-reference contract, and
R0-B2b corpus preflight/fingerprint tools implemented on 2026-07-16 and
2026-07-17.

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
- pins the exact manifest snapshot SHA-256 in the parent before and after every
  child run;
- gives the child one bounded JSON case snapshot through stdin only after Job
  assignment. The snapshot contains only its schema version, case ID, family,
  relative path, and source SHA-256; it omits variant, provenance, all expected
  facts, and the complete `sensor_reference` object. The child receives no
  manifest path or expected sensor digest through the protocol;
- pre-creates the sensor-output file, retains a non-replaceable parent handle,
  and independently reads, counts, and hashes the canonical bytes after the
  child exits. A child-provided count or digest is never accepted as parent
  evidence;
- polls that retained file handle while the child runs and terminates the Job
  when the file exceeds the exact manifest byte count, or any hard artifact
  limit;
- never embeds an absolute corpus path in the evidence bundle;
- publishes evidence with an atomic Windows no-replace move, so concurrent runs
  cannot overwrite an existing evidence file.

Corpus files and generated evidence are local data, not product assets. The
repository ignores /raw-corpus/ and /raw-evidence/ to reduce accidental commits
of licensed camera files or personal metadata.

## Corpus Manifest

RawCorpusManifest.schema_version is 3. A case requires:

- a unique stable ASCII ID;
- one required camera family and a human-readable variant;
- a forward-slash relative path with no root, drive, dot, or parent component;
- an exact lowercase SHA-256;
- source origin, rights reference, redistribution policy, and personal-metadata
  flag;
- optional expected make/model, dimensions, TIFF compression code/description,
  CFA repeat dimensions, and an optional structured sensor reference. CR3 and
  CR3 C-RAW require the normalized descriptions `canon_cr3_raw` and
  `canon_cr3_c_raw`, respectively.

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
  "schema_version": 3,
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
        "sensor_reference": {
          "schema_version": 2,
          "domain": "full_sensor_raster",
          "frame": "only_full_resolution_raw_frame",
          "full_resolution_raw_frame_count": 1,
          "sample_order": "row_major_interleaved",
          "sample_encoding": "unsigned_u16_little_endian",
          "dimensions": {
            "width": 6,
            "height": 6
          },
          "samples_per_pixel": 1,
          "sample_count": "36",
          "sample_digest_sha256": "replace-with-canonical-sample-sha256",
          "producer": {
            "basis": "independent_decoder",
            "implementation_id": "reference-decoder-lineage",
            "implementation_revision": "reference-source-revision",
            "tool_id": "reference-tool-id",
            "tool_version": "reference-tool-version",
            "tool_artifact_sha256": "replace-with-reference-tool-sha256",
            "record_reference": "local immutable reference record id",
            "record_relative_path": "references/dng-uncompressed-owned-001.json",
            "record_artifact_sha256": "replace-with-reference-record-sha256"
          }
        }
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
The sensor reference may be omitted while assembling an incremental manifest,
but `gate_ready` is then impossible.

The runner canonicalizes the corpus root, opens the relative case once, and
rejects the final handle path when it lies outside that root. One input is
limited to 2 GiB before allocation.

## Canonical Sensor Reference

RawSensorReference.schema_version is 2. It defines one comparable unpacked
sensor stream without authorizing a decoder implementation:

- `domain = full_sensor_raster`: the complete sensor raster, including
  inactive borders, masked pixels, and optical-black samples represented by the
  only full-resolution RAW frame;
- `frame = only_full_resolution_raw_frame` and
  `full_resolution_raw_frame_count = 1`: a source with zero, multiple, or
  ambiguous full-resolution RAW frames is not gate-eligible under reference
  schema 2;
- samples are the original unsigned decoded sensor codes before orientation,
  active-area crop, linearization, black subtraction, white normalization,
  bad-pixel correction, white balance, highlight work, or demosaic;
- packed source values are zero-extended to `u16` without scaling;
- reference schema 2 accepts one reported bits-per-sample value in the range
  1 through 16;
- `sample_order = row_major_interleaved`: rows top-to-bottom, columns
  left-to-right, then sample index within a pixel. Schema 2 accepts exactly one
  CFA sample per pixel;
- `sample_encoding = unsigned_u16_little_endian`: each sample contributes
  exactly two little-endian bytes with no header, row padding, trailer, or
  container bytes;
- SHA-256 is calculated over exactly `sample_count * 2` canonical bytes. The
  schema rejects a reference whose canonical artifact would exceed 2 GiB.

The owned helper `canonical_sensor_digest_u16_le` implements only this byte
encoding and hash. It accepts already-unpacked `u16` values; it does not parse
or decode RAW files.

The producer record fixes the reference basis, canonical lowercase decoder or
generator implementation lineage, implementation revision, wrapper tool ID and
version, exact tool artifact SHA-256, the immutable local record ID, its safe
corpus-root-relative path, and record artifact SHA-256. Allowed bases are a
known generated fixture, an
independent decoder, or a vendor reference. A known generated fixture requires
redistributable-fixture provenance.

The candidate runner separately records its sensor-decoder implementation ID,
revision, and decoder artifact SHA-256. The gate rejects the same implementation
lineage even when wrapper IDs or wrapper executables differ, and rejects a
reference tool artifact that equals the candidate decoder artifact.

Manifest validation checks the reference record ID, relative path, and digest
shape. R0-B2b preflight opens that path under the corpus root, verifies the
final Windows handle remains inside the root, enforces a 64 MiB record limit,
and hashes the actual immutable record before declaring the case ready.

## Evidence Bundle

RawEvidenceBundle.schema_version is 3. All sizes, timings, and memory values
serialize as decimal strings to preserve u64 in JavaScript.
The bundle records the exact manifest SHA-256; collection fails if the manifest
changes before, during, or after a child run.
Every bundle also embeds the read-only `corpus_preflight` report captured before
child execution. Incremental owned baselines remain writable when that report is
not ready, but `gate_ready` can never become true unless the embedded report has
`corpus_ready = true` and refers to the same manifest SHA-256.

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

For sensor success, `full_resolution_raw_frame_count` remains a decoder report.
The parent accepts only the value `1` at the gate. `artifact_parent_observed`
means only that the parent read the retained output-file handle and replaced the
child's sample count and digest with its own observation. The artifact length
must exactly equal the manifest reference count times two, and parent reading is
bounded by the recorded artifact byte and observation-time limits.
The child-process metrics separately record when the runtime artifact limit
terminated the Job.

This is a blind comparison protocol, not an adversarial Windows sandbox. The
child runs under the same user token and can read the case file. Omitting the
reference from stdin/argv prevents ordinary candidate code from directly
echoing the expected digest; it does not prove implementation independence or
defend against deliberately malicious code. R0-B2 still requires manual source,
rights, lineage, and reference-record review before a result is accepted.

The owned runner emits sensor_unpack.status = not_attempted. It must never
translate a successful metadata probe into a sensor-decode claim.

The bundle summary sets gate_ready = true only when:

- the runner is a clean release build with a known Git revision;
- the embedded corpus preflight is ready for the exact same manifest snapshot;
- required corpus coverage is complete;
- every case has a successful metadata report;
- every case has successful sensor-unpack evidence;
- every manifest expectation passes;
- case IDs are unique, all required families are represented, and the runner
  declares support for each of them;
- sensor evidence exactly matches an independently established manifest sample
  count and SHA-256, as well as dimensions and count derived from the metadata
  report and the canonical schema;
- the reference implementation lineage and artifact differ from the candidate
  decoder identity and artifact;
- the parent observed the exact canonical artifact itself;
- stage timings, parent artifact-observation timing, child timing, and both
  peak-memory observations are complete;
- no child timed out or exceeded its output limit.

Therefore an owned R0-A-only evidence run is useful as a baseline but cannot
pass R0-B by itself.

Runner identity includes the build-time Git revision, a clean/dirty/unknown
state verified again against the source tree at runtime, the Cargo profile,
GPL-3.0 source license, executable SHA-256 and size, supported families, the
enforced child and parent-artifact limits, candidate decoder lineage/artifact,
and zero bundled runtime payload bytes. Unknown source state or an incomplete
decoder identity is never gate-eligible. Peak working set is sampled through
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

Run the read-only corpus preflight:

~~~powershell
target\release\hgripe-raw-evidence.exe verify-corpus C:\path\to\manifest.json C:\path\to\corpus-root
~~~

The command prints schema 1 preflight JSON. Exit code 0 means `corpus_ready` is
true; exit code 3 means the report was produced but at least one manifest,
coverage, source-file, sensor-reference, or reference-record requirement is
not ready. It never runs a decoder and never writes evidence. Source and record
files are held through Windows handles that allow shared reads but block writes
and deletion during hashing; the manifest snapshot is checked again after all
cases.

Draft one file identity with every non-file fact supplied explicitly by the
operator:

~~~powershell
target\release\hgripe-raw-evidence.exe fingerprint C:\path\to\corpus-root cameras/sample.nef sample-nef-001 nikon_nef "operator asserted Nikon NEF" local_evaluation_only "local rights record 001" prohibited false -
~~~

The final `-` means no source URI. The output contains the final-handle-bound
file size and SHA-256 plus a case draft. Family, origin, rights, redistribution,
personal-metadata status, variant, ID, and optional source URI are operator
assertions; the command does not infer them from file bytes or extensions. All
metadata, compression, CFA, dimensions, and sensor-reference facts remain null
and are listed in `unresolved_fields`.

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
writers, child timeout/output limits, and gate tampering cases. One local ignored
CC0 Leica M8 DNG now exercises incremental intake and the owned metadata probe;
the complete real-camera corpus and independent references are not present. No
proprietary container is parsed and no sensor samples are unpacked.

R0-B2a is also implemented: manifest/evidence schema 3 carries the structured
sensor reference above, validation rejects non-canonical dimensions, counts,
digests, producer identity, oversized artifacts, and fixture provenance. The
parent uses a bounded blind child snapshot and retained output handle to compute
the candidate artifact count/digest, while the gate rejects matching decoder
lineage. These controls prevent direct protocol self-certification but do not
automatically prove independent implementation. This still does not provide a
real corpus or a sensor decoder.

R0-B2b is implemented: `verify-corpus` produces a read-only readiness report
for every source and immutable reference record, while `fingerprint` produces
only an operator-asserted manifest draft plus handle-bound size/SHA-256. Neither
command decodes RAW data, guesses rights/privacy/family, or writes evidence.

The next step is local corpus acquisition and verification:

1. acquire or identify license-safe local files for all required families;
2. remove or separately protect personal metadata as required by the rights
   basis;
3. use `fingerprint` to calculate source identity, then explicitly review and
   fill expected facts in a local manifest;
4. establish trusted unpacked-sensor references independently of the
   candidate being evaluated; a candidate cannot certify its own reference;
5. bind each local immutable reference record through `record_relative_path`
   and its SHA-256, then require `verify-corpus` to report `corpus_ready`;
6. run the release owned baseline and review every mismatch;
7. only then design disposable external-candidate runners against this same
   schema.

External source still does not enter the product workspace or maintained
third_party tree during R0-B. Any adoption, pruning, VENDOR.md, and H-Gripe
adapter begin only after the R0-C written decision.
