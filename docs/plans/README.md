# Planning Documents Index

This folder keeps roadmap documents out of the repository root.

Use it as the quick project-memory map:

- `active/` contains plans that still guide upcoming work.
- `completed/` contains implemented, superseded, or historical plans kept for
  fast project回溯.

## Active Plans

| Document | Purpose | Next Use |
| --- | --- | --- |
| [`active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md) | Defines which concepts are allowed to become visible node cards, and which low-level primitives must live inside owning cards or canvas tools. | Use before adding/revising palette nodes, card bodies, preview/edit entry points, right-click actions, or runtime graph primitives. |
| [`active/CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md`](active/CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md) | Defines the performance-first clip keyframe/motion pipeline. Implementation Phases 1-5 have landed (#612, #616-#618): Rust/TS evaluation, export and preview property compositing, easing, timeline keyframe lane, hit targets, and reporting. Kept active only until native FFmpeg-backed evidence is captured. | Use before touching clip property evaluation, `timeline_export` frame passes, preview compositing of transform/crop/opacity, or before deciding whether the plan can be archived after repo-maintained FFmpeg LFS is restored. |
| [`active/COLOR_FEATURE_MASKING_PREPROCESS_PLAN.md`](active/COLOR_FEATURE_MASKING_PREPROCESS_PLAN.md) | Defines the future colour-space / feature-map preprocess layer for mask and matte work. | Do not implement before the Image Processing card, row ports, shared preview/editor entry points, backend selectors, and preview gate are structurally settled. |
| [`active/EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md`](active/EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md) | Defines the single-cut 45° chamfer wire style and edge visual states for the node canvas. Steps 1–9 and explicit bend points have landed; selected-area tidy routing remains. | Use before changing edge rendering, edge states, or connection-drag visuals in `@hgripe/flow`. |
| [`active/GPU_DEVICE_STRATEGY_PLAN.md`](active/GPU_DEVICE_STRATEGY_PLAN.md) | Defines device reporting and deeper device management. The thin reporting track and D3D11VA-to-WGPU zero-copy implementation have landed: shared `DeviceReport`, node/viewport normalizers, UI badges/logs, capability summaries, adapter/hardware probes, registry diagnostics, texture import, and native viewport presentation. | Use for native-machine validation, fallback/runtime hardening, or future cross-kernel scheduling. FFmpeg stays the repo-maintained vendored build under `third_party/ffmpeg`. |
| [`active/MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md`](active/MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md) | Defines the PS-style layer/mask target model required before Studio Action or agent-driven quick operations. | Use before changing mask creation, layer-mask UI, selection targets, SAM 2 action calls, shared preview/editor action flow, or Goose/assistant action integration. |
| [`active/PAGE_CONTEXT_AGENT_PRESET_PLAN.md`](active/PAGE_CONTEXT_AGENT_PRESET_PLAN.md) | Defines one assistant runtime with page-specific presets, read scopes, and Studio Action whitelists. | Use before adding per-page assistant modes, preview/editor agent actions, Goose adapters, or agent-callable editor/canvas/model actions. |
| [`active/UI_TYPOGRAPHY_SYSTEM_PLAN.md`](active/UI_TYPOGRAPHY_SYSTEM_PLAN.md) | Defines bilingual typography, font fallback, and dark UI type tokens. | Use before restyling the app shell, node cards, drawer, and editor panels. |

### Active-plan audit (2026-07-09)

- No active plan is fully obsolete, so none was deleted.
- `CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md` is implementation-complete but remains
  active until native preview/export evidence can be captured with the
  repository-maintained FFmpeg LFS binaries.
- `EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md` remains active only for
  hover/running/error states and optional explicit bend/tidy routing; path
  caching and LOD are already landed.
- `GPU_DEVICE_STRATEGY_PLAN.md` remains active for native-machine validation,
  fallback/runtime hardening, and future scheduling; its reporting and
  zero-copy implementation tracks are already landed.
- `NODE_CARD_PRODUCT_BOUNDARY_PLAN.md` is a living product guardrail rather
  than a finite implementation checklist.
- Colour-feature masking, mask/Studio Action targeting, page-context agent
  presets, and typography remain gated future work. Do not treat them as the
  next implementation task until each document's prerequisites are satisfied.

## Completed / Historical Plans

| Document | Status | Why Keep It |
| --- | --- | --- |
| [`completed/LOCAL_REACT_FLOW_FORK_PLAN.md`](completed/LOCAL_REACT_FLOW_FORK_PLAN.md) | Complete: Studio imports graph APIs through the local `@hgripe/flow` adapter, the pinned XYFlow source is vendored, unused upstream surfaces were trimmed, and H-Gripe edge/LOD optimizations landed. | Freezes the graph ownership boundary; use before upgrading the vendored XYFlow snapshot or considering a deeper renderer. |
| [`completed/PYTHON_TO_RUST_MIGRATION_PLAN.md`](completed/PYTHON_TO_RUST_MIGRATION_PLAN.md) | Complete after Phase 7: Python runtime and `third_party/psd_tools` removed from the core app. | Explains why new work must not reintroduce Python as a default runtime. |
| [`completed/NODE_CARD_CORNER_BADGE_PLAN.md`](completed/NODE_CARD_CORNER_BADGE_PLAN.md) | Implemented via `NodeCardShell` / `NodeTypeBadge`. | Freezes the node-card badge geometry contract. |
| [`completed/DUAL_DOCK_WORKSPACE_PLAN.md`](completed/DUAL_DOCK_WORKSPACE_PLAN.md) | Superseded by the unified bottom production drawer. | Historical context for why two docks became one production drawer with optional side handles. |
| [`completed/VENDORED_E2E_INTEGRATION_PLAN.md`](completed/VENDORED_E2E_INTEGRATION_PLAN.md) | Complete: native FFmpeg, moxcms 16-bit pipeline, Rust PSD subset, and `hgripe-grade` (image/video/timeline grading, temporal denoise, `.cube` import/export) are all integrated end-to-end (#390). ONNX small-model expansion continues under its own roadmap. | Freezes which vendored libraries are runtime cores vs. build snapshots; use before forking or deep-integrating a new library. |
| [`completed/STUDIO_PROJECT_MULTI_CANVAS_WORKSPACE_PLAN.md`](completed/STUDIO_PROJECT_MULTI_CANVAS_WORKSPACE_PLAN.md) | Complete after Phase 5: multi-canvas tabs, project manifest persistence, open-into-tab, and project-level batch run (PRs #382–#387). | Freezes the project/canvas/toolbar command hierarchy; use before changing New/Open/Save behavior, canvas tabs, or toolbar grouping. |
| [`completed/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md`](completed/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md) | Complete: global Models / APIs manager, persistent ref registry, capability-filtered selector APIs, and card selectors (PRs #393–#395). | Freezes the two-tab manager surface and the registry/selector contract; use before adding model/API configuration UI anywhere else. |
| [`completed/NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](completed/NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md) | Complete: leaf cards and Image Processing rows select managed backends via capability-filtered selectors, legacy raw fields moved behind the advanced disclosure, refs validated before runs (PRs #394–#397). | Freezes how cards reference manager-owned backends; use before changing any card's model/API dropdown behavior. |
| [`completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md`](completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md) | Complete: `RunScope` + scope resolver, row/card/run-to/selection/downstream run affordances, row-scoped ref validation, and pre-execution run reports (PRs #402–#405). | Freezes the run-scope vocabulary and affordance placement; use before adding any execution-zone or trigger-node feature. |
| [`completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md`](completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md) | Complete: all nine implementation steps landed (PRs #521–#526), plus the draggable always-on-top eyes launcher/panel (#527–#530); the legacy `prompt` primitive was removed. | Freezes the software-level assistant boundary (panel vs. `Prompt` card vs. managers); use before changing prompt drafting, insertion, or assistant UI. |
| [`completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md`](completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md) | Complete for the short-term path: Phases 0–5 landed, ending with the timeline clip "Split to layers" entry (#519). Object tracking / cross-frame masks stay future work. | Freezes the `LayeredImageAsset` protocol and split/review pipeline; use before extending layered assets or the split node. |
| [`completed/PS_TOOLBAR_PARITY_PLAN.md`](completed/PS_TOOLBAR_PARITY_PLAN.md) | Complete: PS slot registry, Mask Ops group, slot-owned shortcuts, flyouts, and contextual tool options with registry tests. | Freezes Photoshop-muscle-memory toolbar behavior; use when revising toolbar slots, shortcuts, or tool options. |
| [`completed/WGPU_SURFACE_SWAP_PLAN.md`](completed/WGPU_SURFACE_SWAP_PLAN.md) | Complete: all viewport consumers present natively via the WGPU surface swap; PNG/blob remains the browser-preview and no-adapter fallback. | Freezes the viewport presentation transport boundary; use before touching frame presentation or the host command protocol. |
| [`completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md) | Complete: Phases 0–5 plus the surface swap, host-side overlays, scopes/safe-area, and shared `DeviceReport` wiring all landed; heavy pixels present through WGPU viewports. | Freezes the viewport host boundary (targets, transport, overlays); read together with `active/GPU_DEVICE_STRATEGY_PLAN.md`. |
| [`completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md) | Complete: migration steps 1–8 landed (#393–#397, #522–#523); managers, capability-filtered selectors, card refs, and the Prompt Assistant consume `ModelBackendRef`. | Freezes the manager/ref/capability contract; use before adding any model- or API-consuming card or capability row. |
| [`completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md`](completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md) | Complete: stage-one steps 1–9 landed (PRs #294–#300), and later work added video-clip export, audio mixdown/AAC mux, clip property keyframes, direct media import, monitor frame export, and loop playback. Grade-parameter keyframe animation remains future work. | Freezes the drawer/workspace/selection hierarchy; use before adding drawer tabs, editors, or export entry points. |

## Rule For New Plans

New planning documents should start in `active/`.

When a plan lands, is replaced, or becomes historical context, move it to
`completed/` and update this index in the same commit.
