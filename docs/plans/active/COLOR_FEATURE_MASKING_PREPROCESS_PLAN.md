# Colour-Feature Masking Preprocess Plan

Status: active. Updated 2026-07-16.

## Goal

Improve deterministic subject/background separation before colour matching,
mask refinement, and compositing. The local pipeline must remain weight-free.
Semantic interpretation, when required, is an explicit API capability.

## Native Pipeline

1. Convert the hardened sRGB analysis surface to luminance and perceptual
   colour features.
2. Build edge, saturation, alpha, and border-background priors.
3. Seed foreground from user points, placeholder bounds, an existing mask, or
   connected-component evidence.
4. Run deterministic region growth/graph-cut style refinement.
5. Fill holes, remove small components, and preserve user exclusions.
6. Build a trimap and resolve the unknown band with the guided-filter matte.
7. Return the mask plus confidence and diagnostic layers.

## API Boundary

If colour and geometry cannot disambiguate the intended subject, an API-backed
semantic selection action may return hints or a mask artifact. It must:

- bind a configured API profile
- be visibly distinct from native deterministic selection
- preserve the user's points/path/box as constraints
- return an artifact that the normal mask editor can inspect and modify

No native card scans model folders or downloads weights.

## Acceptance

- Identical inputs and parameters produce identical native masks.
- Positive and negative point constraints are respected.
- Placeholder and prior-mask bounds cannot be escaped.
- Large inputs obey decode and working-resolution limits.
- API failure never mutates the existing mask.
