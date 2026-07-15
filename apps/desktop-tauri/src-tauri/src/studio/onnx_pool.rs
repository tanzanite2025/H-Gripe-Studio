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
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ort::session::Session;

use super::device_report::DeviceUsed;

const ONNX_RUNTIME_DLL: &str = "onnxruntime.dll";
const ONNX_RUNTIME_VERSION: &str = "1.24.2";
const ONNX_RUNTIME_DLL_BYTES: u64 = 14_148_680;
const ONNX_RUNTIME_FLAVOR: &str = "windows-x64-cpu";

/// Tauri's packaged resource root, captured during setup without loading ORT.
static RUNTIME_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Loading a native library is process-global. Cache both success and failure
/// so a missing/corrupt DLL becomes a stable fallback reason instead of an
/// `ort` lazy-loader panic.
static RUNTIME_INIT: OnceLock<Result<(), String>> = OnceLock::new();
/// Cross-model accelerator gate. It is dormant for the current CPU runtime;
/// future CUDA/DirectML session construction and inference acquire it, so
/// direct commands and hidden editor paths cannot bypass graph scheduling.
static ONNX_ACCELERATOR_GATE: Mutex<()> = Mutex::new(());

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn accelerator_permit_from<'a>(
    gate: &'a Mutex<()>,
    resolution: &OnnxProviderResolution,
) -> Option<MutexGuard<'a, ()>> {
    resolution.accelerated().then(|| lock_unpoisoned(gate))
}

fn accelerator_permit(resolution: &OnnxProviderResolution) -> Option<MutexGuard<'static, ()>> {
    accelerator_permit_from(&ONNX_ACCELERATOR_GATE, resolution)
}

#[derive(Debug, Clone)]
pub(crate) struct OnnxRuntimeStatus {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
    pub(crate) runtime_flavor: &'static str,
    pub(crate) packaged_providers: Vec<&'static str>,
    /// Providers usable for session construction after the runtime loaded.
    /// Empty when the DLL failed validation/loading.
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
            runtime_flavor: ONNX_RUNTIME_FLAVOR,
            packaged_providers: packaged_providers(),
            providers: packaged_providers(),
            reason: None,
        },
        Err(reason) => OnnxRuntimeStatus {
            installed: false,
            version: None,
            runtime_flavor: ONNX_RUNTIME_FLAVOR,
            packaged_providers: packaged_providers(),
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum OnnxRuntimeFlavor {
    WindowsCpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(dead_code)]
enum OnnxProviderKind {
    Cpu,
    Cuda,
    DirectMl,
}

#[derive(Debug, Clone)]
pub(crate) struct OnnxProviderResolution {
    runtime: OnnxRuntimeFlavor,
    provider: OnnxProviderKind,
    device_id: u32,
    /// The provider inference actually runs on (`used` in DeviceReport terms).
    pub(crate) device: &'static str,
    /// Why the request did not accelerate; `None` only for an explicit `cpu`
    /// request, which is honoured rather than fallen back to.
    pub(crate) fallback_reason: Option<String>,
}

impl OnnxProviderResolution {
    pub(crate) fn accelerated(&self) -> bool {
        self.provider != OnnxProviderKind::Cpu
    }
}

fn cpu_resolution(fallback_reason: Option<String>) -> OnnxProviderResolution {
    OnnxProviderResolution {
        runtime: OnnxRuntimeFlavor::WindowsCpu,
        provider: OnnxProviderKind::Cpu,
        device_id: 0,
        device: DeviceUsed::Cpu.as_str(),
        fallback_reason,
    }
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
        OnnxDeviceRequest::Cpu => cpu_resolution(None),
        OnnxDeviceRequest::Cuda => cpu_resolution(Some(
                "CUDA execution provider not built in (onnxruntime compiled with CPU provider only)"
                    .to_string(),
            )),
        OnnxDeviceRequest::DirectMl => cpu_resolution(Some(
                "DirectML execution provider not built in (onnxruntime compiled with CPU provider only)"
                    .to_string(),
            )),
        OnnxDeviceRequest::Gpu => cpu_resolution(Some(
                "GPU execution provider not built in (CUDA/DirectML are not packaged; onnxruntime uses CPU)"
                    .to_string(),
            )),
        OnnxDeviceRequest::Auto => cpu_resolution(Some(
                "onnxruntime CPU execution provider (no CUDA/DirectML provider built in)"
                    .to_string(),
            )),
    }
}

