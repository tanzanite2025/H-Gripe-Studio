//! Process-wide shared wgpu device for viewport surface presentation
//! (WGPU_SURFACE_SWAP_PLAN Phase S0, feature `viewport-surface`).
//!
//! One lazy `Instance/Adapter/Device/Queue` serves every presented viewport
//! surface. Initialisation happens on the first request — never at app
//! startup (per the migration plan's performance rules) — and the outcome
//! (success with adapter summary, or a fallback reason) is cached and
//! reported through the shared device vocabulary so callers downgrade to the
//! PNG transport path instead of failing.

#[cfg(feature = "viewport-surface")]
use std::sync::{Arc, Mutex, OnceLock};

use crate::studio::device_report::DeviceUsed;

/// The shared GPU context surfaces render through. `Device`/`Queue` are
/// internally reference-counted and thread-safe; per-viewport surfaces are
/// created from this instance and configured against this device.
#[cfg(feature = "viewport-surface")]
#[allow(dead_code)] // consumed by the surface presentation path from Phase S1
pub(crate) struct SharedGpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Human-readable adapter description (name + backend) for device reports.
    pub adapter_summary: String,
}

/// How the shared surface device resolved: the report every surface path
/// carries, in the shared `DeviceReport` vocabulary. Fallback is a reportable
/// runtime decision, not a failure.
#[allow(dead_code)] // wired into the viewport backend report from Phase S1
pub(crate) struct SurfaceDeviceReport {
    pub used: DeviceUsed,
    /// Adapter name + backend when a device initialised.
    pub backend: Option<String>,
    pub fallback_reason: Option<String>,
}

#[cfg(feature = "viewport-surface")]
static SHARED: OnceLock<Result<Arc<SharedGpu>, String>> = OnceLock::new();

/// The device-lost reason, recorded by the callback registered at device
/// creation (GPU_DEVICE_STRATEGY_PLAN long-term step 4: structured
/// device-lost handling). Once set, every surface path sees the shared
/// device as unavailable with this reason and downgrades to the PNG
/// transport — reported, never silent.
#[cfg(feature = "viewport-surface")]
static DEVICE_LOST: Mutex<Option<String>> = Mutex::new(None);

/// The recorded device-lost reason, if the shared device has been lost.
#[cfg(feature = "viewport-surface")]
pub(crate) fn device_lost_reason() -> Option<String> {
    DEVICE_LOST.lock().ok().and_then(|guard| guard.clone())
}

/// The recorded detail line for a device loss: the structured reason class
/// plus the driver's message, so the fallback stays diagnosable.
#[cfg(feature = "viewport-surface")]
fn device_lost_detail(reason: wgpu::DeviceLostReason, message: &str) -> String {
    format!("wgpu device lost ({reason:?}): {message}")
}

#[cfg(feature = "viewport-surface")]
fn record_device_lost(reason: wgpu::DeviceLostReason, message: String) {
    let detail = device_lost_detail(reason, &message);
    eprintln!("[viewport] {detail} — surfaces downgrade to the PNG transport");
    if let Ok(mut guard) = DEVICE_LOST.lock() {
        guard.get_or_insert(detail);
    }
}

#[cfg(feature = "viewport-surface")]
fn init_shared_gpu() -> Result<Arc<SharedGpu>, String> {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|e| format!("no suitable GPU adapter: {e}"))?;
    let info = adapter.get_info();
    let adapter_summary = format!("{} ({:?})", info.name, info.backend);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("hgripe-viewport-surface"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .map_err(|e| format!("device request failed: {e}"))?;
    device.set_device_lost_callback(record_device_lost);
    eprintln!("[viewport] shared wgpu device initialised: {adapter_summary}");
    Ok(Arc::new(SharedGpu {
        instance,
        adapter,
        device,
        queue,
        adapter_summary,
    }))
}

/// The shared device, initialising it on first use. The result (including a
/// failed initialisation) is cached for the process lifetime: a machine
/// without an adapter reports the same fallback on every call instead of
/// re-probing.
#[cfg(feature = "viewport-surface")]
#[allow(dead_code)] // consumed by the surface presentation path from Phase S1
pub(crate) fn shared_gpu() -> Result<Arc<SharedGpu>, String> {
    match SHARED.get_or_init(|| {
        init_shared_gpu().inspect_err(|e| {
            eprintln!("[viewport] shared wgpu device unavailable, PNG fallback stays: {e}");
        })
    }) {
        Ok(gpu) => match device_lost_reason() {
            Some(reason) => Err(reason),
            None => Ok(Arc::clone(gpu)),
        },
        Err(e) => Err(e.clone()),
    }
}

/// Whether the shared device has already been initialised (successfully or
/// not) — the startup guard: this must stay `false` until a surface is
/// actually requested.
#[cfg(feature = "viewport-surface")]
#[allow(dead_code)] // asserted by tests; S1 checks it before surface creation
pub(crate) fn shared_gpu_initialised() -> bool {
    SHARED.get().is_some()
}

/// Enumerate every display adapter wgpu can see across the compiled backends,
/// for the capability summary (GPU_DEVICE_STRATEGY_PLAN step 5: "detected
/// display adapters"). Diagnostics only: a fresh throwaway instance per probe,
/// never the shared device, so probing cannot trigger or skew the lazy device
/// init. The same physical GPU may appear once per backend (e.g. Vulkan and
/// Dx12) — that is informative, not a bug.
#[cfg(feature = "viewport-surface")]
pub(crate) fn display_adapters() -> Result<String, String> {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    if adapters.is_empty() {
        return Err("no display adapters detected".to_string());
    }
    let names: Vec<String> = adapters
        .iter()
        .map(|adapter| {
            let info = adapter.get_info();
            format!("{} ({:?})", info.name, info.backend)
        })
        .collect();
    Ok(names.join(", "))
}

