# Image Processing And Quality Roadmap

Updated 2026-07-16 after the API-first scope correction.

## Rules

1. Native Rust owns deterministic pixel, mask, PSD, grading, and media work.
2. Model-backed and generative work uses an API profile.
3. The desktop build does not download or execute model weights.
4. A stored retired local engine reference must fail clearly; it must not be
   translated into a different algorithm.
5. Windows is the only product target.

## Current Native Baselines

| Capability | Native implementation |
| --- | --- |
| Image enhance | Median denoise, linear-light resize, unsharp detail, alpha resize |
| Detail watchdog | Blur, resolution, soft-region, edge-halo, and colour mismatch rules |
| Match light and colour | Lab transfer, histogram match, tone and saturation protection |
| Subject mask | Border-colour separation, connected components, point and placeholder constraints |
| Alpha matte | Trimap construction plus image-guided filtering |
| Refine edge | Morphology, guided filtering, feather, decontamination, background blend |

These baselines are complete enough to run without network access and remain
deterministic for identical inputs.

## API Quality Tiers

Quality tiers that require learned restoration, semantic detection, semantic
harmonization, subject understanding, inpainting, or generation must be
represented as explicit API capabilities. A card binds an API profile by
stable reference; it does not store credentials or a local weight path.

API execution must preserve:

- capability validation before dispatch
- cancellation and structured task history
- provider error reporting
- stable artifact outputs
- explicit distinction between API results and deterministic native results

## Future GPU Work

Windows NVIDIA/CUDA and AMD/Intel compatibility remain required for GPU kernels
and media acceleration where there is a concrete consumer. The next work is:

1. Improve WGPU adapter selection and diagnostics.
2. Validate FFmpeg hardware decode/encode on real NVIDIA, AMD, and Intel hosts.
3. Add per-operation device reports and deterministic software fallback.
4. Add hardware CI or a documented manual verification matrix.

This roadmap does not reserve a runtime for hypothetical inference.
