//! Detail Repaint pipeline: prepare repaintable regions and composite
//! provider results back, both running in-process on the native Rust path
//! (`crate::studio::detail_repaint_cpu`). Split out of `psd.rs`; command names
//! and result shapes are unchanged.

use serde::{Deserialize, Serialize};

use crate::contracts::RepaintReport;
use crate::studio::detail_repaint_cpu::{
    try_composite, try_prepare, CpuCompositeParams, CpuPrepareParams,
};

use super::reject_unsafe_output_name;

/// One issue region prepared for repaint: the padded crop + same-size inpaint
/// mask the orchestrator sends to the provider, plus the geometry the composite
/// step needs to paste the result back. Fields are `snake_case` to match the
/// `detail_repaint_cli.py` manifest; extra fields are tolerated.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct PreparedRepaintRegion {
    #[serde(default)]
    pub(crate) index: u32,
    #[serde(rename = "type", default)]
    pub(crate) issue_type: Option<String>,
    #[serde(default)]
    pub(crate) confidence: f64,
    #[serde(default)]
    pub(crate) suggested_action: Option<String>,
    #[serde(default)]
    pub(crate) bbox: [i64; 4],
    #[serde(default)]
    pub(crate) crop_box: [i64; 4],
    #[serde(default)]
    pub(crate) inner_box: [i64; 4],
    #[serde(default)]
    pub(crate) size: [i64; 2],
    /// Path to the padded crop PNG (the provider `image.edit` image input).
    #[serde(default)]
    pub(crate) crop_path: String,
    /// Path to the same-size inpaint mask PNG (the provider mask input).
    #[serde(default)]
    pub(crate) mask_path: String,
}

/// Result of the **Detail Repaint** prepare step: the regions selected from the
/// quality report (each with a crop + mask to send to the provider) and the
/// issues that were skipped (with reasons).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct PrepareRepaintResult {
    #[serde(default)]
    pub(crate) regions: Vec<PreparedRepaintRegion>,
    #[serde(default)]
    pub(crate) skipped: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) image_size: [i64; 2],
    #[serde(default)]
    pub(crate) selected_count: u32,
    /// `true` when the inpaint mask marks the edit area transparent (OpenAI
    /// convention); `false` when inverted (opaque/white = edit).
    #[serde(default)]
    pub(crate) inpaint_mask_is_transparent: bool,
    /// Pillow mode of the decoded candidate before normalising to 8-bit RGBA.
    #[serde(default)]
    pub(crate) source_mode: String,
    /// Whether an EXIF orientation tag was applied to upright the candidate.
    #[serde(default)]
    pub(crate) exif_transposed: bool,
    /// Decode-pixel ceiling enforced before decoding (0 disables the guard).
    #[serde(default)]
    pub(crate) max_decode_pixels: i64,
}

/// Result of the **Detail Repaint** composite step: the fixed image (issue
/// cores repainted and edge-fused back in) and the per-region [`RepaintReport`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CompositeRepaintResult {
    #[serde(default)]
    pub(crate) fixed_image: String,
    #[serde(default)]
    pub(crate) repaint_report: RepaintReport,
}

/// Crop each repaintable issue region out of a candidate image and write a
/// same-size inpaint mask for it. This is the first half of the **Detail
/// Repaint** node (the Phase-2 follow-up to Detail Watchdog): the orchestrator
/// then sends each returned crop + mask + repaint prompt to a provider's
/// `image.edit` operation before calling [`composite_repaint`] to paste the
/// results back.
///
/// Runs natively in Rust (`crate::studio::detail_repaint_cpu`). Only issues
/// whose `suggested_action` is in `repaint_actions` (default `detail_redraw`)
/// and at/above `min_confidence` are selected, highest-confidence first, capped
/// at `max_regions`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_repaint_regions(
    dir: Option<String>,
    image: String,
    quality_report: Option<String>,
    repaint_actions: Option<String>,
    min_confidence: Option<f64>,
    padding: Option<i64>,
    max_regions: Option<i64>,
    invert_mask: Option<bool>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<PrepareRepaintResult, String> {
    let _ = dir;
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let params = CpuPrepareParams {
        image_path: image,
        quality_report,
        repaint_actions,
        min_confidence: min_confidence.unwrap_or(0.0),
        padding: padding.unwrap_or(24),
        max_regions: max_regions.unwrap_or(8),
        invert_mask: invert_mask.unwrap_or(false),
        output_dir: output_dir.unwrap_or_default(),
        output_name,
    };
    try_prepare(&params)?.ok_or_else(|| {
        format!(
            "prepare_repaint_regions could not decode {}: unsupported source for the native repaint path",
            params.image_path
        )
    })
}

