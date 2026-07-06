//! Cross-card engine capability probe (the `doctor`-style report): which
//! `engine` values each card can run on this box. Split out of `psd.rs`;
//! command names and result shapes are unchanged. With the Python bridge
//! removed, only the always-on native CPU/rule baselines are reported.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Cached-weight inventory for one engine: the non-bundled weight it would load
/// and whether it is already present on this box. Lets the UI show what is
/// downloaded vs still missing instead of only "engine unavailable". A directory
/// weight (e.g. a diffusers snapshot) reports `present` with `size_mb` null.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct WeightInfo {
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) present: bool,
    #[serde(default)]
    pub(crate) size_mb: Option<u64>,
}

/// Availability of one `engine` option for a card, as reported by a CLI
/// `--probe-engines` call. `available=false` carries a human `reason` the UI
/// shows when greying the option out.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineAvailability {
    #[serde(default)]
    pub(crate) available: bool,
    #[serde(default)]
    pub(crate) reason: String,
    /// Whether this engine is GPU-capable (an ML backend). The UI pairs it with
    /// the machine [`DeviceProbe`] to warn it would fall back to CPU when no
    /// CUDA device is present; the CPU/`rules`/`provider` baseline is `false`.
    #[serde(default)]
    pub(crate) accelerated: bool,
    /// Cached-weight inventory for this engine (`None` for the CPU/`rules`/
    /// `provider` baseline, which loads no downloadable weight).
    #[serde(default)]
    pub(crate) weight: Option<WeightInfo>,
}

/// Engine capability probe for one card (node kind): which `engine` values its
/// CLI can actually run right now. `error` is set (engines empty) when the probe
/// itself could not run, so the UI degrades to "all enabled" rather than hiding
/// the always-available CPU path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CardEngineProbe {
    /// The node kind whose `engine` param these cover (e.g. `imageEnhance`).
    pub(crate) node_kind: String,
    /// The bridge CLI that produced the probe.
    pub(crate) cli: String,
    /// Engine id -> availability (e.g. `cpu`/`realesrgan`, `rules`/`onnx_defect`).
    pub(crate) engines: BTreeMap<String, EngineAvailability>,
    /// Why the probe could not run, when `engines` is empty.
    #[serde(default)]
    pub(crate) error: Option<String>,
}

/// One CUDA device reported by the machine device probe.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct DeviceInfo {
    #[serde(default)]
    pub(crate) index: u32,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) total_memory_mb: u64,
}

/// `torch` presence + CUDA flag from the device probe (filled when importable).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct TorchInfo {
    #[serde(default)]
    pub(crate) installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cuda: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

/// `onnxruntime` presence + the execution providers available on this box.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct OnnxRuntimeInfo {
    #[serde(default)]
    pub(crate) installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default)]
    pub(crate) providers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

/// Machine compute capability (which accelerator the opt-in GPU engines would
/// actually run on): CUDA device names / VRAM via `torch` and the ONNX Runtime
/// execution providers. The per-card probes only say *which* engines could run;
/// this says *where*, so the UI can warn that a GPU engine falls back to CPU on
/// a box with no CUDA device. Machine-global, so it is probed once.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct DeviceProbe {
    #[serde(default)]
    pub(crate) cuda_available: bool,
    #[serde(default)]
    pub(crate) devices: Vec<DeviceInfo>,
    #[serde(default)]
    pub(crate) torch: TorchInfo,
    #[serde(default)]
    pub(crate) onnxruntime: OnnxRuntimeInfo,
}

/// One compiled-in kernel backend's probe (wgpu grade kernel, vendored
/// FFmpeg): whether it is usable on this box, with the adapter/library detail
/// when it is and the reason when it is not (fallback stays visible,
/// GPU_DEVICE_STRATEGY_PLAN).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct BackendProbe {
    #[serde(default)]
    pub(crate) available: bool,
    /// Adapter/library summary when available, the reason when not.
    #[serde(default)]
    pub(crate) detail: String,
}

impl BackendProbe {
    fn from_capability(capability: Result<String, String>) -> Self {
        match capability {
            Ok(detail) => Self {
                available: true,
                detail,
            },
            Err(reason) => Self {
                available: false,
                detail: reason,
            },
        }
    }
}

/// Cross-card engine capability report (the `doctor`-style probe). Aggregates
/// every local card that exposes an opt-in ML `engine` seam so the UI can grey
/// out engines whose deps/weights are missing on this box.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineProbeReport {
    pub(crate) cards: Vec<CardEngineProbe>,
    /// The shared weight cache (`HGRIPE_MODEL_CACHE` or the bundled dir).
    #[serde(default)]
    pub(crate) model_cache_dir: Option<String>,
    /// Machine compute capability (CUDA devices / ONNX Runtime providers),
    /// probed once; `None` when the device probe itself could not run.
    #[serde(default)]
    pub(crate) runtime: Option<DeviceProbe>,
    /// Grade kernel wgpu adapter status (initialises the shared grader once;
    /// cached either way).
    #[serde(default)]
    pub(crate) wgpu: Option<BackendProbe>,
    /// Vendored FFmpeg decode status (software path; hardware joins later
    /// behind its own probe).
    #[serde(default)]
    pub(crate) ffmpeg: Option<BackendProbe>,
    /// Hardware video encoders compiled into the vendored libav (probe only —
    /// nothing selects them yet; a compiled-in encoder can still refuse a
    /// session at run time, so per-run reports stay the source of truth).
    #[serde(default)]
    pub(crate) ffmpeg_hw: Option<BackendProbe>,
    /// Detected display adapters across every compiled wgpu backend
    /// (diagnostics; the grade / viewport devices still pick their own
    /// adapter, and per-run reports remain the source of truth).
    #[serde(default)]
    pub(crate) display_adapters: Option<BackendProbe>,
}

/// Probe the `engine` seams across the local cards (the `doctor` cross-card
/// capability report). With the Python bridge removed, only the built-in
/// native Rust baselines exist: each card reports its always-available
/// CPU/rule engine and nothing else.
#[tauri::command]
pub(crate) fn probe_engines(dir: Option<String>) -> Result<EngineProbeReport, String> {
    let _ = dir;

    // (node kind, baseline engine id) for every card that exposes an `engine`
    // param. Every baseline runs in-process in Rust.
    const CARDS: [(&str, &str); 5] = [
        ("matchLightColor", "cpu"),
        ("imageEnhance", "cpu"),
        ("detailWatchdog", "rules"),
        ("detailRepaint", "provider"),
        ("refineMaskEdge", "cpu"),
    ];

    let cards = CARDS
        .iter()
        .map(|(node_kind, baseline)| {
            let mut engines = BTreeMap::new();
            engines.insert(
                baseline.to_string(),
                EngineAvailability {
                    available: true,
                    reason: "built-in native Rust path".to_string(),
                    accelerated: false,
                    weight: None,
                },
            );
            CardEngineProbe {
                node_kind: node_kind.to_string(),
                cli: String::new(),
                engines,
                error: None,
            }
        })
        .collect();

    Ok(EngineProbeReport {
        cards,
        model_cache_dir: super::load_model_paths_config().model_cache_dir,
        runtime: None,
        wgpu: Some(BackendProbe::from_capability(
            crate::studio::grade::wgpu_capability(),
        )),
        ffmpeg: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_capability(),
        )),
        ffmpeg_hw: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_hw_capability(),
        )),
        display_adapters: Some(BackendProbe::from_capability(
            crate::studio::wgpu_device::display_adapters(),
        )),
    })
}
