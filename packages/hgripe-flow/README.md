# @hgripe/flow

Local graph adapter for H-Gripe Studio.

This package is the first soft-cut away from direct `@xyflow/react` imports.
It currently re-exports `@xyflow/react@12.3.5` unchanged so the Studio app can
compile and behave exactly as before while all product code imports from one
owned boundary.

## Boundary

`@hgripe/flow` owns graph UI primitives:

- node and edge components
- handles, viewport, minimap, pan / zoom / fit view
- selection, connection, and canvas interaction hooks

It must not own heavy media pixels:

- image editor rendering
- mask / layer preview rendering
- grade or video program monitors
- WGPU device selection or GPU fallback

Those stay in the Rust / WGPU / media-kernel layers.

## Current Upstream

- Package: `@xyflow/react`
- Version: `12.3.5`
- Current phase: re-export adapter

Next phase: vendor the required upstream source into this package while keeping
the exported app-facing API stable.
