# Edge Routing Visual System Plan

> Status: active. Implementation-order steps 1–6 have landed: `@hgripe/flow`
> owns `chamferPath` (unit-tested), `ChamferEdge` / `BindingEdge` are the only
> workflow edge types, Studio renders through `HgripeFlow`, edges are stamped
> via the `withHgripe*Edge` / `addHgripeDataEdge` helpers, and
> `normalizeHgripeEdges` remains only as a legacy guard. From step 7, the
> **selected** visual state has landed (higher-contrast stroke + slightly
> heavier weight + matching arrow marker on both edge types). Steps 8-9 have
> also landed: `cachedChamferPath` caches geometry-derived paths and
> `isEdgeLodActive` simplifies low-zoom edges. Remaining: hover / running /
> error states, explicit bend points, and tidy routing.
> Purpose: define the long-term wire style for the H-Gripe Studio node canvas,
> so connection lines stay readable, performant, and aligned with product-level
> node cards.

## Core Decision

The default and only normal workflow wire style should be a single-cut chamfer
edge:

```text
port -> horizontal segment -> single 45 degree diagonal cut -> horizontal segment -> port
```

This is not a Bezier canvas, not a plain hard-elbow canvas, and not an
obstacle-avoidance router.

Normal workflow edges should use one structured 45 degree diagonal cut with a
clear direction arrow. Bezier, plain orthogonal, multi-elbow, and avoidance edge
choices should not be exposed in the product UI.

## Why This Fits H-Gripe Studio

H-Gripe Studio is moving toward fewer, larger, product-level cards with semantic
rows and ports. The line style should support that direction.

The 45 degree chamfered route gives:

- clearer directional reading than soft Bezier curves
- a more designed look than hard 90 degree elbows
- stable alignment with row-level ports
- easier bundling when multiple edges leave the same card
- cheaper path generation than curved edges
- better visual separation from media preview surfaces

It should look like a studio workflow surface, not a generic node demo.

## Boundary

This plan belongs to the graph UI layer:

- edge path generation
- port-to-port routing
- hit testing
- selected / hover / running / error edge states
- zoom-level detail reduction
- optional bend points or waypoints

It must not own:

- image, video, grade, or mask pixels
- WGPU viewports
- GPU device selection
- media execution scheduling
- model/API execution

Read together with:

