//! Windows x64 ONNX Runtime supply-chain and load contract.
//!
//! Keep the Rust wrapper ABI, repository-maintained DLL, Tauri resource map,
//! and Git LFS policy in one atomic upgrade. See third_party/onnxruntime/VENDOR.md.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ORT_VERSION: &str = "1.24.2";
const ORT_COMMIT: &str = "058787ceead760166e3c50a0a4cba8a833a6f53f";
const ORT_DLL_BYTES: u64 = 14_148_680;
const ORT_DLL_SHA256: &str = "114947d633e6844ce3c4b51ef6678f776628571d08a5763859c61642c8dcca9c";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn vendor_root() -> PathBuf {
    repo_root().join("third_party/onnxruntime")
}

fn runtime_dll() -> PathBuf {
    vendor_root().join("win-x64/bin/onnxruntime.dll")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

fn package_block<'a>(lock: &'a str, name: &str) -> &'a str {
    lock.split("[[package]]")
        .find(|block| {
            block
                .lines()
                .any(|line| line.trim() == format!("name = \"{name}\""))
        })
        .unwrap_or_else(|| panic!("Cargo.lock has no package `{name}`"))
}

fn sha256(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn cargo_uses_exact_dynamic_api_24_without_a_downloader() {
    let root = repo_root();
    let manifest = read(&root.join("apps/desktop-tauri/src-tauri/Cargo.toml"));
    let ort_line = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("ort ="))
        .expect("direct ort dependency");
    assert!(ort_line.contains("version = \"=2.0.0-rc.12\""));
    assert!(ort_line.contains("\"load-dynamic\""));
    assert!(ort_line.contains("\"api-24\""));
    assert!(!ort_line.contains("download-binaries"));
    assert!(!ort_line.contains("tls-"));
    assert!(!ort_line.contains("copy-dylibs"));

    let lock = read(&root.join("Cargo.lock"));
    for package in ["ort", "ort-sys"] {
        let block = package_block(&lock, package);
        assert!(
            block
                .lines()
                .any(|line| line == "version = \"2.0.0-rc.12\""),
            "{package} must stay exactly aligned with the ONNX Runtime 1.24 ABI"
        );
    }
    let ort_dependencies =
        [package_block(&lock, "ort"), package_block(&lock, "ort-sys")].join("\n");
    for removed in [
        "hmac-sha256",
        "lzma-rust2",
        "socks",
        "ureq",
        "ureq-proto",
        "utf8-zero",
    ] {
        assert!(
            !ort_dependencies.contains(&format!("\"{removed}\"")),
            "ORT must not regain downloader dependency `{removed}`"
        );
    }
}

#[test]
fn vendored_runtime_identity_hash_and_pe_arch_are_locked() {
    let vendor = vendor_root();
    assert_eq!(read(&vendor.join("VERSION_NUMBER")).trim(), ORT_VERSION);
    assert_eq!(read(&vendor.join("GIT_COMMIT_ID")).trim(), ORT_COMMIT);
    assert!(vendor.join("LICENSE").is_file());
    assert!(vendor.join("ThirdPartyNotices.txt").is_file());
    assert!(vendor.join("VENDOR.md").is_file());

    let dll = runtime_dll();
    assert_eq!(
        fs::metadata(&dll).expect("runtime metadata").len(),
        ORT_DLL_BYTES
    );
    assert_eq!(sha256(&dll), ORT_DLL_SHA256);
    let bin = vendor.join("win-x64/bin");
    let mut dlls: Vec<String> = fs::read_dir(&bin)
        .expect("runtime bin directory")
        .map(|entry| entry.expect("runtime bin entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
        })
        .map(|path| {
            path.file_name()
                .expect("DLL file name")
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    dlls.sort();
    assert_eq!(
        dlls,
        ["onnxruntime.dll"],
        "the CPU runtime directory is an exact DLL allowlist; provider DLLs must arrive atomically with their runtime flavor"
    );

    let bytes = fs::read(&dll).expect("runtime DLL");
    assert_eq!(&bytes[0..2], b"MZ", "runtime must be a PE image");
    let pe_offset = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    assert_eq!(&bytes[pe_offset..pe_offset + 4], b"PE\0\0");
    let machine = u16::from_le_bytes(bytes[pe_offset + 4..pe_offset + 6].try_into().unwrap());
    assert_eq!(machine, 0x8664, "runtime must target AMD64/x86_64 Windows");
}

#[test]
fn lfs_and_tauri_bundle_map_the_same_runtime() {
    let root = repo_root();
    let attributes = read(&root.join(".gitattributes"));
    assert!(attributes.contains("third_party/onnxruntime/** linguist-vendored"));
    assert!(
        attributes.contains("third_party/onnxruntime/**/*.dll filter=lfs diff=lfs merge=lfs -text")
    );

    let config = read(&root.join("apps/desktop-tauri/src-tauri/tauri.conf.json"));
    assert!(config.contains(
        "third_party/onnxruntime/win-x64/bin/onnxruntime.dll\": \"runtime/onnxruntime/onnxruntime.dll"
    ));
    assert!(!config.contains("onnxruntime_providers_shared.dll"));
    assert!(config.contains("third_party/onnxruntime/LICENSE"));
    assert!(config.contains("third_party/onnxruntime/ThirdPartyNotices.txt"));
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
#[test]
fn vendored_runtime_loads_and_exposes_api_24() {
    assert_eq!(ort::MINOR_VERSION, 24);
    let dll = runtime_dll().canonicalize().expect("canonical runtime DLL");
    ort::init_from(&dll)
        .unwrap_or_else(|err| panic!("load {}: {err}", dll.display()))
        .commit();
    let build_info = ort::info();
    assert!(
        build_info.contains("ORT Build Info"),
        "unexpected build info: {build_info}"
    );
    ort::session::Session::builder().expect("create ORT session builder");
}
