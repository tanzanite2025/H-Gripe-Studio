//! Local card processor commands (colour match, mask edge refine, image
//! enhance, detail watchdog) and their result/report types. The processors
//! run natively in Rust (`crate::studio::*_cpu`); command names and result
//! shapes are unchanged.

use serde::{Deserialize, Serialize};

use crate::contracts::QualityReport;

use super::reject_unsafe_output_name;

/// Mean colour / colour temperature / contrast of the corrected region, before
/// or after matching.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ColorAppearance {
    #[serde(default)]
    pub(crate) mean_color: [u8; 3],
    #[serde(default)]
    pub(crate) color_temperature: u32,
    #[serde(default)]
    pub(crate) contrast: f64,
}

/// What `match_light_color` did: the mode/parameters, before/after appearance,
/// and (for the transfer modes) the Lab statistics it matched against. Fields
/// are `snake_case` to match the persisted color-match JSON contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct MatchReport {
    #[serde(default)]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) strength: f64,
    #[serde(default)]
    pub(crate) shadow_strength: f64,
    #[serde(default)]
    pub(crate) highlight_strength: f64,
    #[serde(default)]
    pub(crate) protect_saturation: bool,
    #[serde(default)]
    pub(crate) protect_brand_color: bool,
    /// The subject's source colour mode label (e.g. `RGB`, `RGBA`, `L`).
    #[serde(default)]
    pub(crate) source_mode: String,
    /// The background's source colour mode label (absent without one).
    #[serde(default)]
    pub(crate) background_mode: Option<String>,
    /// Whether a non-identity EXIF orientation was normalised away.
    #[serde(default)]
    pub(crate) exif_transposed: bool,
    /// The decode budget the load was guarded with.
    #[serde(default)]
    pub(crate) max_decode_pixels: i64,
    /// `false` for `prompt_only`, zero strength, or no background reference.
    #[serde(default)]
    pub(crate) applied: bool,
    #[serde(default)]
    pub(crate) before: ColorAppearance,
    #[serde(default)]
    pub(crate) after: ColorAppearance,
    /// Lab mean/std used by the transfer (absent for `histogram_match`).
    #[serde(default)]
    pub(crate) src_mean_lab: Option<Vec<f64>>,
    #[serde(default)]
    pub(crate) dst_mean_lab: Option<Vec<f64>>,
    #[serde(default)]
    pub(crate) src_std_lab: Option<Vec<f64>>,
    #[serde(default)]
    pub(crate) dst_std_lab: Option<Vec<f64>>,
    /// Set when the subject was passed through unchanged for a notable reason.
    #[serde(default)]
    pub(crate) note: Option<String>,
    /// `[width, height]` of the written image.
    #[serde(default)]
    pub(crate) output_size: Option<[i64; 2]>,
    /// The match engine that actually ran (`cpu`).
    #[serde(default)]
    pub(crate) engine: String,
    /// The engine the node asked for (may differ from `engine` on fallback).
    #[serde(default)]
    pub(crate) engine_requested: String,
    /// Why the requested engine was not used (missing deps/weight, no
    /// background reference, …); else `null`.
    #[serde(default)]
    pub(crate) engine_fallback_reason: Option<String>,
    /// Legacy compatibility field; null for current engines.
    #[serde(default)]
    pub(crate) backend_model: Option<String>,
    /// Legacy compatibility field; null on the CPU heuristic path.
    #[serde(default)]
    pub(crate) device: Option<String>,
    /// Compute device the node asked for (`auto`/`cpu`/`gpu`, with legacy
    /// `cuda`/`directml` accepted); `gpu` remains vendor-neutral for later
    /// CUDA/DirectML provider selection.
    #[serde(default)]
    pub(crate) device_requested: String,
}

/// Result of the **Light & Color Match** node: the written matched image, a
/// prompt suffix (for prompt-side alignment), and the [`MatchReport`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ColorMatchResult {
    #[serde(default)]
    pub(crate) matched_image: String,
    #[serde(default)]
    pub(crate) prompt_suffix: String,
    #[serde(default)]
    pub(crate) match_report: MatchReport,
}

