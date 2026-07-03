# Planning Documents Index

This folder keeps roadmap documents out of the repository root.

Use it as the quick project-memory map:

- `active/` contains plans that still guide upcoming work.
- `completed/` contains implemented, superseded, or historical plans kept for
  fast project回溯.

## Active Plans

| Document | Purpose | Next Use |
| --- | --- | --- |
| [`active/UNIFIED_PRODUCTION_DRAWER_PLAN.md`](active/UNIFIED_PRODUCTION_DRAWER_PLAN.md) | Defines the unified production workspace: node canvas as source, bottom drawer for Edit/Timeline + Grade, image/audio editors opened on demand. | Main product direction for timeline, grading, image/audio entry points, and `ProductionTarget`. |
| [`active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md) | Defines which concepts are allowed to become visible node cards, and which low-level primitives must live inside owning cards or canvas tools. | Use before adding/revising palette nodes, card bodies, right-click actions, or runtime graph primitives. |
| [`active/PROMPT_ASSISTANT_SYSTEM_PLAN.md`](active/PROMPT_ASSISTANT_SYSTEM_PLAN.md) | Defines the software-level prompt assistant, right-rail placement, prompt sessions, and insertion into graph nodes. | Use before building prompt chat, prompt drafting, or prompt insertion UI. |
| [`active/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](active/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md) | Defines global API profile management and local model management, including refs, capabilities, credentials, and card integration. | Use before adding API settings, local model settings, or model/profile selectors to cards and assistants. |
| [`active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md`](active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md) | Defines flat image -> editable layered asset -> model/grade/timeline/PSD export. | Next PR should be protocol bridge first: `LayeredImageAsset`, `layered_image`, `image_layer`, and node ports. |
| [`active/GPU_DEVICE_STRATEGY_PLAN.md`](active/GPU_DEVICE_STRATEGY_PLAN.md) | Defines thin device reporting now and deeper device management later. | Normalize requested/used/fallback reporting before any full scheduler. |
| [`active/UI_TYPOGRAPHY_SYSTEM_PLAN.md`](active/UI_TYPOGRAPHY_SYSTEM_PLAN.md) | Defines bilingual typography, font fallback, and dark UI type tokens. | Use before restyling the app shell, node cards, drawer, and editor panels. |
| [`active/VENDORED_E2E_INTEGRATION_PLAN.md`](active/VENDORED_E2E_INTEGRATION_PLAN.md) | Tracks vendored FFmpeg/moxcms/Rust PSD and end-to-end runtime ownership. | Continue `hgripe-grade`, ONNX helper, FFmpeg, and colour-pipeline integration. |
| [`active/PS_TOOLBAR_PARITY_PLAN.md`](active/PS_TOOLBAR_PARITY_PLAN.md) | Preserves Photoshop-style toolbar muscle memory for the image/PSD editor. | Use when implementing or revising toolbar slots, flyouts, shortcut badges, and tool options. |

## Completed / Historical Plans

| Document | Status | Why Keep It |
| --- | --- | --- |
| [`completed/PYTHON_TO_RUST_MIGRATION_PLAN.md`](completed/PYTHON_TO_RUST_MIGRATION_PLAN.md) | Complete after Phase 7: Python runtime and `third_party/psd_tools` removed from the core app. | Explains why new work must not reintroduce Python as a default runtime. |
| [`completed/NODE_CARD_CORNER_BADGE_PLAN.md`](completed/NODE_CARD_CORNER_BADGE_PLAN.md) | Implemented via `NodeCardShell` / `NodeTypeBadge`. | Freezes the node-card badge geometry contract. |
| [`completed/DUAL_DOCK_WORKSPACE_PLAN.md`](completed/DUAL_DOCK_WORKSPACE_PLAN.md) | Superseded by the unified bottom production drawer. | Historical context for why two docks became one production drawer with optional side handles. |

## Rule For New Plans

New planning documents should start in `active/`.

When a plan lands, is replaced, or becomes historical context, move it to
`completed/` and update this index in the same commit.