/// Paste the provider-repainted crops back into the candidate image, fusing
/// each patch seam with a feathered alpha (the "secondary edge fusion"), and
/// write the final fixed image. This is the second half of the **Detail
/// Repaint** node.
///
/// `manifest` is the JSON returned by [`prepare_repaint_regions`]; `repainted`
/// is a JSON list of `{index, path}` mapping each region to the crop the
/// provider returned (regions with no entry stay unrepainted). Runs natively
/// in Rust (`crate::studio::detail_repaint_cpu`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn composite_repaint(
    dir: Option<String>,
    image: String,
    manifest: String,
    repainted: String,
    feather_px: Option<f64>,
    blend: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<CompositeRepaintResult, String> {
    let _ = dir;
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let params = CpuCompositeParams {
        image_path: image,
        manifest,
        repainted,
        feather_px: feather_px.unwrap_or(0.0),
        blend,
        output_dir: output_dir.unwrap_or_default(),
        output_name,
    };
    try_composite(&params)?.ok_or_else(|| {
        format!(
            "composite_repaint could not decode {}: unsupported source for the native repaint path",
            params.image_path
        )
    })
}

/// One repainted crop produced by the local inpaint backend: the region
/// `index` and the path to the regenerated crop PNG, ready to feed straight
/// into [`composite_repaint`]'s `repainted` list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct LocalRepaintedCrop {
    #[serde(default)]
    pub(crate) index: u32,
    #[serde(default)]
    pub(crate) path: String,
}

/// Result of the **Detail Repaint** local `repaint` step: the regenerated crops
/// plus the engine telemetry the UI uses to explain a fallback to the remote
/// provider. An empty `repainted` list (with a `engine_fallback_reason`) means
/// the orchestrator should run its remote `image.edit` loop instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct LocalRepaintResult {
    #[serde(default)]
    pub(crate) repainted: Vec<LocalRepaintedCrop>,
    #[serde(default)]
    pub(crate) skipped: Vec<serde_json::Value>,
    /// Engine that actually ran (`provider` when no local backend was used).
    #[serde(default)]
    pub(crate) engine: String,
    /// Engine the node asked for (differs from `engine` on fallback).
    #[serde(default)]
    pub(crate) engine_requested: String,
    /// Why the local backend was not used (provider selected, missing deps/weight).
    #[serde(default)]
    pub(crate) engine_fallback_reason: Option<String>,
    /// Weight name when a local backend ran, else null.
    #[serde(default)]
    pub(crate) backend_model: Option<String>,
    /// Compute device the local backend bound (`cpu`/`cuda`); `null` on the
    /// remote `provider` path, which runs no local session.
    #[serde(default)]
    pub(crate) device: Option<String>,
    /// Compute precision the local backend bound (`fp16`/`fp32`); `null` on the
    /// remote `provider` path, which runs no local session.
    #[serde(default)]
    pub(crate) precision: Option<String>,
    /// Compute precision the node asked for (`auto`/`fp32`/`fp16`); an explicit
    /// `fp16` degrades to `fp32` on a CPU run.
    #[serde(default)]
    pub(crate) precision_requested: String,
    /// Structural conditioning the node asked for (`off`/`canny`); a backend
    /// that cannot honour it degrades to the provider with a recorded reason.
    #[serde(default)]
    pub(crate) controlnet_requested: String,
    #[serde(default)]
    pub(crate) requested_count: u32,
    #[serde(default)]
    pub(crate) repainted_count: u32,
}

/// The **local** inpaint seam for the **Detail Repaint** node. The Python
/// torch backends were removed with the Python bridge, so every engine now
/// resolves to the remote `provider` path: this returns an empty `repainted`
/// list (with a recorded fallback reason when a local engine was requested),
/// so the orchestrator runs its remote `image.edit` loop instead.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn local_repaint_regions(
    dir: Option<String>,
    manifest: String,
    engine: Option<String>,
    prompt: Option<String>,
    prompt_map: Option<String>,
    negative_prompt: Option<String>,
    strength: Option<f64>,
    guidance_scale: Option<f64>,
    steps: Option<i64>,
    seed: Option<i64>,
    precision: Option<String>,
    controlnet: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<LocalRepaintResult, String> {
    let _ = (
        dir,
        prompt,
        prompt_map,
        negative_prompt,
        strength,
        guidance_scale,
        steps,
        seed,
        output_dir,
    );
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;

    let engine_requested = engine
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or("provider")
        .to_string();
    let requested_count = serde_json::from_str::<PrepareRepaintResult>(manifest.trim())
        .map(|m| m.regions.len() as u32)
        .unwrap_or(0);
    let engine_fallback_reason = if engine_requested == "provider" {
        None
    } else {
        Some(format!(
            "local engine '{engine_requested}' is no longer available (the Python torch backends were removed); using the remote provider"
        ))
    };

    Ok(LocalRepaintResult {
        repainted: Vec::new(),
        skipped: Vec::new(),
        engine: "provider".to_string(),
        engine_requested,
        engine_fallback_reason,
        backend_model: None,
        device: None,
        precision: None,
        precision_requested: precision.as_deref().unwrap_or("auto").to_string(),
        controlnet_requested: controlnet.as_deref().unwrap_or("off").to_string(),
        requested_count,
        repainted_count: 0,
    })
}
