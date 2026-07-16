//! Windows-only R0 corpus validation and evidence collection.

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
compile_error!("hgripe-raw-evidence supports Windows x64 only");

mod manifest;
mod model;
mod runner;
mod windows_support;

pub use manifest::{
    load_manifest, load_manifest_snapshot, validate_manifest, ManifestLoadError,
    RawManifestSnapshot,
};
pub use model::*;
pub use runner::{
    build_runner_identity, child_command_name, collect_owned_evidence, find_case, probe_owned_case,
    resolve_case_path, sha256_file, write_evidence_bundle, EvidenceRunError, MAX_CORPUS_FILE_BYTES,
};
