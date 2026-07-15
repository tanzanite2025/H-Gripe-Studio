# Vendored ONNX Runtime - version lock

H-Gripe Studio ships a repository-managed ONNX Runtime for its local small-model
features. The current payload is the Windows x64 CPU baseline. It is loaded
dynamically by the desktop app; no system ONNX Runtime installation and no
build-time download are allowed.

## Current lock

| What | Value |
| --- | --- |
| ONNX Runtime release | `1.24.2` |
| Upstream commit | `058787ceead760166e3c50a0a4cba8a833a6f53f` |
| ONNX Runtime C API | `24` |
| Platform | Windows x64 |
| Execution provider | CPU |
| Rust binding | `ort` exactly `2.0.0-rc.12`, with `load-dynamic` |
| Runtime payload | `win-x64/bin/onnxruntime.dll` |
| License | MIT; see `LICENSE` and `ThirdPartyNotices.txt` |

The official DLL requires the Microsoft Visual C++ 2015-2022 Redistributable
(x64); packaged-install verification must include that prerequisite.

Official archive:

```text
https://github.com/microsoft/onnxruntime/releases/download/v1.24.2/onnxruntime-win-x64-1.24.2.zip
```

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Official ZIP | `74075355` | `8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0` |
| `onnxruntime.dll` | `14148680` | `114947d633e6844ce3c4b51ef6678f776628571d08a5763859c61642c8dcca9c` |

The DLL is stored with Git LFS. After cloning, run `git lfs pull` before an
offline build if normal LFS checkout did not materialise it. A text LFS pointer
is not a usable runtime.

`win-x64/bin` is an exact DLL allowlist containing only `onnxruntime.dll` for
the current CPU flavor. The root also carries `LICENSE`,
`ThirdPartyNotices.txt`, `VERSION_NUMBER`, and `GIT_COMMIT_ID`.
Provider-shared, provider-specific, and accelerator dependency DLLs are not
shipped. Model weights are separate runtime artifacts and are not part of this
lock.

## Refresh procedure

`scripts/fetch-onnxruntime.ps1` is a maintainer-only acquisition script. It
downloads the locked official ZIP, verifies the archive before extraction,
selects only the files listed above, and verifies the runtime DLL again before
updating this directory.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\fetch-onnxruntime.ps1
git lfs status
```

The script must never be called from Cargo build scripts, Tauri hooks, or CI.
Normal builds and tests are network-free with respect to ONNX Runtime.

For an upgrade, use a dedicated change that updates all of the following
together:

1. The release URL, version, upstream commit, archive hash, DLL hash, and sizes
   in this file and the fetch script.
2. The exact compatible `ort` / `ort-sys` pin and vendored Cargo snapshot.
3. The runtime lock/smoke tests and Tauri resource mapping.
4. The checked-in DLL and upstream license/notice files.
5. Offline workspace checks plus real DLL-load and model-path regression tests.

## Provider roadmap

CPU is the baseline for this stage, not a permanent product limit. Keep the
provider-selection and device-request contract intact. A later Windows NVIDIA
stage may use CUDA; Windows AMD and Intel should use DirectML. ROCm is not a
Windows product target.

Do not vendor `onnxruntime_providers_shared.dll` on its own in anticipation of
those stages: it provides no GPU capability or forward-compatibility by itself.
Each provider must atomically add its core, provider-shared, provider-specific,
and dependency binaries, registration path, locked license/version metadata,
fallback behavior, packaging, and real-GPU tests. The official CUDA and
DirectML distributions contain different `onnxruntime.dll` builds, so they
cannot be copied over one another. A combined installer requires either a
locked joint build or a startup-selected runtime flavor with restart semantics.

## Forbidden

- Restoring `ort/download-binaries` or its HTTP/TLS downloader chain.
- Falling back silently to an arbitrary system-installed ONNX Runtime.
- Downloading ONNX Runtime from a build, test, packaging hook, or CI job.
- Replacing only the DLL, Rust binding, or lock metadata without the other two.
