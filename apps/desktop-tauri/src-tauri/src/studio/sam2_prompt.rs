//! The `sam2_prompt_mask` command: the Studio Action runtime's
//! `mask.subject.point_prompt` compute block, exposed directly to the
//! frontend rather than through a workflow node run.
//!
//! Takes an image path plus SAM 2 point prompts, runs the same in-process
//! segmenter stack the `subjectMask` node uses ([`segmenter_for_mode`]:
//! SAM 2 when a positive point exists and its weights resolve, else the
//! salient / builtin CPU fallback — the command never fails just because a
//! weight is missing), writes the resulting matte as a grayscale PNG, and
//! returns the artifact path plus the provider / variant / coverage report
//! the action's preview gate shows. The command only produces a mask
//! artifact: committing it onto a layer mask is the frontend Studio Action's
//! (user-gated) job.

use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::persist::studio_reject_unsafe_basename;
use super::studio_image;
use super::subject_sam2::Sam2Variant;
use super::subject_segment::{segmenter_for_mode, AutoMode, PointPrompt, SegmentRequest};

/// A frontend point prompt: image-pixel coordinates plus the SAM label
/// (`1` include / `0` exclude), matching the `PointPrompt` of the mask
/// document's `points`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct Sam2PromptPoint {
    pub x: f64,
    pub y: f64,
    pub label: u8,
}

/// What `sam2_prompt_mask` produced; `snake_case` to match the bridge JSON.
#[derive(Debug, Serialize)]
pub(crate) struct Sam2PromptMaskResult {
    /// The written grayscale matte PNG — the action's `maskArtifactRef`.
    pub mask_path: String,
    /// Segmenter that actually ran (`sam2`, a salient model id, `builtin-cpu`).
    pub provider: String,
    /// SAM 2 variant requested (`tiny` unless overridden).
    pub variant_requested: String,
    /// The weight file(s) inference ran on; `null` for the builtin fallback.
    pub model_path: Option<String>,
    /// Fraction of selected pixels, 0..=1.
    pub coverage: f64,
    /// `[x, y, width, height]` of the selected region; `null` when empty.
    pub bbox: Option<[u32; 4]>,
    /// `[width, height]` of the segmented image (mask dimensions).
    pub image_size: [u32; 2],
    pub processing_time_ms: u128,
}

