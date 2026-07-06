# @hgripe/flow

Local graph adapter for H-Gripe Studio.

This package owns the node-graph layer. The upstream React Flow source is
vendored into `src/upstream` (no `@xyflow/*` npm dependency), and the app
consumes it only through the narrow `@hgripe/flow` adapter API.

## Boundary

`@hgripe/flow` owns graph UI primitives:

- node and edge components
- handles, viewport, minimap, pan / zoom / fit view
- selection, connection, and canvas interaction hooks

For workflow wires, the only product edge style is H-Gripe's single-cut
chamfer line with a direction arrow. Bezier, plain elbow, and obstacle-avoid
edge helpers are not exported from this package.

Studio should render the graph with `HgripeFlow`, not raw `ReactFlow`.
`HgripeFlow` owns the edge type map, default edge options, drag connection
line, and stale-edge normalization. App code should create workflow edges with
`addHgripeDataEdge` or `withHgripeDataEdge`; media edit binding edges should
use `withHgripeBindingEdge`.

It must not own heavy media pixels:

- image editor rendering
- mask / layer preview rendering
- grade or video program monitors
- WGPU device selection or GPU fallback

Those stay in the Rust / WGPU / media-kernel layers.

## Upstream Provenance

- Vendored from: `github.com/xyflow/xyflow`, tag `@xyflow/react@12.3.5`
  (`packages/react/src` → `src/upstream/react`, `packages/system/src`
  (`@xyflow/system@0.0.46`) → `src/upstream/system`; MIT, see
  `src/upstream/LICENSE`).
- `src/upstream/style.css` is the built upstream stylesheet of the same
  version (the upstream postcss pipeline is not reproduced here).
- Runtime deps stay on npm and are pinned in the app: `classcat`, `zustand`,
  `d3-drag`, `d3-selection`, `d3-transition`, `d3-zoom`.
- Local changes to `src/upstream` are allowed — this is a fork, not a mirror.
  Keep the `@hgripe/flow` adapter API stable when changing upstream internals.

Current phase: vendored source with adapter parity. Next phase: product
trimming (delete unused upstream components after measuring usage) per
`docs/plans/active/LOCAL_REACT_FLOW_FORK_PLAN.md`.