/// Match a generated subject image's light & colour toward a PSD background so
/// the composite stops looking pasted-on. This is the **Light & Color Match**
/// node's backend: it consumes the upstream image, the background preview, and
/// optionally the serialized `VisualContext` JSON from PSD Context Analyze.
/// Runs in-process on the native `cpu` heuristic; `mode` is
/// `prompt_only | color_transfer | histogram_match | hybrid`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn match_light_color(
    dir: Option<String>,
    image: String,
    background: Option<String>,
    mask: Option<String>,
    context: Option<String>,
    mode: Option<String>,
    strength: Option<f64>,
    shadow_strength: Option<f64>,
    highlight_strength: Option<f64>,
    protect_saturation: Option<bool>,
    protect_brand_color: Option<bool>,
    engine: Option<String>,
    device: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<ColorMatchResult, String> {
    let _ = dir;
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let engine = engine.unwrap_or_else(|| "cpu".to_string());
    let output_dir = match output_dir.filter(|value| !value.trim().is_empty()) {
        Some(path) => path,
        None => crate::runtime_paths()?
            .output_dir
            .to_string_lossy()
            .to_string(),
    };
    let params = crate::studio::color_match_cpu::CpuColorMatchParams {
        image_path: image.clone(),
        background_path: background.filter(|s| !s.trim().is_empty()),
        mask_path: mask.filter(|s| !s.trim().is_empty()),
        context: context.filter(|s| !s.trim().is_empty()),
        mode,
        strength: strength.unwrap_or(0.6),
        shadow_strength: shadow_strength.unwrap_or(0.0),
        highlight_strength: highlight_strength.unwrap_or(0.0),
        protect_saturation: protect_saturation.unwrap_or(false),
        protect_brand_color: protect_brand_color.unwrap_or(true),
        output_dir,
        output_name: output_name.filter(|s| !s.trim().is_empty()),
        engine_requested: engine,
        device_requested: device
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
    };
    crate::studio::color_match_cpu::try_match(&params)?.ok_or_else(|| {
        format!(
            "Light & Color Match could not decode {image}: unsupported source for the native path"
        )
    })
}

/// What the mask edge refine pass did: the resolved preset/morphology parameters, the
/// edge-band size and the mask coverage before/after. Fields are `snake_case`
/// to match the persisted edge-refine JSON contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EdgeReport {
    #[serde(default)]
    pub(crate) preset: String,
    /// `explicit` when a mask was connected, else `alpha` (the image's own).
    #[serde(default)]
    pub(crate) source_mask: String,
    /// The source colour mode label (e.g. `RGB`, `RGBA`, `L`).
    #[serde(default)]
    pub(crate) source_mode: String,
    /// Whether a non-identity EXIF orientation was normalised away.
    #[serde(default)]
    pub(crate) exif_transposed: bool,
    /// The decode budget the load was guarded with.
    #[serde(default)]
    pub(crate) max_decode_pixels: i64,
    #[serde(default)]
    pub(crate) erode_px: i64,
    #[serde(default)]
    pub(crate) dilate_px: i64,
    #[serde(default)]
    pub(crate) feather_px: f64,
    #[serde(default)]
    pub(crate) guided_radius: i64,
    #[serde(default)]
    pub(crate) edge_decontaminate: bool,
    #[serde(default)]
    pub(crate) background_blend_strength: f64,
    /// `true` when a background was connected and blended into the edge band.
    #[serde(default)]
    pub(crate) background_applied: bool,
    /// `true` when a trimap protected its unknown band from erode/feather.
    #[serde(default)]
    pub(crate) trimap_applied: bool,
    /// Pixels inside the trimap-protected band (0 without a trimap).
    #[serde(default)]
    pub(crate) protected_band_px: i64,
    #[serde(default)]
    pub(crate) edge_band_px: i64,
    #[serde(default)]
    pub(crate) coverage_before: f64,
    #[serde(default)]
    pub(crate) coverage_after: f64,
    /// `[width, height]` of the written images.
    #[serde(default)]
    pub(crate) output_size: Option<[i64; 2]>,
    /// The matte engine that actually ran (`cpu`).
    #[serde(default)]
    pub(crate) engine: String,
    /// The engine the node asked for (may differ from `engine` on fallback).
    #[serde(default)]
    pub(crate) engine_requested: String,
    /// Why the requested engine was not used (missing deps/weight, no trimap,
    /// unknown engine, runtime error); else null.
    #[serde(default)]
    pub(crate) engine_fallback_reason: Option<String>,
    /// Legacy compatibility field; null on the CPU path.
    #[serde(default)]
    pub(crate) backend_model: Option<String>,
    /// Legacy compatibility field; null on the CPU path.
    #[serde(default)]
    pub(crate) device: Option<String>,
    /// Compute device the node asked for (`auto`/`cpu`/`cuda`); an explicit
    /// `cuda` degrades to `cpu` when no accelerator provider is present.
    #[serde(default)]
    pub(crate) device_requested: String,
    /// Set when the pass was a no-op (matte fully opaque or empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// Result of the **Mask Edge Refine** node: the written refined RGBA image, the
