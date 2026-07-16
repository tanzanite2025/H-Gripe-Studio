# Subject Mask / Matte Editor

Subject Mask is a deterministic native Rust compute card. It creates and edits
a grayscale mask, alpha image, and cropped cutout without network access or
downloaded model weights.

## Selection

Manual tools include brush, eraser, magic wand, marquee, lasso, pen/path,
quick selection, object-region selection, background eraser, and mask
morphology. Auto modes use a weight-free segmenter:

1. Estimate the background colour from the image border.
2. Mark pixels that differ from that background.
3. Keep the largest connected component, or the components constrained by
   positive/negative point hints.
4. Apply placeholder, prior-mask, and manual-edit constraints.

This is deterministic subject isolation, not semantic model inference.

## Continuous Alpha

When alpha_matting is enabled or matting strokes exist, the card builds a
foreground/unknown/background trimap. A bounded guided filter uses image luma
to resolve only the unknown band. Hard foreground and background remain exact.

## Contract

Inputs:

- image (required)
- previous_mask, placeholder_mask, prompt, edit_paths (optional)

Key parameters:

- mode: auto_subject, auto_product, auto_person, auto_transparent_object,
  manual_brush, manual_pen, or hybrid
- fill_holes, grow_px, feather_px
- alpha_matting and matting_band_px
- max_decode_pixels
- output_dir and output_name

Outputs:

- mask
- alpha_image
- cutout_image
- trimap
- matte_report
- edit_paths

The report identifies builtin-cpu for auto selection and
builtin-cpu-matte for guided matting. A legacy accelerated-device request is
reported as a CPU decision with a visible reason.

## Implementation

- apps/desktop-tauri/src-tauri/src/studio/subject_mask.rs
- apps/desktop-tauri/src-tauri/src/studio/subject_segment.rs
- apps/desktop-tauri/src-tauri/src/studio/subject_matte.rs
