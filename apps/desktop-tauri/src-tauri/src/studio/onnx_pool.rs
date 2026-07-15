//! Process-global warm pool of ONNX Runtime sessions (`Compute` lane).
//!
//! The `Compute` segmenters (`subject_model`'s salient nets and `subject_sam2`)
//! previously rebuilt an `ort::Session` from the weight file on *every* run —
//! reading and re-parsing hundreds of megabytes (BiRefNet ~224 MB, the SAM 2
//! encoder ~134 MB) per invocation. This module keeps the parsed sessions warm:
//! the first load of a given weight path builds the session, every subsequent
//! request for the same path shares it. This is staged-rollout step 3 of
//! `docs/cards/editor-resource-model.md` ("cache `ort::Session` in a warm pool;
//! kill per-call model reload").
//!
//! Each session is wrapped in a `Mutex` because `Session::run` takes `&mut self`
//! (ort ≥ 2.0.0-rc.10 made concurrent runs unsound), so callers serialise their
//! inference through it — which matches both the ONNX Runtime team's guidance
//! against concurrent inference and the GPU `Semaphore(1)` policy from step 2.
//! The pool lives for the life of the process and, like `RESOURCE_DIR`, is a
//! plain `static` rather than Tauri managed state so the handle-free `Compute`
//! segmenters can reach it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use ort::session::Session;

use super::device_report::DeviceUsed;

const ONNX_RUNTIME_DLL: &str = "onnxruntime.dll";
const ONNX_RUNTIME_VERSION: &str = "1.24.2";
const ONNX_RUNTIME_DLL_BYTES: u64 = 14_148_680;

/// Tauri's packaged resource root, captured during setup without loading ORT.
static RUNTIME_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Loading a native library is process-global. Cache both success and failure
/// so a missing/corrupt DLL becomes a stable fallback reason instead of an
/// `ort` lazy-loader panic.
static RUNTIME_INIT: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(crate) struct OnnxRuntimeStatus {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
    pub(crate) providers: Vec<&'static str>,
    pub(crate) reason: Option<String>,
}

/// Store the packaged resource root. Actual loading stays lazy so a damaged
/// optional model runtime cannot prevent the desktop shell from starting.
pub(crate) fn set_runtime_resource_dir(dir: Option<PathBuf>) {
    if let Some(dir) = dir {
        let _ = RUNTIME_RESOURCE_DIR.set(dir);
    }
}

fn bundled_runtime_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("runtime")
        .join("onnxruntime")
        .join(ONNX_RUNTIME_DLL)
}

fn runtime_dll_path() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("ORT_DYLIB_PATH").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        if !path.is_file() {
            return Err(format!(
                "ORT_DYLIB_PATH does not point to an ONNX Runtime DLL: {}",
                path.display()
            ));
        }
        return std::fs::canonicalize(&path).map_err(|err| {
            format!(
                "failed to resolve ONNX Runtime DLL {}: {err}",
                path.display()
            )
        });
    }

    let mut candidates = Vec::new();
    if let Some(resource_dir) = RUNTIME_RESOURCE_DIR.get() {
        candidates.push(bundled_runtime_path(resource_dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(ONNX_RUNTIME_DLL));
        }
    }
    // Development fallback for direct binaries not produced by this package's
    // build script. Packaged installs resolve through the resource directory.
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../third_party/onnxruntime/win-x64/bin")
            .join(ONNX_RUNTIME_DLL),
    );

    if let Some(path) = candidates.iter().find(|path| path.is_file()) {
        return std::fs::canonicalize(path).map_err(|err| {
            format!(
                "failed to resolve ONNX Runtime DLL {}: {err}",
                path.display()
            )
        });
    }

    let searched = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "ONNX Runtime {ONNX_RUNTIME_VERSION} for Windows x64 was not found (searched: {searched}); run `git lfs pull` for a source checkout or reinstall the application"
    ))
}