/// The execution providers packaged into the selected runtime flavor. CPU only
/// today; accelerated providers (CUDA / DirectML) join this list when the
/// runtime ships them, keeping [`resolve_provider`]'s request semantics.
/// Do not add a provider here as telemetry-only work: provider resolution must
/// first drive `SessionBuilder`, and the resolved provider/runtime flavor must
/// become part of the warm-pool key so CPU and accelerated sessions never alias.
pub(crate) fn packaged_providers() -> Vec<&'static str> {
    vec![DeviceUsed::Cpu.as_str()]
}

/// A warm ONNX session shared across runs. `Mutex` because `Session::run` needs
/// `&mut self`; `Arc` so the pool and every in-flight segmenter share one copy.
#[derive(Clone)]
pub(super) struct SharedSession {
    inner: Arc<Mutex<Session>>,
    resolution: OnnxProviderResolution,
}

pub(super) struct SharedSessionGuard<'a> {
    _gpu_permit: Option<MutexGuard<'static, ()>>,
    session: MutexGuard<'a, Session>,
}

impl Deref for SharedSessionGuard<'_> {
    type Target = Session;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl DerefMut for SharedSessionGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.session
    }
}

impl SharedSession {
    pub(super) fn lock(&self) -> Result<SharedSessionGuard<'_>, String> {
        // The gate carries no mutable state, so a panic in one model must not
        // permanently disable every other accelerated model in the process.
        let gpu_permit = accelerator_permit(&self.resolution);
        let session = self
            .inner
            .lock()
            .map_err(|_| "ONNX session lock poisoned".to_string())?;
        Ok(SharedSessionGuard {
            _gpu_permit: gpu_permit,
            session,
        })
    }

    pub(super) fn resolution(&self) -> &OnnxProviderResolution {
        &self.resolution
    }

    #[cfg(test)]
    pub(super) fn shares_session_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionCacheKey {
    model_path: PathBuf,
    runtime: OnnxRuntimeFlavor,
    provider: OnnxProviderKind,
    device_id: u32,
}

/// Model/runtime/provider/device -> warm session. Canonicalising the model path
/// collapses relative spellings without letting CPU and accelerated sessions
/// alias each other. Each key owns a separate initialization cell, so the first
/// load is single-flight without holding the pool map lock. CPU keys may build
/// in parallel; accelerated builds also obey the global accelerator gate.
type BuildResult<T> = Result<Arc<T>, String>;
type BuildCell<T> = Arc<OnceLock<BuildResult<T>>>;
type BuildCache<K, T> = Mutex<HashMap<K, BuildCell<T>>>;
type SessionPool = BuildCache<SessionCacheKey, Mutex<Session>>;

static POOL: OnceLock<SessionPool> = OnceLock::new();

fn pool() -> &'static SessionPool {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn initialize_once<T, F>(
    cell: &OnceLock<Result<Arc<T>, String>>,
    build: F,
) -> Result<Arc<T>, String>
where
    F: FnOnce() -> Result<T, String>,
{
    cell.get_or_init(|| build().map(Arc::new)).clone()
}

fn remove_cell_if_current<K, T>(
    cache: &BuildCache<K, T>,
    key: &K,
    cell: &BuildCell<T>,
) -> Result<(), String>
where
    K: Eq + std::hash::Hash,
{
    let mut map = cache
        .lock()
        .map_err(|_| "onnx session pool poisoned".to_string())?;
    if map
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, cell))
    {
        map.remove(key);
    }
    Ok(())
}

