# Local React Flow Fork Plan

> Status: active implementation document.
> Purpose: define how H-Gripe Studio can take ownership of the node-graph
> canvas layer without conflicting with WGPU viewports, AMD/GPU compatibility,
> or the media-processing kernel roadmap.

## Core Decision

Forking React Flow / XYFlow locally is allowed, but only as ownership of the
node-graph UI layer.

It must not become the heavy-pixel renderer.

The boundary is:

```text
Local graph fork
  -> node cards
  -> edges / handles / selection
  -> viewport transform
  -> pan / zoom / fit / minimap / snapping
  -> node-level keyboard and pointer gestures

WGPU viewport host
  -> image editor pixels
  -> mask / layer underlays and overlays
  -> grade preview
  -> video preview / program monitor
  -> scopes / safe area / readback

GPU / Device Strategy
  -> requested vs used device reports
  -> WGPU adapter reports
  -> ONNX / DirectML / CUDA / CPU fallback reports
  -> FFmpeg software / hardware decode and encode reports
```

These layers can evolve independently when the contract stays clean.

## Non-Conflict With WGPU And AMD Compatibility

A local React Flow fork does not conflict with WGPU or AMD support because it
lives in the DOM / graph interaction layer. AMD compatibility lives lower:

- `wgpu` backend selection and adapter limits
- D3D12 / Vulkan / fallback behavior
- device lost and uncaptured GPU error handling
- `DeviceReport` normalization
- FFmpeg hardware decode / encode probing and fallback
- ONNX / DirectML / CUDA / CPU provider reporting

The fork must not absorb any of those responsibilities.

Decision rule:

```text
If it moves nodes, edges, ports, or graph chrome -> local graph fork.
If it moves pixels, textures, video frames, alpha, scopes, or grade previews -> WGPU / Rust viewport.
If it decides hardware backend or fallback -> GPU_DEVICE_STRATEGY_PLAN.md.
```

Read together with:

- [`GPU_DEVICE_STRATEGY_PLAN.md`](GPU_DEVICE_STRATEGY_PLAN.md)
- [`../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md)
- [`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](NODE_CARD_PRODUCT_BOUNDARY_PLAN.md)
- [`EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md`](EDGE_ROUTING_VISUAL_SYSTEM_PLAN.md)

## Why Fork Instead Of Staying Fully Upstream

The node canvas is no longer a generic demo graph. H-Gripe Studio needs a
product-owned workflow surface:

- product-level cards, not arbitrary low-level programming blocks
- row-aligned semantic ports
- stable card widths and LOD behavior
- run-scope selection and execution affordances
- multi-canvas project workspace behavior
- custom edge style, hit testing, and wire cleanup
- 45 degree chamfered edge routing as the default long-term wire style
- canvas search / selection / snapping tuned for this product
- strict avoidance of heavy pixel previews inside graph cards

Keeping upstream untouched is useful early, but the more the Studio canvas
becomes its own product, the more upstream churn becomes risk.

The goal is not to fork for ego. The goal is to freeze the graph primitive that
the product depends on, then evolve only the subset the product actually uses.

## Why Not Replace It With PIXI First

PIXI / WebGL can render many sprites faster, but the current node cards are not
game sprites. They contain:

- text
- buttons
- inputs
- dropdowns
- row ports
- tooltips
- keyboard focus
- context menus
- accessibility and IME-sensitive text entry

Those are still natural in DOM/React.

PIXI becomes attractive only if the graph itself becomes a huge low-level visual
simulation with thousands of visual primitives. H-Gripe Studio's direction is
the opposite: fewer, larger, product-level cards.

Therefore:

```text
Do not rewrite the workflow canvas into PIXI just to chase raw render speed.
Do reduce React/DOM work, node count, rerenders, and heavy card content.
```

WGPU already owns the truly heavy media pixels.

## Fork Strategy: Soft Cut First

Do not vendor-copy the whole library and immediately delete large parts.

Use a soft-cut sequence:

1. **Version pin**
   - Lock the current `@xyflow/react` version.
   - Record the upstream commit / package version in the fork README.

2. **Adapter boundary**
   - Add a local package such as `packages/hgripe-flow`.
   - The Studio app imports graph primitives from `hgripe-flow`, not directly
     from `@xyflow/react`.
   - The adapter should expose only the app-facing surface the Studio actually
     uses. Old upstream edge helpers must not be part of the product API.

3. **Local source import**
   - Bring the required React Flow / XYFlow source into the local package.
   - Keep the adapter API stable.
   - The app should not notice whether the implementation is upstream or local.

4. **Parity check**
   - Verify existing graph operations:
     - node add / drag / select
     - edge create / delete
     - row port handles
     - fit view / zoom / pan
     - minimap / controls if retained
     - multi-canvas persistence
     - run scope selection

5. **Product trimming**
   - Remove only unused code after parity is proven.
   - Prefer deleting through tests and adapter coverage, not broad manual cuts.

6. **Product optimization**
   - Add H-Gripe-specific behavior:
     - node LOD
     - stable node dimensions
     - row-aligned handles
     - chamfered structured edge routing
     - edge hit-test tuning
     - less rerendering
     - selection/run-scope integration
     - optional minimap simplification

## What Must Not Be Deleted Early

Do not remove these until there is a replacement and tests:

- viewport transform math
- pan / zoom / fit-view APIs
- pointer capture and drag state
- selection rectangle behavior
- keyboard focus rules
- node bounds and coordinate projection
- handle hit testing
- edge reconnect / delete behavior if still used
- controlled state hooks used by saved workflow persistence
- any API used by multi-canvas tabs or run-scope resolution