fn validate_runtime_dll(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|err| {
        format!(
            "failed to inspect ONNX Runtime DLL {}: {err}",
            path.display()
        )
    })?;
    if metadata.len() != ONNX_RUNTIME_DLL_BYTES {
        return Err(format!(
            "ONNX Runtime DLL {} has {} bytes, expected {ONNX_RUNTIME_DLL_BYTES}; the file is corrupt, mismatched, or still a Git LFS pointer",
            path.display(),
            metadata.len()
        ));
    }

    let bytes = std::fs::read(path)
        .map_err(|err| format!("failed to read ONNX Runtime DLL {}: {err}", path.display()))?;
    if bytes.get(..2) != Some(b"MZ") {
        return Err(format!(
            "ONNX Runtime DLL {} is not a Windows PE image",
            path.display()
        ));
    }
    let pe_offset = bytes
        .get(0x3c..0x40)
        .and_then(|raw| raw.try_into().ok())
        .map(u32::from_le_bytes)
        .map(|offset| offset as usize)
        .ok_or_else(|| {
            format!(
                "ONNX Runtime DLL {} has no PE header offset",
                path.display()
            )
        })?;
    if bytes.get(pe_offset..pe_offset + 4) != Some(b"PE\0\0") {
        return Err(format!(
            "ONNX Runtime DLL {} has an invalid PE signature",
            path.display()
        ));
    }
    let machine = bytes
        .get(pe_offset + 4..pe_offset + 6)
        .and_then(|raw| raw.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or_else(|| format!("ONNX Runtime DLL {} has no PE machine id", path.display()))?;
    if machine != 0x8664 {
        return Err(format!(
            "ONNX Runtime DLL {} targets PE machine 0x{machine:04x}, expected Windows x64 (0x8664)",
            path.display()
        ));
    }
    Ok(())
}

fn initialize_runtime() -> Result<(), String> {
    let path = runtime_dll_path()?;
    validate_runtime_dll(&path)?;
    std::panic::catch_unwind(|| -> Result<(), String> {
        let builder = ort::init_from(&path).map_err(|err| {
            format!(
                "failed to load ONNX Runtime {} from {}: {err}",
                ONNX_RUNTIME_VERSION,
                path.display()
            )
        })?;
        builder.commit();
        // Resolve the API table now. Session creation must never be the first
        // call that discovers a corrupt or ABI-incompatible native runtime.
        let _ = ort::info();
        Ok(())
    })
    .map_err(|_| {
        format!(
            "ONNX Runtime {} panicked while loading or querying {}",
            ONNX_RUNTIME_VERSION,
            path.display()
        )
    })?
}

pub(crate) fn ensure_onnx_runtime() -> Result<(), String> {
    match RUNTIME_INIT.get_or_init(initialize_runtime) {
        Ok(()) => Ok(()),
        Err(reason) => Err(reason.clone()),
    }
}

fn runtime_status_from(result: Result<(), String>) -> OnnxRuntimeStatus {
    match result {
        Ok(()) => OnnxRuntimeStatus {
            installed: true,
            version: Some(ONNX_RUNTIME_VERSION.to_string()),
            providers: compiled_providers(),
            reason: None,
        },
        Err(reason) => OnnxRuntimeStatus {
            installed: false,
            version: None,
            providers: Vec::new(),
            reason: Some(reason),
        },
    }
}

pub(crate) fn onnx_runtime_status() -> OnnxRuntimeStatus {
    runtime_status_from(ensure_onnx_runtime())
}

/// Requested execution device for ONNX inference — the `requested` half of
/// the shared DeviceReport vocabulary (GPU_DEVICE_STRATEGY_PLAN). Parsed from
/// the node's `device` param; anything unrecognised reads as `Auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnnxDeviceRequest {
    Auto,
    Cpu,
    Cuda,
    DirectMl,
    Gpu,
}

impl OnnxDeviceRequest {
    pub(crate) fn from_param(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "cpu" => Self::Cpu,
            "cuda" => Self::Cuda,
            "directml" => Self::DirectMl,
            "gpu" => Self::Gpu,
            _ => Self::Auto,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::DirectMl => "directml",
            Self::Gpu => "gpu",
        }
    }
}

