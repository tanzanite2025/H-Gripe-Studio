# Vendored FFmpeg — version lock

The desktop app links the `native-ffmpeg` feature against the LGPL *shared*
libav\* libraries checked into this directory. No system FFmpeg, no pkg-config,
no vcpkg, no CI download — this tree and the Rust binding are the only source
of truth, and they must be upgraded **as one set**.

## Current lock

| What                        | Value                                        |
| --------------------------- | -------------------------------------------- |
| FFmpeg release line         | **8.1**                                      |
| Platform payload            | `third_party/ffmpeg/win-x64` (bin/include/lib) |
| Rust binding                | `rusty_ffmpeg 0.17.0+ffmpeg.8.1` (vendored in `third_party/cargo-vendor`) |
| Cargo feature               | `ffmpeg8_1` + `use_prebuilt_binding` (`apps/desktop-tauri/src-tauri/Cargo.toml`) |
| Link env                    | `FFMPEG_LIBS_DIR` / `FFMPEG_LINK_MODE=dynamic` / `FFMPEG_BINDING_PATH` in `apps/desktop-tauri/src-tauri/.cargo/config.toml` |

libav\* majors shipped by 8.1 (encoded in the DLL file names):

| lib        | major | runtime DLL         |
| ---------- | ----- | ------------------- |
| avutil     | 60    | `avutil-60.dll`     |
| avcodec    | 62    | `avcodec-62.dll`    |
| avformat   | 62    | `avformat-62.dll`   |
| avfilter   | 11    | `avfilter-11.dll`   |
| avdevice   | 62    | `avdevice-62.dll`   |
| swscale    | 9     | `swscale-9.dll`     |
| swresample | 6     | `swresample-6.dll`  |

## Enforcement

`apps/desktop-tauri/src-tauri/tests/ffmpeg_vendor_lock.rs` runs in the normal
`cargo test` CI job and fails on any partial change: it cross-checks the
`ffmpegX_Y` Cargo feature against the vendored header majors, the DLL/import-lib
file names, the `FFMPEG_*` env in `.cargo/config.toml`, the `rusty_ffmpeg`
version pinned in `Cargo.lock`, and the vendored crate directory.

## Upgrade procedure (e.g. 8.1 → 8.2 / 9.x)

Always a dedicated PR — never upgrade "in passing". In that one PR:

1. Replace `third_party/ffmpeg/win-x64` (bin + include + lib) with the new
   LGPL shared build.
2. Bump `rusty_ffmpeg` (version and/or `ffmpegX_Y` feature) in
   `apps/desktop-tauri/src-tauri/Cargo.toml`.
3. Re-run `cargo vendor` so `third_party/cargo-vendor` and `Cargo.lock` follow.
4. Extend `expected_majors()` in `tests/ffmpeg_vendor_lock.rs` with the new
   feature → libav\* major table, and update the tables in this file.
5. `cargo check --workspace --offline`, then `cargo test` — including the
   video probe / decode / trim / assemble / timeline-export tests.

## Forbidden

- Linking against a system FFmpeg, vcpkg, or anything downloaded in CI.
- `cargo update`-ing `rusty_ffmpeg` without updating the vendor dir and this
  payload.
- Swapping DLLs or headers without touching the Cargo feature (and vice
  versa) — the lock test exists precisely to catch this.
