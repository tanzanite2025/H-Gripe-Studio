# Planning Documents Index

This folder keeps roadmap documents out of the repository root.

Use it as the quick project-memory map:

- `active/` contains plans that still guide upcoming work.
- `completed/` contains retired implementation records kept for project history.
  They do not override current code, `docs/implementation-status.md`, design
  documents, or active plans.

## Active Plans

| Document | Purpose | Next Use |
| --- | --- | --- |
| [`active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md`](active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md) | Defines the Windows x64 professional camera-RAW architecture, R0-A probe contract, and R0-B evidence gate. R0-A, R0-B1, R0-B2a sensor evidence, and R0-B2b preflight/fingerprint tooling are implemented in [`../design/raw-probe-contract.md`](../design/raw-probe-contract.md) and [`../design/raw-r0-windows-evidence.md`](../design/raw-r0-windows-evidence.md). | Read before adding RAW extensions, decoder dependencies, ICC/DCP parsing, scene-linear surfaces, demosaic/develop controls, monitor transforms, or RAW export. Use R0-B2b on the licensed local corpus and independent reference records; do not vendor a decoder or expose RAW import before R0-C passes. |
| [`active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md) | Defines which concepts are allowed to become visible node cards, and which low-level primitives must live inside owning cards or canvas tools. | Use before adding/revising palette nodes, card bodies, preview/edit entry points, right-click actions, or runtime graph primitives. |
| [`active/CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md`](active/CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md) | Defines the performance-first clip keyframe/motion pipeline. Implementation Phases 1-5 have landed (#612, #616-#618): Rust/TS evaluation, export and preview property compositing, easing, timeline keyframe lane, hit targets, and reporting. Kept active only until native FFmpeg-backed evidence is captured. | Use before touching clip property evaluation, `timeline_export` frame passes, preview compositing of transform/crop/opacity, or before deciding whether the plan can be archived after repo-maintained FFmpeg LFS is restored. |
| [`active/COLOR_FEATURE_MASKING_PREPROCESS_PLAN.md`](active/COLOR_FEATURE_MASKING_PREPROCESS_PLAN.md) | Defines the future colour-space / feature-map preprocess layer for mask and matte work. | Do not implement before the Image Processing card, row ports, shared preview/editor entry points, backend selectors, and preview gate are structurally settled. |
| [`active/EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md`](active/EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md) | Defines the single-cut 45° chamfer wire style and edge visual states for the node canvas. Steps 1–9 and explicit bend points have landed; selected-area tidy routing remains. | Use before changing edge rendering, edge states, or connection-drag visuals in `@hgripe/flow`. |
| [`active/GPU_DEVICE_STRATEGY_PLAN.md`](active/GPU_DEVICE_STRATEGY_PLAN.md) | Defines device reporting, deeper device management, and the scoped surface-hole rule: zero-copy viewport presentation must not make app roots or shared modal shells transparent. The thin reporting track and D3D11VA-to-WGPU zero-copy implementation have landed: shared `DeviceReport`, node/viewport normalizers, UI badges/logs, capability summaries, adapter/hardware probes, registry diagnostics, texture import, and native viewport presentation. | Use for native-machine validation, fallback/runtime hardening, scoped modal/viewport surface work, or future cross-kernel scheduling. FFmpeg stays the repo-maintained vendored build under `third_party/ffmpeg`. |
| [`active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md) | Authoritative image-editor rendering protocol. The current landing has one stable resource target and pasteboard scene frame, bounded camera-window compositing, atomic `viewport_set_image_scene` document swaps, compact retained layer nodes, unclipped pasteboard drag with committed-scene handoff, same-frame `selectedLayerFrame` metadata, and exclusive native file-drop routing with ordered single-undo image batches. Native OS-drop evidence, sparse tiling, atomic Image Size, and the remaining acceptance work stay active. | Read first before changing image-editor pixels, layers, yellow frames, pan/zoom, layer drag, native file drops, Image Size, `Ctrl+J`, compositor targets, viewport presentation, pixel storage, or tiling. Do not restore multiple native drop listeners, document-only scene frames, dynamic scene frames, pasteboard-sized layer composites, move surfaces, hidden-layer retargeting, independent frame IPC, stale-frame retention, or clip-based positioning. |
| [`active/MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md`](active/MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md) | Defines the PS-style layer/mask target model required before Studio Action or agent-driven quick operations. | Use before changing mask creation, layer-mask UI, selection targets, deterministic selection actions, shared preview/editor action flow, or assistant action integration. |
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
  fallback/runtime hardening, scoped editor/modal surface holes, and future
  scheduling; its reporting and zero-copy implementation tracks are already
  landed, but zero-copy is not product-safe if it relies on app-root or shared
  modal-shell transparency.
- `NODE_CARD_PRODUCT_BOUNDARY_PLAN.md` is a living product guardrail rather
  than a finite implementation checklist.
