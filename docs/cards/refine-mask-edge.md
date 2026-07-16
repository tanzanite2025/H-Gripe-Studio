# Refine Mask Edge

Refine Mask Edge is a deterministic native Rust card for cleaning cutout edges.
It combines morphology, an image-guided filter, feathering, trimap unknown-band
protection, edge-colour decontamination, and optional background blending.

## Contract

Inputs:

- image (required)
- mask (optional; otherwise image alpha)
- background (optional)
- trimap (optional)

Parameters:

- preset: clean, natural, soft, or custom
- erode_px and dilate_px
- feather_px and guided_radius
- edge_decontaminate
- background_blend_strength
- engine: cpu (the only current engine)
- output_dir and output_name

Outputs:

- refined_image
- refined_mask
- edge_report

The trimap protects its unknown band from destructive morphology. Stored
workflows that request a retired local engine fail with an explicit error.

## Implementation

- apps/desktop-tauri/src-tauri/src/studio/edge_refine_cpu.rs
- apps/desktop-tauri/src-tauri/src/studio/edge_refine.rs

No inference runtime or model weight is required.
