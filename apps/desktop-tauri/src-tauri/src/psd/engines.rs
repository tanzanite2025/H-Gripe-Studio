//! Cross-card engine capability probe (the `doctor`-style report): which
//! `engine` values each card can run on this box. Split out of `psd.rs`;
//! command names and result shapes are unchanged. Native learned engines are
//! reported alongside the always-on CPU/rule baselines when their weights are
//! available.

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

/// Availability of one `engine` option for a card, as reported by the native
/// `probe_engines` command. Lazy model backends may report their prerequisites
/// as available while deferring session validation to first use; `reason`
/// states that boundary and per-run telemetry remains authoritative.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineAvailability {
    #[serde(default)]
    pub(crate) available: bool,
    #[serde(default)]
    pub(crate) reason: String,
    /// Whether this engine can use an accelerated provider in this build. The
    /// UI pairs it with the machine [`DeviceProbe`] to report where it can run;
    /// CPU-only learned engines and CPU/`rules`/`provider` baselines are false.
    #[serde(default)]
    pub(crate) accelerated: bool,
    /// Cached-weight inventory for this engine (`None` for the CPU/`rules`/
    /// `provider` baseline, which loads no downloadable weight).
    #[serde(default)]
    pub(crate) weight: Option<WeightInfo>,
}

/// Engine capability probe for one card (node kind): which `engine` values the
/// native backend can run right now. `error` is set (engines empty) when the probe
/// itself could not run, so the UI degrades to "all enabled" rather than hiding
/// the always-available CPU path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CardEngineProbe {
    /// The node kind whose `engine` param these cover (e.g. `imageEnhance`).
    pub(crate) node_kind: String,
    /// Engine id -> availability (e.g. `cpu`/`realesrgan`, `rules`/`onnx_defect`).
    pub(crate) engines: BTreeMap<String, EngineAvailability>,
    /// Why the probe could not run, when `engines` is empty.
    #[serde(default)]
    pub(crate) error: Option<String>,
}

/// Selected `onnxruntime` flavor and provider readiness on this box.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct OnnxRuntimeInfo {
    #[serde(default)]
    pub(crate) installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default)]
    pub(crate) runtime_flavor: String,
    /// Providers whose binaries belong to the selected runtime payload.
    #[serde(default)]
    pub(crate) packaged_providers: Vec<String>,
    /// Providers usable for session construction after the runtime loaded.
    #[serde(default)]
    pub(crate) providers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

/// Machine ONNX capability. Per-card probes say which engines have weights;
/// this records the selected runtime payload and loadable session providers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct DeviceProbe {
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
    /// Machine ONNX runtime/provider capability, probed once.
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
    /// Hardware video decoders compiled into the vendored libav (probe only —
    /// playback stays on the software baseline; hardware decode joins per
    /// operation behind explicit probe/report/fallback).
    #[serde(default)]
    pub(crate) ffmpeg_hw_decode: Option<BackendProbe>,
    /// Detected display adapters across every compiled wgpu backend
    /// (diagnostics; the grade / viewport devices still pick their own
    /// adapter, and per-run reports remain the source of truth).
    #[serde(default)]
    pub(crate) display_adapters: Option<BackendProbe>,
}