/// refined matte (as a grayscale PNG), and the [`EdgeReport`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct RefineEdgeResult {
    #[serde(default)]
    pub(crate) refined_image: String,
    #[serde(default)]
    pub(crate) refined_mask: String,
    #[serde(default)]
    pub(crate) edge_report: EdgeReport,
}

/// Clean up a cut-out subject's matte so it drops into a PSD placeholder
/// without white halos, fringing or jagged semi-transparent edges. This is the
/// **Mask Edge Refine** node's backend. Runs in-process through the native CPU
/// heuristic;
/// `preset` is `clean | natural | soft | custom`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn refine_mask_edge(
    dir: Option<String>,
    image: String,
    mask: Option<String>,
    background: Option<String>,
    placeholder_mask: Option<String>,
    trimap: Option<String>,
    preset: Option<String>,
    erode_px: Option<i64>,
    dilate_px: Option<i64>,
    feather_px: Option<f64>,
    guided_radius: Option<i64>,
    edge_decontaminate: Option<bool>,
    background_blend_strength: Option<f64>,
    output_dir: Option<String>,
    output_name: Option<String>,
    engine: Option<String>,
    device: Option<String>,
) -> Result<RefineEdgeResult, String> {
    let _ = (dir, placeholder_mask);
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let engine = engine
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "cpu".to_string());
    let params = crate::studio::edge_refine_cpu::CpuEdgeRefineParams {
        image_path: image.clone(),
        mask_path: mask.filter(|s| !s.trim().is_empty()),
        background_path: background.filter(|s| !s.trim().is_empty()),
        trimap_path: trimap.filter(|s| !s.trim().is_empty()),
        preset,
        erode_px: erode_px.unwrap_or(1),
        dilate_px: dilate_px.unwrap_or(0),
        feather_px: feather_px.unwrap_or(4.0),
        guided_radius: guided_radius.unwrap_or(8),
        edge_decontaminate: edge_decontaminate.unwrap_or(true),
        background_blend_strength: background_blend_strength.unwrap_or(0.4),
        output_dir: output_dir.unwrap_or_default(),
        output_name: output_name.filter(|s| !s.trim().is_empty()),
        engine_requested: engine,
        device_requested: device
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
    };
    crate::studio::edge_refine_cpu::try_refine(&params)?.ok_or_else(|| {
        format!("Mask Edge Refine could not decode {image}: unsupported source for the native path")
    })
}

/// What the image enhance pass did: the resolved mode, source/output/target sizes, the
/// applied scale factor and the per-step strengths. Fields are `snake_case` to
/// match the persisted image-enhance JSON contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EnhanceReport {
    #[serde(default)]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) scale_factor: f64,
    /// `[width, height]` of the input image.
    #[serde(default)]
    pub(crate) source_size: Option<[i64; 2]>,
    /// `[width, height]` of the written image.
    #[serde(default)]
    pub(crate) output_size: Option<[i64; 2]>,
    /// `[width, height]` requested target, or `null` when a preset scale was used.
    #[serde(default)]
    pub(crate) target_size: Option<[i64; 2]>,
    #[serde(default)]
    pub(crate) max_pixels: i64,
    /// `true` when the scale was reduced to honour `max_pixels`.
    #[serde(default)]
    pub(crate) clamped: bool,
    #[serde(default)]
    pub(crate) denoise_strength: f64,
    #[serde(default)]
    pub(crate) texture_strength: f64,
    #[serde(default)]
    pub(crate) preserve_text_logo: bool,
    /// The upscale engine actually used (`cpu`).
    #[serde(default)]
    pub(crate) engine: String,
    /// The engine the node asked for (may differ from `engine` on fallback).
    #[serde(default)]
    pub(crate) engine_requested: String,
    /// Why the requested engine was not used (missing deps/weight, downscale, …).
    #[serde(default)]
    pub(crate) engine_fallback_reason: Option<String>,
    /// Legacy compatibility field; null for current engines.
    #[serde(default)]
    pub(crate) backend_model: Option<String>,
    /// Legacy compatibility field; null on the built-in resize path.
    #[serde(default)]
    pub(crate) device: Option<String>,
    /// Compute device the node asked for. Visible values are `auto`/`gpu`/`cpu`;
    /// legacy provider-specific requests remain readable.
    #[serde(default)]
    pub(crate) device_requested: String,
    /// Legacy compatibility field; null on the built-in resize path.
    #[serde(default)]
    pub(crate) precision: Option<String>,
    /// Compute precision the node asked for. Visible values are `auto`/`fp32`;
    /// a legacy `fp16` request degrades visibly to `fp32`.
    #[serde(default)]
    pub(crate) precision_requested: String,
    #[serde(default)]
    pub(crate) processing_time_ms: i64,
}

