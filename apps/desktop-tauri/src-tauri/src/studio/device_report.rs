//! Rust-side shared device-report vocabulary (GPU_DEVICE_STRATEGY_PLAN).
//!
//! Mirrors the TypeScript vocabulary in
//! `studio-ui/src/runtime/deviceReport.ts` (`DeviceRequest`, `DeviceUsed`,
//! `DeviceReport`): every engine that emits device telemetry on a `*_report`
//! output spells its `device_requested` / `device` values from these enums
//! instead of ad-hoc string literals, so the Rust producers and the UI
//! normalizers cannot drift apart. The wire shape stays the existing flat
//! report fields; this module is the single source for the legal values and
//! the accelerated classification.

/// What the user asked for (the node's `device` param vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceRequest {
    Auto,
    Cpu,
    Cuda,
    Gpu,
}

impl DeviceRequest {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::Gpu => "gpu",
        }
    }
}

/// What actually ran. Matches the TS `DeviceUsed` union member for member.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceUsed {
    Cpu,
    Cuda,
    Wgpu,
    Directml,
    FfmpegSw,
    FfmpegHw,
    Provider,
    Unknown,
}

impl DeviceUsed {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::Wgpu => "wgpu",
            Self::Directml => "directml",
            Self::FfmpegSw => "ffmpeg_sw",
            Self::FfmpegHw => "ffmpeg_hw",
            Self::Provider => "provider",
            Self::Unknown => "unknown",
        }
    }

    /// Whether this device counts as accelerated — the same ACCELERATED set
    /// the UI uses: cuda, wgpu, directml, ffmpeg_hw. The software FFmpeg
    /// baseline and CPU are honest non-accelerated results, not failures.
    pub(crate) fn accelerated(self) -> bool {
        matches!(
            self,
            Self::Cuda | Self::Wgpu | Self::Directml | Self::FfmpegHw
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_matches_the_shared_contract() {
        // The wire strings must match studio-ui/src/runtime/deviceReport.ts
        // exactly; the UI normalizers key on them.
        assert_eq!(DeviceRequest::Auto.as_str(), "auto");
        assert_eq!(DeviceRequest::Cpu.as_str(), "cpu");
        assert_eq!(DeviceRequest::Cuda.as_str(), "cuda");
        assert_eq!(DeviceRequest::Gpu.as_str(), "gpu");
        assert_eq!(DeviceUsed::FfmpegSw.as_str(), "ffmpeg_sw");
        assert_eq!(DeviceUsed::FfmpegHw.as_str(), "ffmpeg_hw");
        assert_eq!(DeviceUsed::Directml.as_str(), "directml");
    }

    #[test]
    fn accelerated_set_matches_the_ui_classification() {
        // ACCELERATED = { cuda, wgpu, directml, ffmpeg_hw }; cpu and the
        // software FFmpeg baseline are honest non-accelerated results.
        assert!(DeviceUsed::Cuda.accelerated());
        assert!(DeviceUsed::Wgpu.accelerated());
        assert!(DeviceUsed::Directml.accelerated());
        assert!(DeviceUsed::FfmpegHw.accelerated());
        assert!(!DeviceUsed::Cpu.accelerated());
        assert!(!DeviceUsed::FfmpegSw.accelerated());
        assert!(!DeviceUsed::Provider.accelerated());
        assert!(!DeviceUsed::Unknown.accelerated());
    }
}