These look generic, but they are the foundation for product features like
selection run, region run, canvas search, and row-port placement.

## What Can Be Removed Later

Candidates after adapter parity:

- examples / docs / playground code
- unused node types
- unused edge variants
- unused controls
- unused whiteboard helpers
- unused accessibility wrappers only if the app has its own equivalent
- unused pro/demo-oriented features
- generic behaviors that conflict with row-aligned product cards

Deletion should happen after measuring bundle size, render cost, and API usage.

## Performance Targets

The fork should optimize the graph by reducing work, not by moving media pixels
into the graph.

Targets:

- node cards do not host heavy editors
- thumbnails remain lazy and bounded
- WGPU previews stay outside React Flow cards
- card internals avoid rerendering on unrelated graph changes
- edges and handles update only when relevant geometry changes
- LOD hides expensive card interiors while zoomed out
- selection/run overlays do not force every node to rerender

Do not turn the graph into a second media viewport.

## Integration With Product Boundaries

The fork must reinforce
[`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](NODE_CARD_PRODUCT_BOUNDARY_PLAN.md):

- default palette shows production cards only
- low-level values stay inside owning cards
- row ports use semantic ids
- manual media editing opens software-level editors
- review/preview gates stay outside graph-card internals when heavy

React Flow ownership should make the product cleaner, not make it easier to add
random tiny nodes.

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Diverging from upstream makes future fixes harder | Keep upstream version record and use adapter boundary. |
| Fork deletes behavior needed by run-scope / multi-canvas | Parity tests before trimming. |
| Graph fork gets blamed for WGPU/GPU bugs | Keep DeviceReport and viewport errors below the graph boundary. |
| DOM graph still gets slow with many cards | Use LOD, memoization, lazy thumbnails, product-level cards, and bounded node count. |
| Fork becomes another generic engine project | Only expose H-Gripe product APIs through `hgripe-flow`. |

## Suggested Package Shape

```text
packages/
  hgripe-flow/
    README.md
    package.json
    src/
      index.ts
      adapter/
      upstream/
      hgripe/

apps/desktop-tauri/studio-ui/
  imports graph API from packages/hgripe-flow
```

The first commit should not rewrite behavior. It should create the adapter and
prove the app still works.

## Implementation Order

1. Document and pin the current upstream `@xyflow/react` version.
2. Add `packages/hgripe-flow` as a local adapter.
3. Move app imports from `@xyflow/react` to `@hgripe/flow`.
4. Run the studio UI tests and build.
5. Vendor or copy the needed upstream source into `hgripe-flow`.
6. Keep API stable and run parity checks.
7. Begin product trimming.
8. Add H-Gripe-specific optimizations.
9. Only after this, consider deeper render-layer alternatives if the graph
   still bottlenecks.

## Success Criteria

- The app no longer imports `@xyflow/react` directly.
- The local graph package has a clear README with upstream version provenance.
- Existing graph workflows load unchanged.
- WGPU viewport code remains independent.
- GPU/AMD compatibility stays governed by `GPU_DEVICE_STRATEGY_PLAN.md`.
- Node canvas performance improves without pushing media pixels into cards.

## Explicit Non-Goals

- Do not replace WGPU viewports with React Flow, PIXI, or DOM canvas.
- Do not put image/video/grade heavy rendering inside node cards.
- Do not build a global GPU scheduler in the graph package.
- Do not rewrite the full app UI into a custom renderer.
- Do not delete upstream internals before adapter parity is verified.

## Implementation Status

- `packages/hgripe-flow` exists as the local graph adapter package.
- Step 5 (local source import) is done: the upstream source of
  `@xyflow/react@12.3.5` and `@xyflow/system@0.0.46` is vendored into
  `packages/hgripe-flow/src/upstream` and the `@xyflow/*` npm dependency is
  removed. Provenance and fork rules live in the package README.
- Runtime deps (`classcat`, `zustand`, `d3-drag`, `d3-selection`,
  `d3-transition`, `d3-zoom`) stay on npm, pinned in the studio-ui app.
- First product-trimming pass is done:
  - Deleted `upstream/react/additional-components/Background` (the product
    removed the dot-grid background entirely), `Controls`, and `NodeToolbar`
    (plus `system/utils/node-toolbar.ts`).
  - Deleted the built-in edge components (bezier / simplebezier / step /
    smoothstep / straight). `builtinEdgeTypes.default` now renders nothing;
    every product edge must come from `HgripeFlow`'s edge type map. The
    default `ConnectionLine`'s simple-bezier case now draws a bezier (the
    product always supplies a custom connection line component).
  - Remaining candidate: built-in node components (input / output / default /
    group) once `NodeWrapper`'s `builtinNodeTypes` fallback is narrowed to
    Studio types.
- Studio imports must route through `@hgripe/flow`, not directly through
  `@xyflow/react`.
- The adapter is no longer a blanket re-export. It exposes only the React Flow
  primitives currently used by Studio, plus H-Gripe-owned graph helpers.
- The raw `ReactFlow` component and upstream `addEdge` helper are not exported
  to Studio. The canvas renders through `HgripeFlow`, and new workflow edges are
  created through `addHgripeDataEdge` / `withHgripeDataEdge`.
- Normal workflow wires use the H-Gripe single-cut chamfer edge with an arrow.
  Binding wires use the same routing family with a distinct binding style.
- App-created edges, restored graph edges, pasted edges, and media edit binding
  edges are stamped through `@hgripe/flow` helpers. `normalizeHgripeEdges`
  remains as a legacy/runtime guard for stale saved states.