/// Feature-off build: wgpu is compiled out, so the probe reports why.
#[cfg(not(feature = "viewport-surface"))]
pub(crate) fn display_adapters() -> Result<String, String> {
    Err("viewport-surface feature disabled (wgpu not compiled in)".to_string())
}

/// One enumerated display adapter with its key limits, for the central
/// device registry (GPU_DEVICE_STRATEGY_PLAN step 13). Limits come from
/// `Adapter::limits()` — no device is created, so enumeration cannot trigger
/// or skew the lazy shared-device init.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct AdapterRecord {
    pub name: String,
    pub backend: String,
    pub max_texture_dimension_2d: u32,
    pub max_buffer_size: u64,
}

/// Enumerate display adapters with their limits for the device registry.
/// Diagnostics only: a fresh throwaway instance per call, never the shared
/// device. wgpu exposes no GPU memory size, so limits are the closest
/// capacity hint the registry can record.
#[cfg(feature = "viewport-surface")]
pub(crate) fn adapter_records() -> Result<Vec<AdapterRecord>, String> {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    if adapters.is_empty() {
        return Err("no display adapters detected".to_string());
    }
    Ok(adapters
        .iter()
        .map(|adapter| {
            let info = adapter.get_info();
            let limits = adapter.limits();
            AdapterRecord {
                name: info.name.clone(),
                backend: format!("{:?}", info.backend),
                max_texture_dimension_2d: limits.max_texture_dimension_2d,
                max_buffer_size: limits.max_buffer_size,
            }
        })
        .collect())
}

/// Feature-off build: wgpu is compiled out, so the registry records why.
#[cfg(not(feature = "viewport-surface"))]
pub(crate) fn adapter_records() -> Result<Vec<AdapterRecord>, String> {
    Err("viewport-surface feature disabled (wgpu not compiled in)".to_string())
}

/// The shared surface device's status for the device registry, *without*
/// forcing initialisation: the device must keep initialising only when a
/// surface is actually presented (the startup guard), so a registry snapshot
/// on a fresh process honestly reports "not initialised yet".
pub(crate) fn surface_device_status() -> Result<String, String> {
    #[cfg(feature = "viewport-surface")]
    {
        match SHARED.get() {
            Some(Ok(gpu)) => match device_lost_reason() {
                Some(reason) => Err(format!("{} — {}", gpu.adapter_summary, reason)),
                None => Ok(gpu.adapter_summary.clone()),
            },
            Some(Err(reason)) => Err(reason.clone()),
            None => {
                Err("not initialised yet (initialises on the first presented viewport)".to_string())
            }
        }
    }
    #[cfg(not(feature = "viewport-surface"))]
    {
        Err("viewport-surface feature disabled".to_string())
    }
}

/// Resolve the surface device report, initialising the device if needed.
#[cfg(feature = "viewport-surface")]
#[allow(dead_code)] // wired into the viewport backend report from Phase S1
pub(crate) fn surface_device_report() -> SurfaceDeviceReport {
    match shared_gpu() {
        Ok(gpu) => SurfaceDeviceReport {
            used: DeviceUsed::Wgpu,
            backend: Some(gpu.adapter_summary.clone()),
            fallback_reason: None,
        },
        Err(e) => SurfaceDeviceReport {
            used: DeviceUsed::Cpu,
            backend: None,
            fallback_reason: Some(e),
        },
    }
}

/// Feature-off build: the surface path is compiled out and every report is
/// the honest fallback.
#[cfg(not(feature = "viewport-surface"))]
#[allow(dead_code)] // wired into the viewport backend report from Phase S1
pub(crate) fn surface_device_report() -> SurfaceDeviceReport {
    SurfaceDeviceReport {
        used: DeviceUsed::Cpu,
        backend: None,
        fallback_reason: Some("viewport-surface feature disabled".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_vocabulary_is_shared() {
        // Whatever the machine, the report must resolve to the shared
        // vocabulary: wgpu with an adapter summary, or cpu with a reason.
        let report = surface_device_report();
        match report.used {
            DeviceUsed::Wgpu => {
                assert!(report.backend.is_some());
                assert!(report.fallback_reason.is_none());
            }
            DeviceUsed::Cpu => {
                assert!(report.backend.is_none());
                assert!(report.fallback_reason.is_some());
            }
            other => panic!("unexpected device: {}", other.as_str()),
        }
    }

    #[test]
    fn display_adapter_probe_is_never_silent() {
        // Ok carries at least one adapter description; Err carries a reason.
        match display_adapters() {
            Ok(detail) => assert!(!detail.is_empty()),
            Err(reason) => assert!(!reason.is_empty()),
        }
    }

    #[cfg(feature = "viewport-surface")]
    #[test]
    fn device_lost_detail_keeps_reason_class_and_message() {
        let detail = device_lost_detail(wgpu::DeviceLostReason::Unknown, "D3D12 device removed");
        assert!(detail.contains("Unknown"), "{detail}");
        assert!(detail.contains("D3D12 device removed"), "{detail}");
    }

    #[cfg(feature = "viewport-surface")]
    #[test]
    fn failed_init_is_cached() {
        // Two calls must agree — the OnceLock caches the outcome either way.
        let a = shared_gpu().map(|g| g.adapter_summary.clone());
        let b = shared_gpu().map(|g| g.adapter_summary.clone());
        assert_eq!(a.is_ok(), b.is_ok());
        assert!(shared_gpu_initialised());
    }
}
