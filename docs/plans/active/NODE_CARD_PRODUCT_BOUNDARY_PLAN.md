# Node Card Product Boundary Plan

Status: active. Updated 2026-07-16.

## Boundary

Node cards expose product intent, not implementation inventory.

- Deterministic native cards expose only their built-in modes.
- API-backed cards select a configured API profile with the required
  capability.
- Cards never expose local weight paths, runtime providers, or unavailable
  engine choices.
- Legacy local references remain readable for migration but cannot execute.

## Card Rules

1. Inputs and outputs describe artifacts and structured reports.
2. Parameters describe user-visible behavior.
3. Provider credentials and base URLs stay in API profile management.
4. A card stores a stable profile reference, not a copied profile.
5. Missing or incompatible profiles block execution with a precise error.
6. Built-in deterministic behavior is never labeled as AI.

## Current Examples

| Card | Backend boundary |
| --- | --- |
| Generate | API profile |
| Detail Repaint | API profile |
| Prompt Optimize | Built-in text normalization or API profile |
| Match Light & Color | deterministic Rust CPU |
| Subject Mask / Refine / Enhance / Watchdog | deterministic Rust CPU |
| Grade / viewport | deterministic CPU with optional WGPU acceleration |

## Acceptance

- No visible inference-runtime tab or downloadable-engine selector remains.
- API profile selectors filter by capability.
- Saved retired local references surface unavailable/retired, not fallback.
- Run reports distinguish API, CPU, WGPU, and FFmpeg execution truthfully.
