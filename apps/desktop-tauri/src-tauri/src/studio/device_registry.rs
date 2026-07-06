//! Central device registry (GPU_DEVICE_STRATEGY_PLAN step 13, long-term
//! step 1): one Rust-side snapshot recording what compute capability this
//! box has — display adapters with their wgpu limits, the compiled-in
//! kernel backends (grade wgpu, viewport surface device, vendored FFmpeg),
//! the FFmpeg hardware encoder/decoder names, and the onnxruntime execution
//! providers.
//!
//! The registry is a shared source of diagnostic truth, not a scheduler: it
//! does not force kernels onto one API and it never overrides per-run
//! `DeviceReport`s, which stay the source of truth for what actually ran.
//! Assembling a snapshot is side-effect free with one deliberate exception:
//! probing the grade kernel initialises the process-wide grader once
//! (cached either way, same as the capability summary); the viewport
//! surface device is *never* initialised by a snapshot (`surface_device_status`
//! reads the cached state only, preserving the lazy-init startup guard).

use serde::Serialize;

use super::wgpu_device::AdapterRecord;

/// One capability entry: available with its detail, or unavailable with the
/// reason kept visible (fallback is a reportable decision, never silent).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct RegistryEntry {
    pub available: bool,
    /// Adapter/library summary when available, the reason when not.
    pub detail: String,
}

impl RegistryEntry {
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

/// The registry snapshot handed to the frontend (`device_registry_snapshot`
/// command). Every field is diagnostic: nothing here selects a device.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DeviceRegistrySnapshot {
    /// Enumerated display adapters with their key wgpu limits. The same
    /// physical GPU may appear once per compiled backend.
    pub adapters: Vec<AdapterRecord>,
    /// Why enumeration produced no adapters, when `adapters` is empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapters_error: Option<String>,
    /// Grade kernel wgpu device (initialises the shared grader once; cached).
    pub grade_wgpu: RegistryEntry,
    /// Shared viewport surface device — cached state only, never initialised
    /// by a snapshot (the lazy-init startup guard stays intact).
    pub viewport_surface: RegistryEntry,
    /// Vendored FFmpeg software baseline.
    pub ffmpeg: RegistryEntry,
    /// Hardware encoder names compiled into the vendored libav (compiled-in
    /// is not a session guarantee; per-run reports stay authoritative).
    pub ffmpeg_hw_encoders: Vec<String>,
    /// Hardware decoder names compiled into the vendored libav.
    pub ffmpeg_hw_decoders: Vec<String>,
    /// onnxruntime execution providers compiled into this build.
    pub onnx_providers: Vec<String>,
}

fn ffmpeg_hw_encoder_names() -> Vec<String> {
    #[cfg(feature = "native-ffmpeg")]
    {
        super::ffmpeg_native::hardware_encoders()
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Vec::new()
    }
}

fn ffmpeg_hw_decoder_names() -> Vec<String> {
    #[cfg(feature = "native-ffmpeg")]
    {
        super::ffmpeg_native::hardware_decoders()
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Vec::new()
    }
}

/// Assemble the registry snapshot from the existing probes.
pub(crate) fn snapshot() -> DeviceRegistrySnapshot {
    let (adapters, adapters_error) = match super::wgpu_device::adapter_records() {
        Ok(records) => (records, None),
        Err(reason) => (Vec::new(), Some(reason)),
    };
    DeviceRegistrySnapshot {
        adapters,
        adapters_error,
        grade_wgpu: RegistryEntry::from_capability(super::grade::wgpu_capability()),
        viewport_surface: RegistryEntry::from_capability(
            super::wgpu_device::surface_device_status(),
        ),
        ffmpeg: RegistryEntry::from_capability(super::video_engine::ffmpeg_capability()),
        ffmpeg_hw_encoders: ffmpeg_hw_encoder_names(),
        ffmpeg_hw_decoders: ffmpeg_hw_decoder_names(),
        onnx_providers: super::onnx_pool::compiled_providers()
            .into_iter()
            .map(str::to_string)
            .collect(),
    }
}

/// The `device_registry_snapshot` command: the frontend's read of the
/// central device registry (Model Manager capability panel, diagnostics).
#[tauri::command]
pub(crate) fn device_registry_snapshot() -> DeviceRegistrySnapshot {
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_never_silent() {
        // Adapters enumerate or the error says why; every entry carries a
        // detail either way (available summary or fallback reason).
        let snap = snapshot();
        assert!(!snap.adapters.is_empty() || snap.adapters_error.is_some());
        for entry in [&snap.grade_wgpu, &snap.viewport_surface, &snap.ffmpeg] {
            assert!(!entry.detail.is_empty());
        }
        assert!(!snap.onnx_providers.is_empty(), "cpu provider is always in");
    }

    #[test]
    fn snapshot_does_not_initialise_the_surface_device() {
        // The registry must preserve the lazy-init startup guard: reading a
        // snapshot reports the surface device's cached state only. When it
        // has not initialised, the entry says so instead of triggering init.
        #[cfg(feature = "viewport-surface")]
        {
            let initialised_before = super::super::wgpu_device::shared_gpu_initialised();
            let snap = snapshot();
            assert_eq!(
                super::super::wgpu_device::shared_gpu_initialised(),
                initialised_before,
                "snapshot must not flip the surface device's init state"
            );
            if !initialised_before {
                assert!(!snap.viewport_surface.available);
                assert!(snap.viewport_surface.detail.contains("not initialised"));
            }
        }
    }

    #[test]
    fn registry_entry_keeps_the_reason_visible() {
        let ok = RegistryEntry::from_capability(Ok("Adapter (Vulkan)".to_string()));
        assert!(ok.available);
        assert_eq!(ok.detail, "Adapter (Vulkan)");
        let err = RegistryEntry::from_capability(Err("no suitable GPU adapter".to_string()));
        assert!(!err.available);
        assert_eq!(err.detail, "no suitable GPU adapter");
    }
}
