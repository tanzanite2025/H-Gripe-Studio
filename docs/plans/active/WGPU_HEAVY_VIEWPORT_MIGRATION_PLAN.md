# WGPU Heavy Viewport Migration Plan

> Status: active planning document. This is the near-term direction for heavy
> visual surfaces. It does not require rewriting the whole React UI, but it does
> require starting the WGPU viewport boundary now so image edit, grading, and
> video preview do not become throwaway DOM/canvas implementations.

## Status Snapshot (2026-07)

Implemented (PRs #329–#371):

- Phase 0 (contract and safety): complete. Graph state stores references and
  operation documents; no startup probes or startup viewports; ingest caches
  and the resource registry are bounded.
- Phase 1 (host skeleton): complete. `WgpuViewportHost` + `viewport_*` Tauri
  commands (create / destroy / set_target / resize / set_grade / set_view /
  render_frame), mocked transport in browser preview, lifecycle logging, and
  a hard cap on simultaneously open viewports.
- Phase 2 (image edit): mostly complete. Underlay presentation flows through
  `image_edit` viewports by resource reference; zoom/pan is viewport state
  with shared view math (`viewport/view.ts`) and a shared interaction hook
  (`viewport/useViewControls.ts`); zoomed views decode the source proxy at
  higher detail. Remaining: mask overlay and brush preview still render in a
  2D canvas (see below).
- Phase 3 (grade preview): complete. Image and video-frame grading share the
  `hgripe-grade` kernel through `grade_preview` viewports; GPU with CPU
  reference fallback; per-viewport proxy cache so slider drags re-run only
  the kernel; actual backend reported in the UI.
- Phase 4 (video preview): complete. Frames decode through the Rust media
  engine; the program monitor renders through a `video_preview` viewport with
  per-clip grade docs, latest-wins seek coalescing, play/pause playback, and
  a bounded per-viewport LRU proxy cache. Hook contracts are pinned by tests
  (`useViewportUnderlay`, `useVideoPreview`).
- Phase 5 (export alignment): complete. Timeline export reuses the render
  plan and per-clip `GradeDoc`s at encode time and reports graded frame count
  and grade backend; kernel golden tests keep CPU/GPU parity, and a
  pipeline-level test asserts export output matches the viewport preview
  within a defined tolerance.
- Host-side `image_layer` targets: layered assets register their layer
  artifacts with the viewport host by path
  (`viewport_register_layered_asset`), so `image_layer` viewport targets
  resolve Rust-side like image resources — same proxy cache, grade, and view
  path. The layer review preview presents the selected layer cutout as an
  `image_layer` target of the registered asset (mask/composite artifacts
  still register by path).
- Host-side `video_clip` targets: timelines register their clips by media
  path plus placement (`viewport_register_timeline`), so `video_clip`
  viewport targets resolve Rust-side — the host maps the timeline playhead
  to clip-local source time and renders stills through the image path and
  video clips through the same decode path as `video_frame`. The program
  monitor registers the first video track's clips and presents playhead
  frames as `video_clip` targets, falling back to webview-resolved media
  targets while registration is pending or unavailable.
- Host-side `node_output` targets: node runs register their image artifact
  by path (`viewport_register_node_output`, keyed by node id + optional
  output port), so `node_output` viewport targets resolve Rust-side through
  the same image render path. The grade tab presents node-output previews
  as `node_output` targets (the connected image path registers as the
  node's output artifact, not as a plain image resource). All viewport
  target kinds now resolve host-side.

Remaining work, roughly in priority order:

1. Native texture presentation: frames still cross the host boundary as PNG
   data URLs into an `<img>`. Replace with a real WGPU surface/texture swap
   on desktop (readback only when needed); the host command protocol already
   isolates callers from this change.
2. Mask editor presentation: `MaskEditModal` paints underlay + mask overlay +
   brush preview in a 2D canvas with CSS-transform zoom; the underlay decodes
   at fixed detail, so deep zoom is soft. Move overlay/brush presentation to
   the viewport and tie underlay detail to canvas zoom without changing the
   recorded pixel space.
3. Remaining target wiring: the node-card grade modal and the mask/crop
   editors still address their sources by path — move them onto reference
   targets so the selection-target model is uniform in the product layer
   too.
4. Scopes and overlays: safe area, crop box, and scopes surfaces on top of
   the viewport presentation (listed under "future overlays").

## Purpose

H-Gripe Studio should not wait until the product is large before moving heavy
visual rendering to a GPU viewport. The risky surfaces are already visible:

- image editor canvas: zoom, pan, brush preview, mask overlay, layer compositing
- grade preview: image grade and video frame grade should share the same kernel
- video preview: decoded frames, timeline preview, grade application, frame cache

The correct direction is:

```text
React / Tauri app shell
  -> product UI, panels, forms, menus, tabs, shortcuts
Rust resource and compute layer
  -> files, FFmpeg, image buffers, grade kernel, cache, scheduling
WGPU viewport layer
  -> heavy pixels, textures, overlays, preview rendering, GPU readback only when needed
```

This keeps the current development speed while preventing the heavy media parts
from being rebuilt later.

## Core Decision

Start WGPU migration now for heavy viewports.

Do not rewrite the whole application into a pure Rust UI. Regular product UI
still belongs in React:

- toolbars
- parameter panels
- dropdowns
- API / local model settings
- project panels
- node cards
- context menus
- modal shells
- inspector-like on-demand settings

WGPU owns the surfaces where pixels move, composite, preview, or scrub.

## Strategic Principle: Build A Real Barrier

This migration is not about using a more fashionable rendering stack. It is
about moving H-Gripe Studio away from shallow "open-source library glue" and
toward product depth that is hard to copy quickly.

Open-source libraries are useful foundations, but they should not be the
product moat by themselves. A tool that can be recreated by wiring together a
workflow canvas, a few React panels, and generic image/video packages is too
easy to clone.

The moat should live in the parts that require sustained engineering:

- stable resource references instead of pixel payloads in UI state
- Rust-owned media, image, layer, and timeline resource lifecycles
- WGPU heavy viewports with explicit creation/destruction and bounded caches
- one shared grade kernel for image, layer, and video clip color
- FFmpeg decode/encode integration that is locally controlled and tested
- layered asset protocol, selection target, and node port compatibility
- deterministic CPU fallback and visible GPU/backend reporting
- large-project behavior: many assets, many nodes, undo/autosave, no slow creep

The goal is not to avoid libraries. The goal is to make libraries replaceable
implementation details behind H-Gripe-owned contracts.

## What Moves To WGPU First

### 1. Image Edit Viewport

React keeps:

- modal / panel shell
- toolbar buttons
- tool option panels
- layer list
- action buttons

WGPU owns:

- image underlay texture
- mask overlay texture
- brush cursor and brush preview
- zoom / pan presentation
- checkerboard / transparency background
- layer compositing preview
- lasso / pen / crop overlays where performance matters

The edit document remains a lightweight operation document. Do not place pixels
or base64 previews in React node state.

### 2. Grade Preview Viewport

React keeps:

- grade operation list
- sliders
- LUT file selection UI
- apply / reset / preset controls

WGPU owns:

- preview texture
- grade preview rendering
- scopes input surface when practical
- image and video frame preview using the same grade path

The `hgripe-grade` kernel remains the mathematical source of truth. WGPU is the
interactive preview and accelerated render path, with CPU as reference and
fallback.

### 3. Video Preview Viewport

React keeps:

- timeline controls
- clip selection
- playhead UI
- trim handles
- context menus

Rust / FFmpeg owns:

- decode
- seek
- frame extraction
- frame cache
- encode / mux for export

WGPU owns:

- frame texture upload
- display transform
- grade preview on video frames
- timeline/program monitor presentation
- future overlays such as safe area, crop box, masks, and scopes

## What Does Not Move First

### Node Canvas

The node canvas can stay on XYFlow in the short term. The urgent work is to
isolate it behind a Studio-owned adapter so future replacement is possible.

Rules:

- product code should not spread direct XYFlow assumptions everywhere
- node data must stay lightweight
- node cards should render production-level semantic cards, not tiny primitive
  math cards
- heavy preview resources must be references, not pixel payloads
- LOD and lazy thumbnail loading remain required

Move the node canvas to WGPU only after a measured bottleneck proves XYFlow is
the limiting layer.

## Required Architecture Boundaries

### Viewport Host

Introduce a stable host boundary before replacing individual editors:

```ts
type ViewportKind = "image_edit" | "grade_preview" | "video_preview";

type ViewportTarget =
  | { kind: "image"; resourceId: string }
  | { kind: "image_layer"; assetId: string; layerId: string }
  | { kind: "video_clip"; timelineId: string; clipId: string; timeSec: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string };

type ViewportCommand =
  | { kind: "set_target"; target: ViewportTarget }
  | { kind: "set_grade_doc"; gradeDoc: string }
  | { kind: "set_edit_doc"; editDoc: unknown }
  | { kind: "set_view"; zoom: number; panX: number; panY: number }
  | { kind: "set_playhead"; timeSec: number };
```

The exact implementation can change, but the product layer should talk to a
viewport host, not directly to raw texture code.

### Resource Protocol

Heavy surfaces must resolve through resource references:

```text
ResourceId / AssetId / LayerId / ClipId
  -> Rust resource registry
  -> image buffer / decoded frame / layer artifact
  -> WGPU texture handle
  -> viewport presentation
```

Do not pass large `data:` URLs or decoded pixel arrays through React state for
normal desktop operation.

### Selection Target

The WGPU viewport must consume the same target model as the production drawer:

- image asset
- layered image
- image layer
- video clip
- audio clip for timeline context, though audio rendering is separate
- node output

This prevents the image editor, grade tab, video preview, and timeline from
inventing separate identity systems.

### CPU Fallback

Every WGPU path needs a fallback contract:

```text
requested backend: auto | gpu | cpu
actual backend: wgpu | cpu
fallback reason: optional text
```

Fallback is not failure. It is a reportable runtime decision.

## Implementation Order

### Phase 0: Contract And Safety

Goal: make it impossible for heavy data to leak into graph state while WGPU work
starts.

Tasks:

1. Document that graph nodes store only lightweight references and operation
   documents.
2. Keep `LayeredImageAsset` manifests path-based and avoid embedded previews.
3. Add or confirm cache limits for frontend ingest state and resource registry.
4. Make editor modals and production drawer load heavy editors only on demand.
5. Stop automatic model / engine probes from always-mounted UI.

Exit criteria:

- opening the app does not probe models
- opening the app does not initialize image/video edit viewports
- node autosave and undo do not include pixel payloads

### Phase 1: WGPU Viewport Host Skeleton

Goal: create the host boundary with a minimal texture display path.

Tasks:

1. Add a `WgpuViewportHost` abstraction on the frontend boundary.
2. Add Rust commands or Tauri events for viewport lifecycle:
   - create viewport
   - destroy viewport
   - set target
   - resize
   - render frame
3. Decide the first transport:
   - browser preview can keep a mocked canvas
   - desktop uses the native WGPU-backed path
4. Add logging for viewport creation / destruction.

Exit criteria:

- a single image resource can be displayed through the new host
- closing the editor destroys the viewport state
- no editor viewport is created at app startup

### Phase 2: Image Edit Viewport

Goal: replace the heaviest image editor display path first.

Tasks:

1. Move underlay presentation from React image / canvas to WGPU texture.
2. Move zoom and pan to viewport state.
3. Draw mask overlay and brush preview in WGPU.
4. Keep edit operations as the existing lightweight document.
5. Keep React toolbar and panels unchanged where possible.

Exit criteria:

- image edit opens on demand
- zoom / pan / brush preview stays responsive on large images
- React state does not hold the underlay as a large `data:` URL
- closing image edit releases viewport resources

### Phase 3: Grade Preview Viewport

Goal: make image and video grading preview share the same GPU presentation path.

Tasks:

1. Feed `GradeDoc` into the WGPU preview path.
2. Use `hgripe-grade` as the shared CPU/GPU math contract.
3. Keep CPU reference output for tests and fallback.
4. Cache pipelines and intermediate preview textures for slider dragging.
5. Report actual backend in the UI/run result.

Exit criteria:

- image grade preview uses WGPU when available
- video frame grade preview uses the same grade document path
- CPU fallback is visible
- slider interaction does not rebuild avoidable state every tick

### Phase 4: Video Preview Viewport

Goal: connect FFmpeg frame decode to WGPU presentation.

Tasks:

1. Decode or seek frames through the Rust media engine.
2. Upload frames to WGPU textures.
3. Apply grade preview to the displayed frame.
4. Keep a bounded frame cache.
5. Ensure timeline scrubbing coalesces requests and drops stale frames.

Exit criteria:

- timeline/program preview is WGPU-backed
- scrubbing does not freeze React
- stale seek requests do not queue indefinitely
- video grade preview and image grade preview use the same grade document model

### Phase 5: Export Alignment

Goal: make preview and export share enough pipeline behavior that the user can
trust what they see.

Tasks:

1. Reuse `GradeDoc` and timeline render plan for export.
2. Keep CPU/GPU parity tests for grade output.
3. Use FFmpeg encode/mux as the export boundary.
4. Add report fields for preview backend and export backend.

Exit criteria:

- exported still/video grade matches preview within the defined tolerance
- fallback reasons are visible
- export does not depend on React canvas state

## Performance Rules

- No automatic WGPU viewport creation at app startup.
- No model or engine probe for a dropdown.
- No unbounded frontend cache of thumbnails or frame data.
- No base64 thumbnail stored in graph nodes, undo stack, or autosave.
- No editor viewport inside the node canvas lifecycle.
- No full editor mount just because the bottom drawer opens.
- No per-slider recreation of GPU pipelines when parameters can update buffers.
- No unbounded seek queue during video scrubbing.

## Relationship To Existing Plans

- `GPU_DEVICE_STRATEGY_PLAN.md` defines device reporting. This document defines
  which visual surfaces should use WGPU first.
- `UNIFIED_PRODUCTION_DRAWER_PLAN.md` defines the bottom drawer and target
  model. This document requires WGPU viewports to consume that target model.
- `IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md` defines layered assets. This document
  requires layer previews and edits to flow through references, not embedded
  pixels.
- `grade-kernel.md` and `grade-kernel-roadmap.md` remain the grade math
  authority. WGPU presentation must not fork a separate video-only color system.
- `editor-resource-model.md` remains the resource lifecycle authority and should
  be extended with WGPU texture lifecycle once implementation starts.

## Non-Goals

- Do not rewrite all UI in Rust.
- Do not replace XYFlow before the measured bottleneck is proven.
- Do not build a full 3D workspace just to follow other products.
- Do not make the bottom drawer mount every editor.
- Do not let WGPU introduce a second grade math model.
- Do not make GPU availability a hard requirement.

## Success Criteria

The migration is on the right path when:

1. The app opens without initializing heavy media viewports.
2. Image edit opens on demand and presents through WGPU.
3. Grade preview for image and video shares one grade document and one kernel
   contract.
4. Video preview uses Rust decode and WGPU texture presentation.
5. React state stores references and UI state, not heavy pixels.
6. Undo/autosave size stays bounded as projects grow.
7. CPU fallback remains correct and visible.
8. The node canvas can remain XYFlow or later move to WGPU without changing the
   product protocol.

The important decision is not "React or Rust." The decision is:

```text
business UI in React,
heavy media pixels in Rust/WGPU,
resources passed by reference,
edit and grade behavior described by durable operation documents.
```
