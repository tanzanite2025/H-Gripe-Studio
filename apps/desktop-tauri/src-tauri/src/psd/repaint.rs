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
/// step needs to paste the result back. Fields use the persisted `snake_case`
/// manifest contract; extra fields are tolerated.
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