/// Probe the `engine` seams across the local cards (the `doctor` cross-card
/// capability report). Baselines are always available; native learned engines
/// additionally report whether their managed weight resolves on this machine.
#[tauri::command]
pub(crate) fn probe_engines(dir: Option<String>) -> Result<EngineProbeReport, String> {
    let _ = dir;
    let onnx_status = crate::studio::onnx_runtime_status();

    // (node kind, baseline engine id) for every card that exposes an `engine`
    // param. Every baseline runs in-process in Rust.
    const CARDS: [(&str, &str); 5] = [
        ("matchLightColor", "cpu"),
        ("imageEnhance", "cpu"),
        ("detailWatchdog", "rules"),
        ("detailRepaint", "provider"),
        ("refineMaskEdge", "cpu"),
    ];

    let mut cards: Vec<CardEngineProbe> = CARDS
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
                engines,
                error: None,
            }
        })
        .collect();

    if let Some(card) = cards
        .iter_mut()
        .find(|card| card.node_kind == "matchLightColor")
    {
        let model = crate::studio::resolve_color_model_path();
        let weight = model.as_ref().map(|path| {
            let size_mb = std::fs::metadata(path)
                .ok()
                .map(|meta| meta.len().div_ceil(1024 * 1024));
            WeightInfo {
                path: path.to_string_lossy().to_string(),
                present: true,
                size_mb,
            }
        });
        card.engines.insert(
            "onnx_harmonize".to_string(),
            EngineAvailability {
                available: model.is_some() && onnx_status.installed,
                reason: if model.is_none() {
                    "PCT-Net weight not found; configure onnx_harmonize or install color_harmonize.onnx"
                        .to_string()
                } else if let Some(reason) = &onnx_status.reason {
                    format!("PCT-Net weight resolved, but ONNX Runtime is unavailable: {reason}")
                } else {
                    "native PCT-Net weight resolved; current ORT build uses CPU and validates the session on first use"
                        .to_string()
                },
                accelerated: false,
                weight: weight.or_else(|| {
                    Some(WeightInfo {
                        path: "color_harmonize.onnx".to_string(),
                        present: false,
                        size_mb: None,
                    })
                }),
            },
        );
    }

    if let Some(card) = cards
        .iter_mut()
        .find(|card| card.node_kind == "refineMaskEdge")
    {
        let model = crate::studio::resolve_vitmatte_model_path();
        let weight = model.as_ref().map(|path| {
            let size_mb = std::fs::metadata(path)
                .ok()
                .map(|meta| meta.len().div_ceil(1024 * 1024));
            WeightInfo {
                path: path.to_string_lossy().to_string(),
                present: true,
                size_mb,
            }
        });
        card.engines.insert(
            "onnx_matting".to_string(),
            EngineAvailability {
                available: model.is_some() && onnx_status.installed,
                reason: if model.is_none() {
                    "ViTMatte weight not found; configure onnx_matting or install vitmatte.onnx"
                        .to_string()
                } else if let Some(reason) = &onnx_status.reason {
                    format!("ViTMatte weight resolved, but ONNX Runtime is unavailable: {reason}")
                } else {
                    "native ViTMatte weight resolved; current ORT build uses CPU and validates the session on first use"
                        .to_string()
                },
                accelerated: false,
                weight: weight.or_else(|| {
                    Some(WeightInfo {
                        path: "vitmatte.onnx".to_string(),
                        present: false,
                        size_mb: None,
                    })
                }),
            },
        );
    }

    if let Some(card) = cards
        .iter_mut()
        .find(|card| card.node_kind == "detailWatchdog")
    {
        let model = crate::studio::resolve_watchdog_model_path();
        let weight = model.as_ref().map(|path| {
            let size_mb = std::fs::metadata(path)
                .ok()
                .map(|meta| meta.len().div_ceil(1024 * 1024));
            WeightInfo {
                path: path.to_string_lossy().to_string(),
                present: true,
                size_mb,
            }
        });
        card.engines.insert(
            "onnx_defect".to_string(),
            EngineAvailability {
                available: model.is_some() && onnx_status.installed,
                reason: if model.is_none() {
                    "Detail Watchdog weight not found; configure onnx_defect or install watchdog_defect.onnx"
                        .to_string()
                } else if let Some(reason) = &onnx_status.reason {
                    format!(
                        "Detail Watchdog weight resolved, but ONNX Runtime is unavailable: {reason}"
                    )
                } else {
                    "native Detail Watchdog weight resolved; current ORT build uses CPU and validates the session on first use"
                        .to_string()
                },
                accelerated: false,
                weight: weight.or_else(|| {
                    Some(WeightInfo {
                        path: "watchdog_defect.onnx".to_string(),
                        present: false,
                        size_mb: None,
                    })
                }),
            },
        );
    }

    Ok(EngineProbeReport {
        cards,
        model_cache_dir: super::load_model_paths_config().model_cache_dir,
        runtime: Some(DeviceProbe {
            onnxruntime: OnnxRuntimeInfo {
                installed: onnx_status.installed,
                version: onnx_status.version.clone(),
                runtime_flavor: onnx_status.runtime_flavor.to_string(),
                packaged_providers: onnx_status
                    .packaged_providers
                    .iter()
                    .copied()
                    .map(str::to_string)
                    .collect(),
                providers: onnx_status
                    .providers
                    .iter()
                    .copied()
                    .map(str::to_string)
                    .collect(),
                reason: onnx_status.reason.clone(),
            },
        }),
        wgpu: Some(BackendProbe::from_capability(
            crate::studio::grade::wgpu_capability(),
        )),
        ffmpeg: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_capability(),
        )),
        ffmpeg_hw: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_hw_capability(),
        )),
        ffmpeg_hw_decode: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_hw_decode_capability(),
        )),
        display_adapters: Some(BackendProbe::from_capability(
            crate::studio::wgpu_device::display_adapters(),
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_native_onnx_engines_and_ort_runtime() {
        let report = probe_engines(None).unwrap();
        let color = report
            .cards
            .iter()
            .find(|card| card.node_kind == "matchLightColor")
            .unwrap();
        assert!(color.engines["cpu"].available);
        let harmonizer = &color.engines["onnx_harmonize"];
        let runtime = report.runtime.as_ref().unwrap();
        assert_eq!(runtime.onnxruntime.runtime_flavor, "windows-x64-cpu");
        assert_eq!(runtime.onnxruntime.packaged_providers, ["cpu"]);
        assert!(!harmonizer.accelerated);
        assert_eq!(
            harmonizer.available,
            crate::studio::resolve_color_model_path().is_some() && runtime.onnxruntime.installed
        );
        assert_eq!(
            harmonizer.weight.as_ref().unwrap().present,
            crate::studio::resolve_color_model_path().is_some()
        );

        let refine = report
            .cards
            .iter()
            .find(|card| card.node_kind == "refineMaskEdge")
            .unwrap();
        assert!(refine.engines["cpu"].available);
        let learned = &refine.engines["onnx_matting"];
        assert!(!learned.accelerated);
        assert_eq!(
            learned.available,
            crate::studio::resolve_vitmatte_model_path().is_some() && runtime.onnxruntime.installed
        );
        assert_eq!(
            learned.weight.as_ref().unwrap().present,
            crate::studio::resolve_vitmatte_model_path().is_some()
        );

        let watchdog = report
            .cards
            .iter()
            .find(|card| card.node_kind == "detailWatchdog")
            .unwrap();
        assert!(watchdog.engines["rules"].available);
        let detector = &watchdog.engines["onnx_defect"];
        assert!(!detector.accelerated);
        assert_eq!(
            detector.available,
            crate::studio::resolve_watchdog_model_path().is_some() && runtime.onnxruntime.installed
        );
        assert_eq!(
            detector.weight.as_ref().unwrap().present,
            crate::studio::resolve_watchdog_model_path().is_some()
        );

        if runtime.onnxruntime.installed {
            assert!(runtime.onnxruntime.providers.iter().any(|p| p == "cpu"));
            assert!(runtime.onnxruntime.reason.is_none());
        } else {
            assert!(runtime.onnxruntime.providers.is_empty());
            assert!(runtime.onnxruntime.reason.is_some());
        }
    }
}