/// Run SAM 2 point-prompt segmentation on an image and write the matte PNG.
/// The Studio Action layer calls this through the `sam2.point_prompt`
/// compute block; it never touches the mask document itself.
#[tauri::command]
pub(crate) fn sam2_prompt_mask(
    image: String,
    points: Vec<Sam2PromptPoint>,
    variant: Option<String>,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<Sam2PromptMaskResult, String> {
    let started = Instant::now();

    let image_path = image.trim();
    if image_path.is_empty() {
        return Err("sam2_prompt_mask needs an image path".to_string());
    }
    if !points.iter().any(|p| p.label == 1) {
        return Err("sam2_prompt_mask needs at least one positive point prompt".to_string());
    }

    let dir = match output_dir.as_deref().map(str::trim) {
        Some(configured) if !configured.is_empty() => PathBuf::from(configured),
        _ => crate::runtime_paths()?.output_dir,
    };
    let base = match output_name.as_deref().map(str::trim) {
        Some(configured) if !configured.is_empty() => configured.to_string(),
        _ => format!("sam2_prompt_{}", started.elapsed().as_nanos()),
    };
    studio_reject_unsafe_basename(&base)?;

    let loaded = studio_image::load_working(
        std::path::Path::new(image_path),
        studio_image::DEFAULT_MAX_DECODE_PIXELS,
    )?;
    let rgba = loaded.image.to_srgb_rgba8();
    let (width, height) = rgba.dimensions();

    // Clamp prompts into the image so a viewport-edge click cannot land
    // outside the encoder space.
    let prompts: Vec<PointPrompt> = points
        .iter()
        .map(|p| PointPrompt {
            x: (p.x.max(0.0) as u32).min(width.saturating_sub(1)),
            y: (p.y.max(0.0) as u32).min(height.saturating_sub(1)),
            positive: p.label == 1,
        })
        .collect();

    let variant_requested = Sam2Variant::from_param(variant.as_deref().unwrap_or(""));
    let segmenter = segmenter_for_mode(AutoMode::Subject, &prompts, variant_requested);
    let result = segmenter.segment(&SegmentRequest {
        image: &rgba,
        mode: AutoMode::Subject,
        placeholder: None,
        prompt: None,
        points: &prompts,
    })?;
    let mask = result.mask;

    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;
    let mask_path = dir.join(format!("{base}.png"));
    mask.save(&mask_path)
        .map_err(|err| format!("failed to write {}: {err}", mask_path.display()))?;

    let bbox = super::subject_model::selection_bbox(&mask)
        .map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0 + 1, y1 - y0 + 1]);

    Ok(Sam2PromptMaskResult {
        mask_path: mask_path.to_string_lossy().to_string(),
        provider: segmenter.provider().to_string(),
        variant_requested: variant_requested.id().to_string(),
        model_path: segmenter.model_path(),
        coverage: super::subject_model::coverage(&mask),
        bbox,
        image_size: [width, height],
        processing_time_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_image(dir: &std::path::Path) -> String {
        // A dark square subject on a light background: the builtin CPU
        // fallback segments it deterministically when no weights resolve.
        let mut img = image::RgbaImage::from_pixel(64, 64, image::Rgba([240, 240, 240, 255]));
        for y in 16..48 {
            for x in 16..48 {
                img.put_pixel(x, y, image::Rgba([20, 20, 20, 255]));
            }
        }
        let path = dir.join("sam2_prompt_input.png");
        img.save(&path).expect("write test image");
        path.to_string_lossy().to_string()
    }

    #[test]
    fn needs_a_positive_point() {
        let err = sam2_prompt_mask(
            "ignored.png".to_string(),
            vec![Sam2PromptPoint {
                x: 1.0,
                y: 1.0,
                label: 0,
            }],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("positive point"), "{err}");
    }

    #[test]
    fn needs_an_image_path() {
        let err = sam2_prompt_mask(
            "  ".to_string(),
            vec![Sam2PromptPoint {
                x: 1.0,
                y: 1.0,
                label: 1,
            }],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("image path"), "{err}");
    }

    #[test]
    fn segments_and_writes_the_mask_artifact() {
        let dir = std::env::temp_dir().join(format!("hgripe-sam2-prompt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let image = write_test_image(&dir);

        let result = sam2_prompt_mask(
            image,
            vec![Sam2PromptPoint {
                x: 32.0,
                y: 32.0,
                label: 1,
            }],
            Some("tiny".to_string()),
            Some(dir.to_string_lossy().to_string()),
            Some("sam2_prompt_test".to_string()),
        )
        .expect("segmentation runs");

        assert!(std::path::Path::new(&result.mask_path).is_file());
        assert!(!result.provider.is_empty());
        assert_eq!(result.variant_requested, "tiny");
        assert_eq!(result.image_size, [64, 64]);
        assert!(result.coverage > 0.0);
        let bbox = result.bbox.expect("subject found");
        assert!(bbox[2] > 0 && bbox[3] > 0);

        let mask = image::open(&result.mask_path)
            .expect("read mask")
            .to_luma8();
        assert_eq!(mask.dimensions(), (64, 64));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unsafe_output_names() {
        let err = sam2_prompt_mask(
            "ignored.png".to_string(),
            vec![Sam2PromptPoint {
                x: 1.0,
                y: 1.0,
                label: 1,
            }],
            None,
            Some(std::env::temp_dir().to_string_lossy().to_string()),
            Some("../escape".to_string()),
        )
        .unwrap_err();
        assert!(err.to_ascii_lowercase().contains("name"), "{err}");
    }
}
