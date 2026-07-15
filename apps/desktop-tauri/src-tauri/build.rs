use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const ONNX_RUNTIME_DLLS: [(&str, u64); 1] = [("onnxruntime.dll", 14_148_680)];

fn main() {
    copy_onnx_runtime_dlls();
    tauri_build::build();

    // With the `native-ffmpeg` feature, the vendored libav* DLLs must sit next
    // to the binary that links them (Windows resolves DLLs from the executable
    // directory). Copy them beside both the app binary and the cargo-test
    // binaries so `cargo test --features native-ffmpeg` can load them. Build
    // scripts don't see `#[cfg(feature = ...)]`, so gate on the CARGO_FEATURE_*
    // env var cargo sets for enabled features.
    if std::env::var_os("CARGO_FEATURE_NATIVE_FFMPEG").is_some() {
        copy_ffmpeg_runtime_dlls();
    }
}

/// Copy the repository-maintained Windows x64 ONNX Runtime next to Cargo app
/// and test binaries. `ort/load-dynamic` performs no build-time linking or
/// downloading, so the application owns runtime placement explicitly.
fn copy_onnx_runtime_dlls() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os != "windows" || target_arch != "x86_64" {
        println!(
            "cargo:warning=onnxruntime: this repository supplies only the Windows x64 runtime; skipping DLL copy for {target_os}/{target_arch}"
        );
        return;
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bin = manifest.join("../../../third_party/onnxruntime/win-x64/bin");
    println!("cargo:rerun-if-changed={}", bin.display());

    let dests = cargo_binary_dirs();
    for (name, expected_len) in ONNX_RUNTIME_DLLS {
        let source = bin.join(name);
        validate_pe_dll(&source, expected_len);
        for dest in &dests {
            std::fs::create_dir_all(dest).unwrap_or_else(|err| {
                panic!(
                    "onnxruntime: failed to create destination {}: {err}",
                    dest.display()
                )
            });
            let target = dest.join(name);
            std::fs::copy(&source, &target).unwrap_or_else(|err| {
                panic!(
                    "onnxruntime: failed to copy {} to {}: {err}",
                    source.display(),
                    target.display()
                )
            });
        }
    }
}

fn cargo_binary_dirs() -> [PathBuf; 2] {
    // OUT_DIR is `<target>/<profile>/build/<pkg>-<hash>/out`; app binaries
    // land in the profile directory and integration/unit tests in `deps/`.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| panic!("unexpected Cargo OUT_DIR layout: {}", out_dir.display()));
    [profile_dir.to_path_buf(), profile_dir.join("deps")]
}

fn validate_pe_dll(path: &Path, expected_len: u64) {
    let metadata = std::fs::metadata(path).unwrap_or_else(|err| {
        panic!(
            "onnxruntime: required vendored DLL {} is unavailable ({err}); run `git lfs pull`",
            path.display()
        )
    });
    if metadata.len() != expected_len {
        panic!(
            "onnxruntime: {} has {} bytes, expected {expected_len}; the file may be a Git LFS pointer or a mismatched runtime (run `git lfs pull`)",
            path.display(),
            metadata.len()
        );
    }

    let mut signature = [0_u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .unwrap_or_else(|err| panic!("onnxruntime: cannot read {}: {err}", path.display()));
    if signature != *b"MZ" {
        panic!(
            "onnxruntime: {} is not a Windows PE DLL; run `git lfs pull`",
            path.display()
        );
    }
}

fn copy_ffmpeg_runtime_dlls() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bin = manifest.join("../../../third_party/ffmpeg/win-x64/bin");
    println!("cargo:rerun-if-changed={}", bin.display());

    let dests = cargo_binary_dirs();

    let entries = match std::fs::read_dir(&bin) {
        Ok(entries) => entries,
        Err(err) => {
            println!(
                "cargo:warning=native-ffmpeg: cannot read {} ({err}); DLLs not copied",
                bin.display()
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("dll") {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        for dest in &dests {
            let _ = std::fs::create_dir_all(dest);
            let _ = std::fs::copy(&path, dest.join(name));
        }
    }
}