/// Result of the **Image Enhance** node: the written enhanced image, the actual
/// scale factor applied, and the [`EnhanceReport`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EnhanceImageResult {
    #[serde(default)]
    pub(crate) enhanced_image: String,
    #[serde(default)]
    pub(crate) scale_factor: f64,
    #[serde(default)]
    pub(crate) enhance_report: EnhanceReport,
}

/// Upscale and sharpen a low-resolution subject to a requested pixel size. This
/// is the **Image Enhance / Super Resolution** node's backend. Runs in-process
/// on the shared native pipeline ([`crate::studio::image_enhance_cpu`]);
/// `mode` is `conservative | texture_rebuild | custom`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn enhance_image(
    dir: Option<String>,
    image: String,
    target_bounds: Option<String>,
    mode: Option<String>,
    target_width: Option<i64>,
    target_height: Option<i64>,
    max_pixels: Option<i64>,
    scale: Option<f64>,
    denoise_strength: Option<f64>,
    texture_strength: Option<f64>,
    preserve_text_logo: Option<bool>,
    engine: Option<String>,
    device: Option<String>,
    precision: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<EnhanceImageResult, String> {
    let _ = dir;
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let params = crate::studio::image_enhance_cpu::EnhanceParams {
        image_path: image.clone(),
        output_dir: output_dir.unwrap_or_default(),
        output_name: output_name.filter(|s| !s.trim().is_empty()),
        mode,
        target_bounds: target_bounds.filter(|s| !s.trim().is_empty()),
        target_width: target_width.unwrap_or(0),
        target_height: target_height.unwrap_or(0),
        max_pixels: max_pixels.unwrap_or(48_000_000),
        scale: scale.unwrap_or(2.0),
        denoise_strength: denoise_strength.unwrap_or(0.3),
        texture_strength: texture_strength.unwrap_or(0.25),
        preserve_text_logo: preserve_text_logo.unwrap_or(true),
        engine_requested: engine.unwrap_or_else(|| "cpu".to_string()),
        device_requested: device
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
        precision_requested: precision
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
    };
    crate::studio::image_enhance_cpu::try_enhance(&params)?.ok_or_else(|| {
        format!("Image Enhance could not process {image}: unsupported source for the native path")
    })
}

/// Diagnostic summary of a Detail Watchdog run: the resolved mode, which watch
/// targets ran, which were skipped, and the measured global sharpness.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct WatchdogReport {
    #[serde(default)]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) watch_targets: Vec<String>,
    #[serde(default)]
    pub(crate) skipped_targets: Vec<String>,
    /// `[width, height]` of the analysed image.
    #[serde(default)]
    pub(crate) image_size: Option<[i64; 2]>,
    /// `[width, height]` of the connected placeholder target, when available.
    #[serde(default)]
    pub(crate) target_size: Option<[i64; 2]>,
    /// Laplacian-variance sharpness of the whole image (higher = sharper).
    #[serde(default)]
    pub(crate) global_sharpness: f64,
    /// Source mode of the decoded image before normalising to 8-bit RGB
    /// (e.g. `RGB`, `RGBA`, `I;16`, `P`).
    #[serde(default)]
    pub(crate) source_mode: String,
    /// Whether an EXIF orientation tag was applied to upright the input.
    #[serde(default)]
    pub(crate) exif_transposed: bool,
    /// Decode-pixel ceiling enforced before decoding (0 disables the guard).
    #[serde(default)]
    pub(crate) max_decode_pixels: i64,
    /// Whether the optional `--mask` was consumed. Phase 1 detection runs on the
    /// image's own alpha rim, so the supplied matte is advisory only (`false`).
    #[serde(default)]
    pub(crate) mask_consumed: bool,
    /// Detection engine that actually ran: `rules`.
    #[serde(default)]
    pub(crate) engine: String,
    /// Engine the node asked for (may differ from `engine` on fallback).
    #[serde(default)]
    pub(crate) engine_requested: String,
    /// Why the rule-only path was used when an ML engine was requested but could
    /// not run (missing dep/weight, unknown engine, runtime error); else null.
    #[serde(default)]
    pub(crate) engine_fallback_reason: Option<String>,
    /// Legacy compatibility field; empty for current engines.
    #[serde(default)]
    pub(crate) detectors: Vec<String>,
    /// Legacy compatibility field; null for current engines.
    #[serde(default)]
    pub(crate) backend_model: Option<String>,
    /// Legacy compatibility field; null on the rule-only path.
    #[serde(default)]
    pub(crate) device: Option<String>,
    /// Compute device the node asked for (`auto`/`cpu`/`cuda`); an explicit
    /// `cuda` degrades to `cpu` when no accelerator provider is present.
    #[serde(default)]
    pub(crate) device_requested: String,
}

