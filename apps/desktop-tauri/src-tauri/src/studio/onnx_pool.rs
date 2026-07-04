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

/// Requested execution device for ONNX inference — the `requested` half of
/// the shared DeviceReport vocabulary (GPU_DEVICE_STRATEGY_PLAN). Parsed from
/// the node's `device` param; anything unrecognised reads as `Auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnnxDeviceRequest {
    Auto,
    Cpu,
    Cuda,
}

impl OnnxDeviceRequest {
    pub(crate) fn from_param(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "cpu" => Self::Cpu,
            "cuda" | "gpu" => Self::Cuda,
            _ => Self::Auto,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
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
/// choice (no reason), while `cuda` and `auto` fall back with distinct,
/// visible reasons. When accelerated providers are compiled in they slot in
/// here, preserving the request semantics:
/// `cpu` -> CPU only; `cuda` -> CUDA else CPU + reason; `auto` -> preferred
/// accelerator else CPU + reason.
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
        OnnxDeviceRequest::Auto => OnnxProviderResolution {
            device: DeviceUsed::Cpu.as_str(),
            fallback_reason: Some(
                "onnxruntime CPU execution provider (no CUDA/DirectML provider built in)"
                    .to_string(),
            ),
        },
    }
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
        // cuda / auto -> CPU with a visible, distinct fallback reason.
        let cpu = resolve_provider(OnnxDeviceRequest::Cpu);
        assert_eq!(cpu.device, "cpu");
        assert!(cpu.fallback_reason.is_none());

        let cuda = resolve_provider(OnnxDeviceRequest::Cuda);
        assert_eq!(cuda.device, "cpu");
        assert!(cuda.fallback_reason.as_deref().unwrap().contains("CUDA"));

        let auto = resolve_provider(OnnxDeviceRequest::Auto);
        assert_eq!(auto.device, "cpu");
        assert!(auto.fallback_reason.is_some());
    }

    #[test]
    fn device_request_parses_the_param_vocabulary() {
        assert_eq!(OnnxDeviceRequest::from_param("cpu"), OnnxDeviceRequest::Cpu);
        assert_eq!(OnnxDeviceRequest::from_param("CUDA"), OnnxDeviceRequest::Cuda);
        assert_eq!(OnnxDeviceRequest::from_param("gpu"), OnnxDeviceRequest::Cuda);
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
}