fn cached_value<K, T, F>(cache: &BuildCache<K, T>, key: K, build: F) -> Result<Arc<T>, String>
where
    K: Clone + Eq + std::hash::Hash,
    F: FnOnce() -> Result<T, String>,
{
    let cell = {
        let mut map = cache
            .lock()
            .map_err(|_| "onnx session pool poisoned".to_string())?;
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(OnceLock::new()))
            .clone()
    };

    let built = initialize_once(&cell, build);
    if built.is_err() {
        // A repaired/replaced model may succeed on a later request. Remove only
        // this failed cell; a concurrent retry may already have installed a new
        // cell for the same key.
        remove_cell_if_current(cache, &key, &cell)?;
    }
    built
}

/// The cache key for a weight path: its canonical form when resolvable (so
/// distinct spellings of the same file collapse), otherwise the path as given.
fn canonical_model_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn session_cache_key(path: &Path, resolution: &OnnxProviderResolution) -> SessionCacheKey {
    SessionCacheKey {
        model_path: canonical_model_path(path),
        runtime: resolution.runtime,
        provider: resolution.provider,
        device_id: resolution.device_id,
    }
}

/// Build an `ort::Session` from an ONNX weight file on disk. Kept private so the
/// only way to obtain a session is through the warm pool.
fn build_session(path: &Path, resolution: &OnnxProviderResolution) -> Result<Session, String> {
    // Accelerated session construction can parse large graphs and allocate
    // device memory, so it belongs under the same process-wide gate as runs.
    let _accelerator_permit = accelerator_permit(resolution);
    if resolution.runtime != OnnxRuntimeFlavor::WindowsCpu
        || resolution.provider != OnnxProviderKind::Cpu
    {
        return Err(format!(
            "ONNX provider {} is not available in the current Windows CPU runtime",
            resolution.device
        ));
    }
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
/// slow CPU load does not hold up unrelated keys through the map mutex.
/// Concurrent callers for one key share its initialization cell and build
/// exactly once; accelerated builds intentionally share the global device gate.
pub(super) fn cached_session(
    path: &Path,
    request: OnnxDeviceRequest,
) -> Result<SharedSession, String> {
    let resolution = resolve_provider(request);
    cached_session_for_resolution(path, &resolution)
}

fn cached_session_for_resolution(
    path: &Path,
    resolution: &OnnxProviderResolution,
) -> Result<SharedSession, String> {
    let key = session_cache_key(path, resolution);
    let inner = cached_value(pool(), key, || {
        build_session(path, resolution).map(Mutex::new)
    })?;
    Ok(SharedSession {
        inner,
        resolution: resolution.clone(),
    })
}

/// Resolve one provider plan for a related model group, then build every warm
/// session with that exact plan. SAM2 uses this so its encoder and decoder can
/// never silently bind different providers.
pub(super) fn cached_session_group(
    paths: &[&Path],
    request: OnnxDeviceRequest,
) -> Result<Vec<SharedSession>, String> {
    let resolution = resolve_provider(request);
    paths
        .iter()
        .map(|path| cached_session_for_resolution(path, &resolution))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::thread;

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
    fn canonical_model_path_of_missing_path_is_unchanged() {
        // A path that can't be canonicalised (does not exist) is used verbatim,
        // so resolution never panics and unresolved weights still key sanely.
        let missing = Path::new("Z:/definitely/missing-model.onnx");
        assert_eq!(canonical_model_path(missing), missing.to_path_buf());
    }

    #[test]
    fn session_key_uses_actual_provider_not_request_spelling() {
        let path = Path::new("Z:/models/example.onnx");
        let cpu = resolve_provider(OnnxDeviceRequest::Cpu);
        let auto = resolve_provider(OnnxDeviceRequest::Auto);
        let cpu_key = session_cache_key(path, &cpu);
        let auto_key = session_cache_key(path, &auto);
        assert_eq!(cpu_key, auto_key);

        let cuda = OnnxProviderResolution {
            runtime: OnnxRuntimeFlavor::WindowsCpu,
            provider: OnnxProviderKind::Cuda,
            device_id: 0,
            device: "cuda",
            fallback_reason: None,
        };
        let cuda_key = session_cache_key(path, &cuda);
        assert_ne!(cpu_key, cuda_key);

        let cuda_1 = OnnxProviderResolution {
            device_id: 1,
            ..cuda.clone()
        };
        assert_ne!(cuda_key, session_cache_key(path, &cuda_1));

        let directml = OnnxProviderResolution {
            provider: OnnxProviderKind::DirectMl,
            device: "directml",
            ..cuda
        };
        assert_ne!(cpu_key, session_cache_key(path, &directml));
    }

    #[test]
    fn cpu_runtime_refuses_an_accelerated_session_plan() {
        let cuda = OnnxProviderResolution {
            runtime: OnnxRuntimeFlavor::WindowsCpu,
            provider: OnnxProviderKind::Cuda,
            device_id: 0,
            device: "cuda",
            fallback_reason: None,
        };
        let error = build_session(Path::new("Z:/missing/model.onnx"), &cuda).unwrap_err();
        assert!(error.contains("not available in the current Windows CPU runtime"));
    }

    #[test]
    fn pool_initialization_is_single_flight_per_key() {
        const THREADS: usize = 8;
        let cache = Arc::new(Mutex::new(HashMap::new()));
        let starts = Arc::new(Barrier::new(THREADS));
        let builds = Arc::new(AtomicUsize::new(0));
        let handles = (0..THREADS)
            .map(|_| {
                let cache = cache.clone();
                let starts = starts.clone();
                let builds = builds.clone();
                thread::spawn(move || {
                    starts.wait();
                    cached_value(&cache, 7_u32, || {
                        builds.fetch_add(1, Ordering::SeqCst);
                        for _ in 0..1_000 {
                            thread::yield_now();
                        }
                        Ok::<_, String>(42_u32)
                    })
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();

        let values = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        assert!(values
            .iter()
            .skip(1)
            .all(|value| Arc::ptr_eq(&values[0], value)));
    }

    #[test]
    fn pool_does_not_hold_the_map_lock_while_different_keys_build() {
        let cache = Arc::new(Mutex::new(HashMap::new()));
        let builders_entered = Arc::new(Barrier::new(2));
        let handles = (0..2_u32)
            .map(|key| {
                let cache = cache.clone();
                let builders_entered = builders_entered.clone();
                thread::spawn(move || {
                    cached_value(&cache, key, || {
                        builders_entered.wait();
                        Ok::<_, String>(key)
                    })
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();

        for (expected, handle) in handles.into_iter().enumerate() {
            assert_eq!(*handle.join().unwrap(), expected as u32);
        }
    }

    #[test]
    fn stateless_gate_lock_recovers_after_poison() {
        let gate = Arc::new(Mutex::new(()));
        let poisoned = gate.clone();
        let _ = thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("poison the test gate");
        })
        .join();

        let accelerated = OnnxProviderResolution {
            runtime: OnnxRuntimeFlavor::WindowsCpu,
            provider: OnnxProviderKind::Cuda,
            device_id: 0,
            device: "cuda",
            fallback_reason: None,
        };
        drop(accelerator_permit_from(&gate, &accelerated));
    }

    #[test]
    fn failed_pool_build_is_removed_and_can_retry() {
        let cache = Mutex::new(HashMap::new());
        assert_eq!(
            cached_value(&cache, 9_u32, || Err::<u32, _>(
                "first build failed".to_string()
            )),
            Err("first build failed".to_string())
        );
        assert!(!cache.lock().unwrap().contains_key(&9));

        let rebuilt = cached_value(&cache, 9_u32, || Ok(84_u32)).unwrap();
        assert_eq!(*rebuilt, 84);
        assert!(cache.lock().unwrap().contains_key(&9));
    }

    #[test]
    fn stale_failure_cleanup_does_not_remove_a_new_cell() {
        let cache = Mutex::new(HashMap::new());
        let stale = Arc::new(OnceLock::<Result<Arc<u32>, String>>::new());
        let current = Arc::new(OnceLock::<Result<Arc<u32>, String>>::new());
        cache.lock().unwrap().insert(5_u32, current.clone());

        remove_cell_if_current(&cache, &5, &stale).unwrap();

        let map = cache.lock().unwrap();
        assert!(map.get(&5).is_some_and(|cell| Arc::ptr_eq(cell, &current)));
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
        assert_eq!(status.runtime_flavor, "windows-x64-cpu");
        assert_eq!(status.packaged_providers, ["cpu"]);
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