/// Result of the **Detail Watchdog** node: the (unchanged, Phase 1) candidate
/// image, the shared [`QualityReport`], an optional issue-overlay PNG, and the
/// [`WatchdogReport`] diagnostics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct DetectQualityResult {
    #[serde(default)]
    pub(crate) fixed_image: String,
    #[serde(default)]
    pub(crate) quality_report: QualityReport,
    #[serde(default)]
    pub(crate) issue_masks: Option<String>,
    #[serde(default)]
    pub(crate) watchdog_report: WatchdogReport,
}

/// Scan a candidate image for local quality breakdowns (blur, halos, colour
/// mismatch, missing resolution) and emit a [`QualityReport`]. This is the
/// **Detail Watchdog** node's backend. Detect + report only (no automatic
/// repaint); the native `rules` layer runs in-process
/// ([`crate::studio::detail_watchdog_cpu`]).
/// `mode` is `strict | balanced | lenient`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn detect_quality_issues(
    dir: Option<String>,
    image: String,
    visual_context: Option<String>,
    target_bounds: Option<String>,
    watch_targets: Option<String>,
    mode: Option<String>,
    engine: Option<String>,
    device: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<DetectQualityResult, String> {
    let _ = dir;
    reject_unsafe_output_name(output_name.as_deref().unwrap_or(""))?;
    let params = crate::studio::detail_watchdog_cpu::CpuDetailWatchdogParams {
        image_path: image.clone(),
        visual_context: visual_context.filter(|s| !s.trim().is_empty()),
        target_bounds: target_bounds.filter(|s| !s.trim().is_empty()),
        watch_targets: watch_targets.filter(|s| !s.trim().is_empty()),
        mode,
        output_dir: output_dir.unwrap_or_default(),
        output_name: output_name.filter(|s| !s.trim().is_empty()),
        engine_requested: engine
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "rules".to_string()),
        device_requested: device
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
    };
    crate::studio::detail_watchdog_cpu::try_watch(&params)?.ok_or_else(|| {
        format!("Detail Watchdog could not decode {image}: unsupported source for the native path")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn match_command_rejects_retired_local_engine() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hgripe_match_command_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("subject.png");
        RgbaImage::from_pixel(12, 12, Rgba([90, 120, 160, 255]))
            .save(&source)
            .unwrap();

        let err = match_light_color(
            None,
            source.to_string_lossy().to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("retired_local_engine".to_string()),
            Some("gpu".to_string()),
            None,
            Some(format!("direct_match_{nanos}")),
        )
        .unwrap_err();
        assert!(err.contains("retired"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refine_command_rejects_retired_local_engine() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hgripe_refine_command_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("subject.png");
        RgbaImage::from_pixel(12, 12, Rgba([90, 120, 160, 180]))
            .save(&source)
            .unwrap();

        let err = refine_mask_edge(
            None,
            source.to_string_lossy().to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(dir.to_string_lossy().to_string()),
            Some("direct_refine".to_string()),
            Some("retired_local_engine".to_string()),
            Some("cpu".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("retired"), "{err}");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn enhance_command_rejects_retired_local_engine() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hgripe_enhance_command_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("subject.png");
        RgbaImage::from_pixel(8, 8, Rgba([90, 120, 160, 180]))
            .save(&source)
            .unwrap();

        let err = enhance_image(
            None,
            source.to_string_lossy().to_string(),
            None, // target_bounds
            None, // mode
            None, // target_width
            None, // target_height
            None, // max_pixels
            None, // scale
            None, // denoise_strength
            None, // texture_strength
            None, // preserve_text_logo
            Some("ccsr".to_string()),
            Some("gpu".to_string()),
            Some("fp16".to_string()),
            Some(dir.to_string_lossy().to_string()),
            Some("direct_enhance".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("retired"), "{err}");

        let _ = std::fs::remove_dir_all(dir);
    }
}
