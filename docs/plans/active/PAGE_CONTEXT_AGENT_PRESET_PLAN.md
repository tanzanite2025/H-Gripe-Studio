# Page Context Agent Preset Plan

Status: active. Updated 2026-07-16.

## Goal

Provide assistants with a small, page-specific action surface instead of the
entire application command inventory.

## Contexts

| Page | Allowed action families |
| --- | --- |
| Workflow | inspect graph, connect nodes, run selected scope |
| Image editor | inspect layers, selections and masks; run deterministic edit actions |
| PSD production | inspect card reports, run native chain, invoke configured API repaint |
| API settings | inspect and validate API profiles |
| Media | inspect clips, scrub, grade, trim and export |

## Backend Selection

Assistants may select configured API profiles for API-capable actions. The
context never exposes raw credentials. There is no executable local-model
registry in the current product.

## Mask And Selection Actions

Image-editor presets may use wand, marquee, lasso, pen/path, brush, point
constraints, morphology, and guided-filter matting. Semantic selection is a
future API action that returns a preview artifact before commit.

## Safety

- Resolve document, layer, and target ids explicitly.
- Validate the document revision before commit.
- Keep API calls cancellable and recorded in task history.
- Do not silently replace a retired action or backend.
- Do not let a page preset broaden filesystem or provider authority.

## Acceptance

- Each page exposes only relevant actions.
- Native actions work offline.
- API actions require a compatible configured profile.
- Retired local-engine references return a clear unavailable error.
