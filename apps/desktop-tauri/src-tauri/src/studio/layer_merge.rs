//! Review Editor merge/split commands
//! (docs/plans/completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Phase 2 合并/拆分).
//!
//! `merge_layer_masks` unions two or more layer masks of one layered image
//! asset into a single merged layer's artifacts; `split_layer_mask` breaks one
//! layer's mask into per-object connected components. Both write mask PNGs
//! plus the corresponding RGBA cutouts of the source image. The UI keeps the
//! asset JSON itself — these commands only produce the pixel artifacts and
//! their bboxes.

use std::path::{Path, PathBuf};

use image::GrayImage;
use serde::Serialize;

use super::persist::studio_reject_unsafe_basename;
use super::pixel_ops;
use super::studio_image;

#[derive(Debug, Serialize)]
pub struct MergedLayerArtifacts {
    pub mask_path: String,
    pub rgba_path: String,
    /// `[x1, y1, x2, y2]` extents of the merged mask (`[0,0,0,0]` = empty).
    pub bbox: [u32; 4],
    pub width: u32,
    pub height: u32,
}

/// Pixelwise max-union of same-sized masks.
fn union_masks(masks: &[GrayImage]) -> GrayImage {
    let mut out = masks[0].clone();
    for mask in &masks[1..] {
        for (dst, src) in out.pixels_mut().zip(mask.pixels()) {
            dst.0[0] = dst.0[0].max(src.0[0]);
        }
    }
    out
}

fn merge_layer_masks_impl(
    image_path: &str,
    mask_paths: &[String],
    output_dir: &str,
    output_name: &str,
) -> Result<MergedLayerArtifacts, String> {
    if image_path.trim().is_empty() {
        return Err("merge needs the asset's source image path".to_string());
    }
    if mask_paths.len() < 2 {
        return Err("merge needs at least two layer masks".to_string());
    }
    studio_reject_unsafe_basename(output_name)?;

    let loaded = studio_image::load_working(
        Path::new(image_path.trim()),
        studio_image::DEFAULT_MAX_DECODE_PIXELS,
    )?;
    let working = loaded.image;
    let (width, height) = (working.width, working.height);

    let mut masks: Vec<GrayImage> = Vec::with_capacity(mask_paths.len());
    for path in mask_paths {
        let mask = image::open(Path::new(path.trim()))
            .map_err(|err| format!("failed to read mask {path}: {err}"))?
            .to_luma8();
        if mask.dimensions() != (width, height) {
            return Err(format!(
                "mask {path} is {}x{} but the canvas is {width}x{height}",
                mask.width(),
                mask.height()
            ));
        }
        masks.push(mask);
    }
    let merged = union_masks(&masks);

    let dir = if output_dir.trim().is_empty() {
        crate::runtime_paths()?.output_dir
    } else {
        PathBuf::from(output_dir.trim())
    };
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;
    let mask_path = dir.join(format!("{output_name}_mask.png"));
    let rgba_path = dir.join(format!("{output_name}.png"));
    merged
        .save(&mask_path)
        .map_err(|err| format!("failed to write {}: {err}", mask_path.display()))?;
    let rgba = pixel_ops::apply_alpha_mask_working(&working, &merged);
    studio_image::write_working_output(&rgba_path, &rgba)?;

    Ok(MergedLayerArtifacts {
        mask_path: mask_path.to_string_lossy().to_string(),
        rgba_path: rgba_path.to_string_lossy().to_string(),
        bbox: super::layer_split::mask_bbox(&merged),
        width,
        height,
    })
}

#[tauri::command]
pub fn merge_layer_masks(
    image_path: String,
    mask_paths: Vec<String>,
    output_dir: String,
    output_name: String,
) -> Result<MergedLayerArtifacts, String> {
    merge_layer_masks_impl(&image_path, &mask_paths, &output_dir, &output_name)
}

