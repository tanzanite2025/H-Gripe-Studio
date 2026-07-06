# @hgripe/flow

Local graph adapter for H-Gripe Studio.

This package is the first soft-cut away from direct `@xyflow/react` imports.
It exposes a narrow app-facing surface over `@xyflow/react@12.3.5`, so the
Studio app can compile while old upstream edge styles are not part of the
product API.

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

## Current Upstream

- Package: `@xyflow/react`
- Version: `12.3.5`
- Current phase: narrow adapter with H-Gripe edge ownership and downstream edge
  creation helpers

Next phase: vendor the required upstream source into this package while keeping
the exported app-facing API stable.