- Image-editor rendering has one authority: the active shared-canvas protocol.
  The landed viewport keeps one resource target/host across document, camera,
  selection, and drag revisions. `viewport_set_image_scene` atomically swaps a
  prepared retained layer scene; `viewport_present_image_layer_scene` applies
  a sequenced in-memory layer transform; the matching viewport-frame payload
  carries `selectedLayerFrame` plus document/transaction/sequence identity.
  The retained scene spans the logical pasteboard while its camera renders a
  bounded visible window; pixels, document-normalized overlays, and the yellow
  frame remain aligned outside the document boundary. Drag preview and commit
  share one pasteboard-clamped delta, and the final draft remains until the
  committed scene/frame handoff settles. One app-level
  native file-drop listener routes exclusively to the topmost claimant; the
  editor owns its whole modal but imports ordered, single-undo batches only on
  its stage. The move surface, hidden-layer retarget, and separate frame IPC
  were deleted. Native OS-drop evidence, `Ctrl+J`, Image Size, tiling, and
  memory scaling still follow the remaining protocol gates; no old-frame,
  draft-frame, or geometry fallback is allowed.
- Colour-feature masking, mask/Studio Action targeting, page-context agent
  presets, and typography remain gated future work. Do not treat them as the
  next implementation task until each document's prerequisites are satisfied.
- Professional RAW development is now an active product direction. R0-A,
  R0-B1, R0-B2a canonical sensor evidence, and R0-B2b read-only
  preflight/fingerprinting have landed without product-loader integration. Real
  corpus/reference evidence and manual
  independence review still follow, and no RAW dependency or product extension
  is approved before the R0-C ownership record.

## Completed / Historical Plans

| Document | Historical Record | What It Records |
| --- | --- | --- |
| [`completed/LOCAL_REACT_FLOW_FORK_PLAN.md`](completed/LOCAL_REACT_FLOW_FORK_PLAN.md) | The local adapter, vendored source, product trimming, and graph optimizations landed. | The graph-ownership migration and its implementation sequence; current behavior is defined by code and active plans. |
| [`completed/NODE_CARD_CORNER_BADGE_PLAN.md`](completed/NODE_CARD_CORNER_BADGE_PLAN.md) | The `NodeCardShell` / `NodeTypeBadge` rollout landed. | The original badge geometry and registry rollout; current behavior is defined by code. |
| [`completed/DUAL_DOCK_WORKSPACE_PLAN.md`](completed/DUAL_DOCK_WORKSPACE_PLAN.md) | The two-dock direction was superseded by the unified production drawer. | Why the earlier workspace concept was replaced. |
| [`completed/VENDORED_E2E_INTEGRATION_PLAN.md`](completed/VENDORED_E2E_INTEGRATION_PLAN.md) | Earlier native FFmpeg, RGB ICC, Rust PSD, and grading integration work. | The old integration sequence; current dependency ownership is defined in [`rust-dependency-vendoring.md`](../design/rust-dependency-vendoring.md). |
| [`completed/STUDIO_PROJECT_MULTI_CANVAS_WORKSPACE_PLAN.md`](completed/STUDIO_PROJECT_MULTI_CANVAS_WORKSPACE_PLAN.md) | The multi-canvas tabs, project persistence, open-into-tab, and batch-run migration landed. | The project-workspace migration sequence and landed PRs. |
| [`completed/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md`](completed/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md) | The former mixed manager landed and its downloadable-engine tab was later retired. | The removed registry shape; the current product exposes API profiles only. |
| [`completed/NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](completed/NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md) | Mixed backend selectors landed and were later reduced to API or built-in choices. | The selector migration; current card boundaries live in [`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md). |
| [`completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md`](completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md) | The run-scope resolver and row/card/downstream affordances landed. | The original run-scope rollout and migration sequence. |
| [`completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md`](completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md) | The first assistant launcher, panel, insertion flow, and legacy prompt cleanup landed. | The original assistant UI rollout, not a current backend-management contract. |
| [`completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md`](completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md) | The short-term split-to-layers phases landed. | The layered-asset migration; this historical document does not schedule tracking or inference work. |
| [`completed/PS_TOOLBAR_PARITY_PLAN.md`](completed/PS_TOOLBAR_PARITY_PLAN.md) | The PS slot registry, shortcuts, flyouts, and contextual options landed. | The original toolbar migration and acceptance criteria. |
| [`completed/WGPU_SURFACE_SWAP_PLAN.md`](completed/WGPU_SURFACE_SWAP_PLAN.md) | The native surface transport migration landed; older image-editor presentation notes were superseded. | Transport history only; current platform and viewport rules live in [`GPU_DEVICE_STRATEGY_PLAN.md`](active/GPU_DEVICE_STRATEGY_PLAN.md) and [`IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md). |
| [`completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md) | The generic heavy-pixel viewport migration landed; its older image-editor design was superseded. | Generic viewport migration history only; current rules live in the active GPU and image-editor plans. |
| [`completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md) | The mixed API/downloadable-engine manager was later retired in favor of API profiles. | The removed manager migration; current API-first boundaries live in [`implementation-status.md`](../implementation-status.md). |
| [`completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md`](completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md) | The production drawer and later media/export extensions landed. | The drawer migration; this historical document does not schedule grade animation work. |

## Rule For New Plans

New planning documents should start in `active/`.

When a plan lands, is replaced, or becomes historical context, move it to
`completed/` and update this index in the same commit.