fn split_layer_mask_impl(
    image_path: &str,
    mask_path: &str,
    output_dir: &str,
    output_name: &str,
) -> Result<Vec<MergedLayerArtifacts>, String> {
    if image_path.trim().is_empty() {
        return Err("split needs the asset's source image path".to_string());
    }
    studio_reject_unsafe_basename(output_name)?;

    let loaded = studio_image::load_working(
        Path::new(image_path.trim()),
        studio_image::DEFAULT_MAX_DECODE_PIXELS,
    )?;
    let working = loaded.image;
    let (width, height) = (working.width, working.height);
    let mask = image::open(Path::new(mask_path.trim()))
        .map_err(|err| format!("failed to read mask {mask_path}: {err}"))?
        .to_luma8();
    if mask.dimensions() != (width, height) {
        return Err(format!(
            "mask {mask_path} is {}x{} but the canvas is {width}x{height}",
            mask.width(),
            mask.height()
        ));
    }
    let parts = super::layer_split::instance_masks(&mask);
    if parts.len() < 2 {
        return Err(
            "the mask has no more than one component above the minimum area — nothing to split"
                .to_string(),
        );
    }

    let dir = if output_dir.trim().is_empty() {
        crate::runtime_paths()?.output_dir
    } else {
        PathBuf::from(output_dir.trim())
    };
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;

    let mut out = Vec::with_capacity(parts.len());
    for (n, part) in parts.iter().enumerate() {
        let ordinal = n + 1;
        let mask_path = dir.join(format!("{output_name}_{ordinal}_mask.png"));
        let rgba_path = dir.join(format!("{output_name}_{ordinal}.png"));
        part.save(&mask_path)
            .map_err(|err| format!("failed to write {}: {err}", mask_path.display()))?;
        let rgba = pixel_ops::apply_alpha_mask_working(&working, part);
        studio_image::write_working_output(&rgba_path, &rgba)?;
        out.push(MergedLayerArtifacts {
            mask_path: mask_path.to_string_lossy().to_string(),
            rgba_path: rgba_path.to_string_lossy().to_string(),
            bbox: super::layer_split::mask_bbox(part),
            width,
            height,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn split_layer_mask(
    image_path: String,
    mask_path: String,
    output_dir: String,
    output_name: String,
) -> Result<Vec<MergedLayerArtifacts>, String> {
    split_layer_mask_impl(&image_path, &mask_path, &output_dir, &output_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Luma, Rgba, RgbaImage};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hgripe_layer_merge_{tag}_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn block_mask(x0: u32, y0: u32, x1: u32, y1: u32) -> GrayImage {
        let mut mask = GrayImage::from_pixel(16, 16, Luma([0]));
        for y in y0..=y1 {
            for x in x0..=x1 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        mask
    }

    #[test]
    fn merges_two_masks_into_union_artifacts() {
        let root = temp_dir("union");
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(16, 16, Rgba([90, 90, 90, 255]))
            .save(&image_path)
            .unwrap();
        let a = root.join("a_mask.png");
        let b = root.join("b_mask.png");
        block_mask(1, 1, 4, 4).save(&a).unwrap();
        block_mask(10, 10, 13, 13).save(&b).unwrap();
        let out = merge_layer_masks_impl(
            &image_path.to_string_lossy(),
            &[
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
            &root.to_string_lossy(),
            "merged_object",
        )
        .unwrap();
        assert_eq!(out.bbox, [1, 1, 13, 13]);
        assert!(Path::new(&out.mask_path).is_file());
        assert!(Path::new(&out.rgba_path).is_file());
        let merged = image::open(&out.mask_path).unwrap().to_luma8();
        assert_eq!(merged.get_pixel(2, 2).0[0], 255);
        assert_eq!(merged.get_pixel(12, 12).0[0], 255);
        assert_eq!(merged.get_pixel(8, 8).0[0], 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_fewer_than_two_masks_and_size_mismatch() {
        let root = temp_dir("reject");
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(16, 16, Rgba([90, 90, 90, 255]))
            .save(&image_path)
            .unwrap();
        let a = root.join("a_mask.png");
        block_mask(1, 1, 4, 4).save(&a).unwrap();
        let err = merge_layer_masks_impl(
            &image_path.to_string_lossy(),
            &[a.to_string_lossy().to_string()],
            &root.to_string_lossy(),
            "merged",
        )
        .unwrap_err();
        assert!(err.contains("at least two"), "{err}");
        let small = root.join("small_mask.png");
        GrayImage::from_pixel(8, 8, Luma([255]))
            .save(&small)
            .unwrap();
        let err = merge_layer_masks_impl(
            &image_path.to_string_lossy(),
            &[
                a.to_string_lossy().to_string(),
                small.to_string_lossy().to_string(),
            ],
            &root.to_string_lossy(),
            "merged",
        )
        .unwrap_err();
        assert!(err.contains("canvas"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn splits_a_mask_into_component_artifacts() {
        let root = temp_dir("split");
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(16, 16, Rgba([90, 90, 90, 255]))
            .save(&image_path)
            .unwrap();
        let mask_path = root.join("two_blobs_mask.png");
        let mut mask = block_mask(1, 1, 4, 4);
        for y in 10..=13 {
            for x in 10..=13 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        mask.save(&mask_path).unwrap();
        let parts = split_layer_mask_impl(
            &image_path.to_string_lossy(),
            &mask_path.to_string_lossy(),
            &root.to_string_lossy(),
            "split_object",
        )
        .unwrap();
        assert_eq!(parts.len(), 2);
        // largest-first ordering; both blobs are equal here so just check bboxes
        let bboxes: Vec<[u32; 4]> = parts.iter().map(|p| p.bbox).collect();
        assert!(bboxes.contains(&[1, 1, 4, 4]));
        assert!(bboxes.contains(&[10, 10, 13, 13]));
        for part in &parts {
            assert!(Path::new(&part.mask_path).is_file());
            assert!(Path::new(&part.rgba_path).is_file());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn split_rejects_single_component_masks() {
        let root = temp_dir("split_single");
        let image_path = root.join("scene.png");
        RgbaImage::from_pixel(16, 16, Rgba([90, 90, 90, 255]))
            .save(&image_path)
            .unwrap();
        let mask_path = root.join("one_blob_mask.png");
        block_mask(1, 1, 6, 6).save(&mask_path).unwrap();
        let err = split_layer_mask_impl(
            &image_path.to_string_lossy(),
            &mask_path.to_string_lossy(),
            &root.to_string_lossy(),
            "split_object",
        )
        .unwrap_err();
        assert!(err.contains("nothing to split"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
