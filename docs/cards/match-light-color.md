# Match Light & Color

Match Light & Color is a deterministic native Rust card. It aligns a subject
with a connected background using Lab statistics, histogram matching, tone
protection, saturation protection, and a brand-colour guard.

## Contract

Inputs:

- image (required)
- background (optional)
- mask (optional)
- visual_context (optional)

Parameters:

- mode: prompt_only, color_transfer, histogram_match, or hybrid
- strength
- shadow_strength and highlight_strength
- protect_saturation
- protect_brand_color
- engine: cpu (the only current engine)
- output_dir and output_name

Outputs:

- matched_image
- match_report
- prompt_suffix

Without a background the image passes through and the report states why.
Stored workflows that request a retired local engine fail explicitly; the
backend does not silently reinterpret the request as CPU.

## Implementation

- apps/desktop-tauri/src-tauri/src/studio/color_match_cpu.rs
- apps/desktop-tauri/src-tauri/src/studio/color_match.rs
- apps/desktop-tauri/src-tauri/src/psd/cards.rs

All pixel processing is bounded by the shared decode guard and remains fully
available without downloaded assets.
