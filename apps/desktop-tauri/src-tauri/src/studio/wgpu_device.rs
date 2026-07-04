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
use std::sync::{Arc, OnceLock};

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
        Ok(gpu) => Ok(Arc::clone(gpu)),
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
