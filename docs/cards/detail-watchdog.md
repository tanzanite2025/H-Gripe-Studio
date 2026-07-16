# Detail Watchdog

Detail Watchdog is a deterministic, detect-only Rust card. It checks blur,
insufficient resolution, soft regions, alpha-edge halos, and subject/background
colour mismatch. It never downloads weights or runs an inference runtime.

## Contract

Inputs:

- image (required)
- visual_context (optional)
- target_bounds (optional)

Parameters:

- mode: strict, balanced, or lenient
- watch_targets: face, hands, text, logo, product_edges
- engine: rules (the only current engine)
- output_dir and output_name

The hands, text, and logo targets are reported as skipped because the rule layer
cannot claim semantic detection. Model-backed quality checks belong behind an
API profile when the product adds them.

Outputs:

- fixed_image: the unchanged candidate
- quality_report: status plus structured issues
- issue_masks: optional red-box overlay
- watchdog_report: thresholds, skipped targets, decode metadata, and engine
  telemetry

Stored workflows that request a retired engine fail with an explicit retired
engine error. They are not silently changed to the rules engine.

## Implementation

- apps/desktop-tauri/src-tauri/src/studio/detail_watchdog_cpu.rs
- apps/desktop-tauri/src-tauri/src/studio/detail_watchdog.rs
- apps/desktop-tauri/src-tauri/src/psd/cards.rs

The shared hardened image loader applies decode limits and EXIF orientation.
The rule result is deterministic for identical pixels and parameters.