- [`LOCAL_REACT_FLOW_FORK_PLAN.md`](LOCAL_REACT_FLOW_FORK_PLAN.md)
- [`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](NODE_CARD_PRODUCT_BOUNDARY_PLAN.md)
- [`RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md`](../completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md)

## Visual Contract

Default edge:

- uses horizontal segments plus one short 45 degree diagonal cut
- avoids soft S-curves as the default
- keeps the first segment close to the source row direction
- keeps the final segment close to the target row direction
- always shows direction with an arrow marker at the target end
- uses stable spacing so edges do not jump while unrelated nodes update
- keeps the edge visually behind cards and above the canvas background

Dragging connection line:

- reuses the same single-cut `chamferPath` as committed edges
- renders above node cards while the user is dragging from a port
- keeps an arrow marker at the current target end
- does not run Bezier, plain orthogonal, or obstacle-routing logic per mousemove

Selected edge:

- increases stroke weight slightly
- uses higher contrast
- may show small endpoint emphasis at the source and target ports
- should not use large glow effects that make dense wiring muddy

Hover edge:

- can brighten and widen the hit area
- should not trigger full graph reroutes

Running edge:

- may show a short moving dash or pulse
- animation must be disabled or simplified at low zoom or high edge count
- should only apply to active execution paths

Error edge:

- should use red or amber state color
- can use a broken or dashed style
- should remain readable without animation

Disabled / muted edge:

- lowers opacity
- can hide detail at low zoom
- must still show selected or searched relationships when requested

## Route Shape

A typical left-to-right route should be:

```text
source port
  -> short horizontal lead
  -> one 45 degree diagonal cut to the target row
  -> horizontal approach
  -> target port
```

For reversed routes, the same rule applies. Do not introduce a center vertical
lane unless a future explicit bus-routing mode exists.

The diagonal cut should be stable and bounded by the port delta:

```text
lead = bounded horizontal lead
diagonal run = min(vertical delta, remaining horizontal distance)
```

The exact numbers can be tuned, but the rule matters:

- tiny distances do not create oversized zigzags
- long distances do not create theatrical slashes
- normal edges do not produce repeated elbow groups
- every edge keeps a consistent product language

## Port Alignment

Edges must respect semantic row ports.

For a row-based card, the dot is not a decoration. It is the visual anchor of a
specific operation.

Examples:

```text
imageProcessing.grade.out -> model.image.in
imageProcessing.crop.out  -> export.image.in
prompt.optimized.out      -> generate.prompt.in
```

The edge route starts from the row's actual port center and ends at the target
port center. Do not auto-space ports by total count if that breaks row
alignment.

This is especially important for:

- Image Processing card rows
- Prompt card raw / optimized rows
- model/API cards with image, video, audio, and prompt inputs
- execution scope visualization

## Performance Contract

Chamfered orthogonal edges are expected to be cheaper than Bezier edges when the
route is simple.

The implementation should:

- generate SVG paths with straight line commands, not cubic curves
- cache paths per edge until source/target geometry changes
- avoid recalculating every edge on every node state update
- avoid full global obstacle routing during normal drag
- widen invisible hit areas separately from visible stroke
- reduce edge detail at low zoom
- disable decorative animation when edge count is high

The graph should optimize by reducing work, not by pushing media pixels into
node cards.

## Routing Levels

Use three routing levels rather than one expensive universal algorithm.

### Level 1: Direct Chamfer

Default for most edges.

Inputs:

- source point
- target point
- source side
- target side

Output:

- a small list of points forming a chamfered path

This should be the common fast path.

### Level 2: Local Side Clearance

Use when ports are close, reversed, or partially overlapping.

Adds:

- fixed lead distance out of the card
- lane offset for multiple edges from nearby ports
- simple vertical/horizontal separation

This should not scan the entire graph. It also should not create extra
enter-lane / exit-lane elbows unless a future explicit bus mode asks for that.

### Level 3: Explicit Waypoint / Tidy Route

Use only when the user or a tidy command asks for it.

Adds:

- manual bend points
- group-level bus lanes
- selected-area tidy routing

This can be more expensive because it is explicit, not the default per-frame
behavior.

## Avoided Design

Do not make the default line system:

- always Bezier
- selectable between Bezier / plain orthogonal / avoidance styles
- full graph auto-router on every drag
- decorative glowing wires everywhere
- animated wires for inactive paths
- a separate "reroute" node card
- a media preview layer

Wire cleanup is a canvas affordance, not a production node.

## React Flow Fork Implementation Notes

The first implementation can live behind `@hgripe/flow` while it still
re-exports XYFlow.

Current shape:

```text
packages/hgripe-flow/
  src/
    index.ts
    hgripe/
      edgeRouting.ts
      edgeVisual.ts
      edges.tsx
```

The app-facing goal is:

```text
HgripeFlow
  -> owns edgeTypes / defaultEdgeOptions / drag connection line
addHgripeDataEdge / withHgripeDataEdge
  -> stamp normal workflow edges at creation time
withHgripeBindingEdge
  -> stamp media-source-to-edit binding edges
normalizeHgripeEdges
  -> convert stale saved/runtime edge types to the H-Gripe product edge set
edge type "chamfer"
  -> stable path generation
  -> row-port alignment
  -> visual states
```

When the upstream source is vendored, the edge implementation can move deeper
into the local graph package without changing the Studio app import boundary.
The local package should not expose upstream Bezier, plain elbow, or
obstacle-avoid edge APIs to Studio. The Studio app should render through
`HgripeFlow`, not raw `ReactFlow`, so the edge configuration is not duplicated
in downstream canvas code.

## Minimal Algorithm Sketch

For a left-to-right route:

```text
sx, sy = source port center
tx, ty = target port center
lead = bounded horizontal lead from the source row
diagonalRun = min(vertical delta, remaining horizontal distance)

points:
  P0 = source
  P1 = sx + lead, sy
  P2 = P1.x + diagonalRun, ty
  P3 = target
```

Then collapse redundant points when the vertical distance is small.

The rendered SVG can be a single path:

```text
M P0 L P1 L P2 L P3
```

No cubic curve is required.

## LOD Rules

At normal zoom:

- show full chamfered paths
- show selected/running/error states
- show row-level connection identity through port alignment

At low zoom:

- simplify animation
- reduce opacity for unrelated edges
- optionally hide labels or endpoint adornments
- preserve selected/search/run-scope edges

At very low zoom:

- show only selected, hovered, searched, or running paths when the graph is
  dense
- keep minimap independent from detailed edge rendering

## Success Criteria

- The default canvas edge is a 45 degree single-cut structured line with an
  arrow marker.
- Bezier, plain elbow, and avoidance edge choices are not available in the
  normal product UI.
- Row-level ports visually align with the exact operation row they represent.
- Dragging nodes does not reroute the entire graph unnecessarily.
- Dragging a new connection keeps the temporary wire above cards and uses the
  same lightweight single-cut path as committed edges.
- Selected, running, failed, and muted edges are visually distinct.
- The edge system stays inside `@hgripe/flow` / graph UI ownership.
- WGPU media viewports and GPU strategy remain independent.
- There is no visible "Reroute" card in the normal palette.

## Implementation Order

1. Keep the current `@hgripe/flow` adapter boundary.
2. Add a pure path-generation function with unit tests.
3. Add `ChamferEdge` as the only normal workflow edge type.
4. Switch Studio to `HgripeFlow` so edge types, default edge options, and drag
   connection rendering are owned by `@hgripe/flow`.
5. Stamp app-created, restored, copied, and binding edges through
   `@hgripe/flow` helpers instead of ad hoc `type` strings.
6. Keep `normalizeHgripeEdges` only as a legacy/runtime guard for stale edges.
7. Add selected / hover / running / error visual states. Selected is landed;
   hover / running / error remain.
8. ✅ Add path caching based on source/target geometry.
9. ✅ Add LOD simplification.
10. Add explicit bend points or tidy routing only after the default route is
   stable.
