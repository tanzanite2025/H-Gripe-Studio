# Image Enhance

Image Enhance is a deterministic native Rust resize and detail pipeline. It
uses median denoise, linear-light resampling, unsharp detail recovery, and an
independent alpha-resize track.

## Contract

Input:

- image (required)
- target_bounds (optional)

Parameters:

- mode: conservative, texture_rebuild, or custom
- target_width and target_height
- scale
- max_pixels
- denoise_strength and texture_strength
- preserve_text_logo
- engine: cpu (the only current engine)
- output_dir and output_name

Outputs:

- enhanced_image
- scale_factor
- enhance_report

The report records source/output size, clamp decisions, applied strengths,
decode metadata, and the requested engine. Stored workflows that request a
retired local engine fail explicitly instead of receiving a CPU substitute.

## Implementation

- apps/desktop-tauri/src-tauri/src/studio/image_enhance_cpu.rs
- apps/desktop-tauri/src-tauri/src/studio/image_enhance.rs

The card does not perform generative restoration. Model-backed restoration is
an API-profile concern and must use the API execution lane.
