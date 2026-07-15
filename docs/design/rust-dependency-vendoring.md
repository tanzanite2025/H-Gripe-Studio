# Rust dependency vendoring

**Status:** Active policy.

H-Gripe Studio keeps Rust dependencies reproducible by cutting Cargo's default
network path to crates.io. (There is no Python runtime since Phase 7, #314,
so Rust crates are the only language-package surface to vendor.)

## Layout

| Area | Path | Purpose |
| --- | --- | --- |
| Cargo source replacement | `.cargo/config.toml` | Replaces `crates-io` with the local vendor directory. |
| Registry crate snapshot | `third_party/cargo-vendor/` | Output of `cargo vendor --versioned-dirs`; contains every crates.io package resolved by `Cargo.lock`. |
| Owned colour-management fork | `third_party/moxcms/` | Editable local fork of `moxcms`; wired through workspace `[patch.crates-io]`. |
| Native FFmpeg binaries | `third_party/ffmpeg/` | Windows libav DLLs/headers/import libs for the optional native video backend. |
| Native ONNX Runtime | `third_party/onnxruntime/` | Locked Windows x64 CPU runtime loaded dynamically by the desktop app. |

`third_party/cargo-vendor` is a snapshot. Do not hand-edit vendored registry
crates there. If a crate needs project-specific changes, move that crate to its
own explicit directory under `third_party/<crate>/`, add a `VENDOR.md`, and
wire it with `[patch.crates-io]` like `moxcms`.

## What is cut off

- Cargo will not resolve Rust packages from crates.io during normal workspace
  builds because `.cargo/config.toml` replaces crates.io with
  `third_party/cargo-vendor`.
- `moxcms` is not consumed from the registry snapshot either; it is an owned
  fork at `third_party/moxcms`.

## What is not covered

- Node/npm dependencies.
- Model weights and their opt-in acquisition scripts.

The ONNX Runtime binary is covered by a separate native-artifact lock at
`third_party/onnxruntime/VENDOR.md`. Its Windows x64 CPU DLL is checked in with
Git LFS and packaged from the repository. Cargo build scripts, Tauri hooks, and
CI must not download it;
`scripts/fetch-onnxruntime.ps1` is a manual maintainer refresh tool only.

## Feature minimisation

Vendoring mirrors the resolved dependency graph; it is not permission to keep
every upstream feature enabled. Narrow direct dependencies at their manifest
boundary, then regenerate `Cargo.lock` and `third_party/cargo-vendor` together.
Never delete individual files or crate directories from the snapshot by hand.

The desktop `image` dependency follows the product's still-image contract:

- `png`, `jpeg`, `webp`, `gif`, `bmp`, and `tiff` are enabled explicitly.
- HEIC, HEIF, and AVIF stills decode through the vendored native FFmpeg path.
- DDS, EXR, Farbfeld, HDR, ICO, PNM, QOI, and TGA are not product formats and
  must not re-enter the graph accidentally through `image` default features.

Any change to that codec set must update the shared frontend format contract
and pass the native media decode/thumbnail regression matrix.

### Functional integration before removal

Reduce one dependency boundary at a time. A library function is removable only
after the replacement is on the real product path, parity/fallback tests pass,
and a repository-wide search proves the old path has no callers. Do not equate
"vendored" with "owned": registry snapshots stay upstream code unless a
documented product requirement justifies an explicit fork.

The desktop `ort` dependency currently earns its place through native subject
segmentation, Subject Mask ViTMatte, Refine Mask Edge `onnx_matting`, Detail
Watchdog `onnx_defect`, and Match Light & Color `onnx_harmonize`. These paths
share managed model resolution and a provider-aware warm pool keyed by
canonical model path, runtime flavor, actual provider, and device id. SAM2
resolves its encoder and decoder as one provider group. The runtime adds no
Paddle, Python, Torch, OpenCV or second ONNX dependency. Model weights and label
sidecars are runtime artifacts and are not committed into `cargo-vendor`.

The runtime boundary is now explicit: `ort` uses dynamic loading against the
locked Windows x64 CPU runtime in `third_party/onnxruntime`, and its
`download-binaries` plus HTTP/TLS downloader chain is disabled. A clean clone
must materialise the LFS payload with `git lfs pull`; it must not depend on an
undocumented machine installation or network access during build.

This CPU payload is the current baseline, not a permanent feature ceiling. The
provider-selection and device-request contract stays intact for later Windows
NVIDIA/CUDA and AMD or Intel/DirectML stages; ROCm is not a Windows target.
The CPU `win-x64/bin` directory is an exact DLL allowlist containing only
`onnxruntime.dll`. Provider-shared alone adds no capability, so each GPU stage
must atomically add its core/shared/provider/dependency binaries, registration
path, locked payload, packaging contract, fallback behavior, and real-device
tests. Official CUDA and DirectML packages carry different core DLLs and cannot
be overlaid as one runtime flavor.

## Update procedure

Use this only when deliberately upgrading Rust dependencies:

1. Temporarily allow Cargo to resolve from upstream by editing/removing the
   source replacement locally, or run the update in a disposable checkout.
2. Run the intended `cargo update ...` command.
3. Re-run:

   ```powershell
   cargo vendor --versioned-dirs third_party/cargo-vendor
   ```

4. Restore `.cargo/config.toml` if needed.
5. Run at least:

   ```powershell
   cargo check --workspace --offline
   cargo test -p hgripe-desktop studio::color --offline
   ```

6. For broader dependency changes, also run package tests that cover the touched
   area.

The lockfile, vendor snapshot, and any local fork changes must land in the same
commit so cloud-side work cannot accidentally build against different Rust
source code.