/// The execution provider a request resolved to, plus the reason acceleration
/// did not run when it fell back (never silent, per the fallback contract).
#[derive(Debug, Clone)]
pub(crate) struct OnnxProviderResolution {
    /// The provider inference actually runs on (`used` in DeviceReport terms).
    pub(crate) device: &'static str,
    /// Why the request did not accelerate; `None` only for an explicit `cpu`
    /// request, which is honoured rather than fallen back to.
    pub(crate) fallback_reason: Option<String>,
}

/// Resolve a device request against the providers this build carries. The
/// vendored onnxruntime is compiled with the CPU execution provider only, so
/// today every request resolves to CPU — but an explicit `cpu` request is a
/// choice (no reason), while `cuda`, `directml`, generic `gpu`, and `auto` fall
/// back with distinct, visible reasons. When accelerated providers are compiled in they slot in
/// here, preserving the request semantics:
/// `cpu` -> CPU only; `cuda` / `directml` -> that provider else CPU + reason;
/// `auto` -> preferred accelerator else CPU + reason; `gpu` stays
/// vendor-neutral so a later Windows build may choose CUDA or DirectML.
pub(crate) fn resolve_provider(request: OnnxDeviceRequest) -> OnnxProviderResolution {
    match request {
        OnnxDeviceRequest::Cpu => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: None,
        },
        OnnxDeviceRequest::Cuda => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: Some(
                "CUDA execution provider not built in (onnxruntime compiled with CPU provider only)"
                    .to_string(),
            ),
        },
        OnnxDeviceRequest::DirectMl => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: Some(
                "DirectML execution provider not built in (onnxruntime compiled with CPU provider only)"
                    .to_string(),
            ),
        },
        OnnxDeviceRequest::Gpu => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: Some(
                "GPU execution provider not built in (CUDA/DirectML are not packaged; onnxruntime uses CPU)"
                    .to_string(),
            ),
        },
        OnnxDeviceRequest::Auto => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: Some(
                "onnxruntime CPU execution provider (no CUDA/DirectML provider built in)"
                    .to_string(),
            ),
        },
    }
}

/// The execution providers compiled into the vendored onnxruntime, for the
/// central device registry (GPU_DEVICE_STRATEGY_PLAN step 13). CPU only
/// today; accelerated providers (CUDA / DirectML) join this list when the
/// runtime ships them, keeping [`resolve_provider`]'s request semantics.
/// Do not add a provider here as telemetry-only work: provider resolution must
/// first drive `SessionBuilder`, and the resolved provider/runtime flavor must
/// become part of the warm-pool key so CPU and accelerated sessions never alias.
pub(crate) fn compiled_providers() -> Vec<&'static str> {
    vec![DeviceUsed::Cpu.as_str()]
}

/// A warm ONNX session shared across runs. `Mutex` because `Session::run` needs
/// `&mut self`; `Arc` so the pool and every in-flight segmenter share one copy.
pub(super) type SharedSession = Arc<Mutex<Session>>;

/// Weight path → warm session. Keyed by the canonicalised path so the same
/// weight resolved via different relative spellings maps to one session.
static POOL: OnceLock<Mutex<HashMap<PathBuf, SharedSession>>> = OnceLock::new();

fn pool() -> &'static Mutex<HashMap<PathBuf, SharedSession>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The cache key for a weight path: its canonical form when resolvable (so
/// distinct spellings of the same file collapse), otherwise the path as given.
fn cache_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Build an `ort::Session` from an ONNX weight file on disk. Kept private so the
/// only way to obtain a session is through the warm pool.
fn build_session(path: &Path) -> Result<Session, String> {
    ensure_onnx_runtime()?;
    let bytes = std::fs::read(path)
        .map_err(|err| format!("failed to read onnx model {}: {err}", path.display()))?;
    Session::builder()
        .and_then(|mut builder| builder.commit_from_memory(&bytes))
        .map_err(|err| format!("failed to load onnx model {}: {err}", path.display()))
}

/// Get the warm session for `path`, building and caching it on first use. The
/// returned handle is shared: repeated calls for the same weight hand back the
/// same `Arc`, so the heavy weight parse happens once per process.
///
/// The weight file is read only on a cache miss, outside the pool lock, so a
/// slow first load of one model does not block sessions for others. A race that
/// builds the same session twice is resolved by keeping whichever landed first.
pub(super) fn cached_session(path: &Path) -> Result<SharedSession, String> {
    let key = cache_key(path);
    {
        let map = pool()
            .lock()
            .map_err(|_| "onnx session pool poisoned".to_string())?;
        if let Some(existing) = map.get(&key) {
            return Ok(existing.clone());
        }
    }

    let built: SharedSession = Arc::new(Mutex::new(build_session(path)?));
    let mut map = pool()
        .lock()
        .map_err(|_| "onnx session pool poisoned".to_string())?;
    // If another thread inserted while we were building, keep theirs so every
    // caller for this weight converges on a single shared session.
    Ok(map.entry(key).or_insert(built).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_resolution_honours_the_request_contract() {
        // cpu -> CPU only, no reason (an honoured choice, not a fallback);
        // cuda / directml / gpu / auto -> CPU with visible fallback reasons.
        let cpu = resolve_provider(OnnxDeviceRequest::Cpu);
        assert_eq!(cpu.device, "cpu");
        assert!(cpu.fallback_reason.is_none());

        let cuda = resolve_provider(OnnxDeviceRequest::Cuda);
        assert_eq!(cuda.device, "cpu");
        assert!(cuda.fallback_reason.as_deref().unwrap().contains("CUDA"));

        let directml = resolve_provider(OnnxDeviceRequest::DirectMl);
        assert_eq!(directml.device, "cpu");
        assert!(directml
            .fallback_reason
            .as_deref()
            .unwrap()
            .contains("DirectML"));

        let gpu = resolve_provider(OnnxDeviceRequest::Gpu);
        assert_eq!(gpu.device, "cpu");
        assert_eq!(OnnxDeviceRequest::from_param("gpu").as_str(), "gpu");
        assert!(gpu.fallback_reason.as_deref().unwrap().contains("DirectML"));

        let auto = resolve_provider(OnnxDeviceRequest::Auto);
        assert_eq!(auto.device, "cpu");
        assert!(auto.fallback_reason.is_some());
    }

    #[test]
    fn device_request_parses_the_param_vocabulary() {
        assert_eq!(OnnxDeviceRequest::from_param("cpu"), OnnxDeviceRequest::Cpu);
        assert_eq!(
            OnnxDeviceRequest::from_param("CUDA"),
            OnnxDeviceRequest::Cuda
        );
        assert_eq!(OnnxDeviceRequest::from_param("gpu"), OnnxDeviceRequest::Gpu);
        assert_eq!(
            OnnxDeviceRequest::from_param("directml"),
            OnnxDeviceRequest::DirectMl
        );
        assert_eq!(OnnxDeviceRequest::from_param(""), OnnxDeviceRequest::Auto);
        assert_eq!(
            OnnxDeviceRequest::from_param("anything"),
            OnnxDeviceRequest::Auto
        );
    }

    #[test]
    fn cache_key_of_missing_path_is_unchanged() {
        // A path that can't be canonicalised (does not exist) is used verbatim,
        // so resolution never panics and unresolved weights still key sanely.
        let missing = Path::new("Z:/definitely/missing-model.onnx");
        assert_eq!(cache_key(missing), missing.to_path_buf());
    }

    #[test]
    fn bundled_runtime_path_matches_the_tauri_resource_mapping() {
        assert_eq!(
            bundled_runtime_path(Path::new("C:/app/resources")),
            Path::new("C:/app/resources/runtime/onnxruntime/onnxruntime.dll")
        );
    }

    #[test]
    fn missing_runtime_is_reported_as_an_uninstalled_fallback() {
        let status = runtime_status_from(Err("runtime missing".to_string()));
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.providers.is_empty());
        assert_eq!(status.reason.as_deref(), Some("runtime missing"));
    }

    #[test]
    fn non_dll_files_are_rejected_before_the_windows_loader() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let error = validate_runtime_dll(&manifest).unwrap_err();
        assert!(error.contains("expected 14148680"));
    }
}
