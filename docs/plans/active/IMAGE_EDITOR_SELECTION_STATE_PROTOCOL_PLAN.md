# Image Editor Shared Canvas And Layer Rendering Protocol

> Status: active and authoritative.
> Scope: image-editor pixels, layers, selected-layer frame, navigation,
> dragging, image resize, and `Ctrl+J` / Layer Via Copy.

This document replaces every older image-editor description of dynamic scene
frames, pasteboard-sized composite bitmaps, selected-layer move surfaces,
retargeted image composites, stale-frame fallbacks, and `clip.region`-based
layer positioning. Do not restore those designs from history or from another
document. If another document conflicts with this protocol, this protocol wins.

## Hard Gate

The image editor uses one shared logical world and one retained layer scene.

```text
document coordinates
  -> shared logical pasteboard
  -> retained layer nodes
  -> one viewport compositor
  -> one screen-sized framebuffer
```

Every visible layer and its selected-layer frame use the same layer transform
and the same camera matrix.

The following are forbidden:

- allocating one document-sized or pasteboard-sized canvas per layer;
- baking the editor pasteboard into an image-composite PNG or texture;
- changing world bounds because the stage, modal, or window changed size;
- retargeting or regenerating pixels for pan, zoom, rotate-view, or layer drag;
- keeping a previous image frame while drawing current geometry;
- drawing a yellow frame before the exact current pixels are presented;
- using `clip.region`, active selection bounds, alpha bounds, mask bounds, or
  source natural size as a fallback for layer placement;
- moving pixels and the yellow frame through separate draft/fallback pipelines.

There is no old-frame fallback. A new pixel revision is either fully ready and
presented with its matching geometry, or it is not displayed.

## Selection State Boundary

Selection state remains separate from layer pixels and the selected-layer
frame:

```text
tool gesture -> SelectionDraft -> explicit Make Selection -> ActiveSelection
```

Only `ActiveSelection` is a command read constraint. A solid or in-progress
draft is not an active selection, layer, mask, pixel source, or Studio Action
target. `Ctrl+J`, Delete, Invert, Feather, and Selection To Mask consume the
committed active selection and active editable target; they never branch on the
tool that produced the selection. Renderers display this state but do not own
or infer it.

## Coordinate Spaces

The editor has four explicit spaces. They must not be collapsed into one
`sceneFrame` value.

### Document Space

Document space is the exported image coordinate system. World units are image
pixels at 100% zoom.

```text
documentBounds = [0, 0, documentWidth, documentHeight]
```

Layer placement, selections, paths, masks, and history transactions are stored
in document coordinates.

### Logical Pasteboard Space

The pasteboard is an editor-only logical boundary. It is not a bitmap and is
never exported. The initial absolute ratio is `2.5` times the document size,
centred on the document:

```text
PASTEBOARD_FACTOR = 2.5
marginX = documentWidth  * (PASTEBOARD_FACTOR - 1) / 2
marginY = documentHeight * (PASTEBOARD_FACTOR - 1) / 2

pasteboardBounds = [
  -marginX,
  -marginY,
  documentWidth + marginX,
  documentHeight + marginY,
]
```

For an `800 x 800` document, the logical pasteboard is `2000 x 2000` with
bounds `[-600, -600, 1400, 1400]`.

Pasteboard bounds depend only on document dimensions and the fixed factor.
They never depend on stage aspect ratio, window size, panel layout, zoom, pan,
or the current layer position.

### Camera Space

The camera contains view-only state:

```ts
interface ImageEditorCamera {
  centerX: number;
  centerY: number;
  zoom: number;
  rotate: number;
}
```

Pan, zoom, and rotate-view modify only the camera. They do not change the
document, pasteboard, layer textures, placements, target keys, or pixel
revision.

Initial fit and `Ctrl+0` fit the document, not the entire pasteboard. Otherwise
an `800 x 800` image would occupy only 40% of a `2000 x 2000` pasteboard view.

### Screen Space

The stage size is used only to build the camera-to-screen matrix and pointer
inverse. Resizing or maximizing the window updates that matrix without
changing any pixel target.

## Layer Model

All layers share document and pasteboard coordinates. A layer owns compact
pixel storage plus placement and transform metadata; it does not own a full
canvas.

```ts
interface RetainedPixelLayer {
  id: string;
  pixelStoreId: string;
  localPixelBounds: [number, number, number, number];
  placement: [number, number, number, number];
  transform: LayerTransform;
  opacity: number;
  blendMode: BlendMode;
  maskId?: string;
  pixelRevision: number;
}
```

`pixelStoreId` initially references one tightly bounded RGBA resource. Large
documents migrate to sparse `256 x 256` or `512 x 512` tiles without changing
the layer contract.

Layer screen geometry is always:

```text
screenGeometry = cameraMatrix * layerTransform * placementGeometry
```

The image quad, yellow frame, transform handles, and hit testing consume this
same result. No renderer may independently reconstruct layer bounds.

## Selected-Layer Frame

The selected-layer yellow frame is display-only geometry for the active layer.

Its source rectangle is exactly the layer's explicit `placement`, followed by
the layer's committed transform and current in-memory drag delta.

```text
frameGeometry = cameraMatrix
              * dragTransform
              * committedLayerTransform
              * placement
```

Rules:

- `clip.region` never participates.
- Masks and alpha/content bounds never participate.
- A source-backed pixel layer without explicit placement is invalid and must
  be fixed by its producer; the frame renderer must not invent a fallback.
- If the exact current layer pixels are not presented, the frame is not drawn.
- During a drag, the image quad and frame are children of the same transformed
  layer node and therefore cannot receive different deltas.

## Viewport Compositor

The renderer retains layer pixel resources and composites only the visible
viewport into one screen-sized framebuffer.

It does not allocate a texture for the whole pasteboard. For example, an
`800 x 800` layer on a `2000 x 2000` logical pasteboard still owns only its
`800 x 800` pixel resource.

The retained scene frame is the stable logical pasteboard, while the document
frame remains the edit/export boundary. The compositor samples only the current
camera window from that scene into its bounded output framebuffer; the scene
frame does not authorize a pasteboard-sized pixel store per layer. Browser
pixels and the future native placement anchor are positioned in the shared
world, not inside the document child. Document-normalized mask and vector
overlays are projected through the document frame into the same visible scene
window, so expanding the sampleable world does not stretch an overlay across
the pasteboard.

Navigation is a draw-time matrix change:

```text
pan / zoom / rotate-view
  -> update camera uniform or DOM transform
  -> redraw retained layer quads
  -> no decode
  -> no image-composite target change
  -> no PNG/blob replacement
```

Pixel edits produce a new `pixelRevision`. The renderer prepares that revision
offscreen and atomically swaps pixels and matching geometry. It never exposes a
new placement with an old texture or a new texture with an old placement.

## Layer Drag

Dragging is a transform-only interaction.

```text
pointer down
  -> select retained layer node
  -> record pointer-to-layer offset

pointer move
  -> update one in-memory drag transform
  -> request one animation frame
  -> draw layer pixels, yellow frame, and handles with that transform

pointer up
  -> commit the same delta as one history transaction
  -> clear the in-memory drag transform after the committed state is visible
```

The full document is not recomposited on pointer move. There is no separately
materialized `SelectedLayerMoveSurface`, no draft-frame cache, and no operation
that hides the layer in one viewport while showing it in another.

The GPU path draws retained layer textures directly. The CPU renderer path may
cache the non-moving background once at pointer down and draw the selected
layer over it, but that cache belongs to the same `PresentationRevision` and
camera revision. It is a renderer-local acceleration, not a target/frame
fallback, and it is destroyed before any target or geometry change.

Layer movement is clamped against logical pasteboard bounds using the explicit
placement, committed layer transform, and rotated layer AABB. Preview and
commit consume the same clamped delta. Linked movable layers are clamped as one
combined envelope; locked or non-source active layers cannot start a move. If
an envelope is larger than the pasteboard, it remains movable only while it
continues to cover the pasteboard. The pasteboard factor therefore gives
deterministic drag room without expanding in response to the drag.

A move transaction has `dragging` and `committing` phases. Pointer up commits
the final preview delta but retains that final draft against its base document
until the replacement document scene and matching frame have settled. The new
document requests its own baseline presentation rather than reusing a draft
whose base key belongs to the previous document. Only then is the matching
transaction released, so the handoff cannot flash an unclamped, stale, or
double-applied transform.

## Native File Drop Ownership

The application owns one Tauri native file-drop listener. It converts the
native device-pixel position to CSS coordinates, resolves the topmost DOM
target, and routes the event to the highest-priority matching consumer only.
Once a consumer claims an event, lower-priority consumers do not also receive
it; an async consumer failure is contained and does not fork delivery.

The image editor claims drops over its entire `.image-editor` modal. A drop on
editor chrome is therefore swallowed by the editor and cannot create a graph
node behind the modal, but it does not import anything. Only a drop whose target
is inside `.image-editor-stage` may import supported image paths as layers.

For a multi-file stage drop:

- source path order is authoritative even when dimension probes finish out of
  order;
- unsupported paths and invalid dimensions are filtered without reordering the
  remaining images;
- all resolved images are appended by one `layer_add_images` document command,
  producing one history transaction, so one undo removes the whole batch; and
- each image keeps its own source resource and receives a centred contain-fit
  placement in the current canvas.

## `Ctrl+J` / Layer Via Copy

### Without An Active Selection

Ordinary layer duplicate preserves visual position exactly:

```text
new.pixelStoreId = source.pixelStoreId  // copy-on-write when supported
new.placement = source.placement
new.transform = source.transform
new.mask = source.mask
new.opacity = source.opacity
new.blendMode = source.blendMode
```

The duplicate may share immutable tiles with the source until either layer is
edited. It must not allocate a document-sized transparent canvas.

### With An Active Selection

Layer Via Copy creates real compact pixels at their real document position.
It does not duplicate the full source and attach a clip.

```text
active editable layer + active selection
  -> sample the final selected pixels in document space
  -> compute the copied pixel bounds
  -> create a tightly bounded RGBA pixel store
  -> create a new layer with placement equal to those document bounds
  -> use identity transform for the rasterized result
```

Example:

```text
selection/document bounds = [300, 200, 500, 450]
new pixel store            = 200 x 250
new placement              = [300, 200, 500, 450]
new transform              = identity
```

If the source layer is scaled, rotated, masked, or otherwise transformed,
Layer Via Copy samples its final visible pixels in document space. Baking that
result into a compact texture with identity transform avoids applying the old
transform twice.

The active selection is a read constraint only. The tool that created it does
not affect `Ctrl+J`. A selection draft must be committed before the command can
use it.

`clip.region` is not positioning data and must not be written as a substitute
for the new layer's placement.

## Image Size (`Ctrl+Alt+I`)

Image Size changes document pixel dimensions. For an `800 x 800` document
resized to `2000 x 2000`:

```text
document       800 x 800  -> 2000 x 2000
logical world  2000 x 2000 -> 5000 x 5000
scaleX = 2000 / 800
scaleY = 2000 / 800
```

The operation resamples layer pixel stores and scales placements, masks,
paths, and other document-space geometry according to the command semantics.
The pasteboard is recomputed from the same fixed factor.

Pixels, document dimensions, pasteboard bounds, placements, and revision are
published as one atomic document transaction. The renderer keeps the previous
complete revision visible until the replacement is ready, then swaps the whole
revision. It never combines old pixels with new geometry.

Camera centre is preserved in normalized document coordinates. Camera zoom is
view state and is not stored as image data. `Canvas Size` is a separate command:
it changes document bounds without resampling layer pixels.

## Memory And Tiling

A full `2000 x 2000` RGBA canvas costs about 16 MB before browser/GPU copies.
One hundred such layer canvases cost about 1.6 GB. A full 4K RGBA layer costs
about 33 MB, so fifty full canvases already exceed 1.6 GB before mipmaps,
double buffers, masks, and undo history.

Therefore:

- the pasteboard is logical only;
- layers store tight pixel bounds or sparse tiles;
- the compositor allocates one screen-sized framebuffer;
- unchanged tiles may be shared copy-on-write;
- dirty-region invalidation recomposites only affected visible tiles;
- mip levels are caches and may be evicted;
- large undo payloads may spill to the existing scratch/cache layer.

## Photoshop Reference Model

Photoshop's current source is proprietary, so this project must not invent
claims about private implementation details. Its public PSD contract and
observable behavior provide the relevant model:

- PSD layer records store independent `top/left/bottom/right` bounds.
- Layer channel data is stored per layer and may be RLE/ZIP compressed.
- Photoshop exposes tile/cache-level and scratch-disk behavior for large
  documents.
- Duplicated layers preserve document position.
- Layer Via Copy creates pixels at the selected document position.
- Pan and zoom are viewport operations, not destructive image resizes.

When parity is uncertain, verify it by a black-box PSD fixture:

1. Create a document and a small offset layer at known coordinates.
2. Test `Ctrl+J` with and without an active selection.
3. Include a transformed source layer and a feathered selection.
4. Save PSD and inspect layer record bounds and channel dimensions.
5. Compare those bounds with the on-screen result.

Public behavior and the PSD layer record are evidence; an old H-Gripe preview
or cached frame is not.

## Atomic Presentation Contract

Every displayed image-editor frame carries one identity:

```text
PresentationRevision {
  documentRevision,
  pixelRevisionByLayer,
  layerGeometryRevision,
  cameraRevision,
}
```

Pixels and layer geometry must match the same document/layer revisions. Camera
revision may change independently because it is applied to both in one render.

If a pixel revision fails to build, report the error and keep the previous
complete document revision as a complete scene. Never project a previous
bitmap through current layer geometry. There is no stale-frame fallback inside
a current revision.

## Acceptance Tests

The architecture is not complete until all of these pass:

1. An `800 x 800` layer has placement `[0,0,800,800]` on a logical
   `2000 x 2000` pasteboard; its frame and pixels share exact screen bounds.
2. Resizing or maximizing the editor changes only the camera projection and
   never requests new layer pixels.
3. Pan, zoom, and rotate-view do not change document, pasteboard, placement,
   texture identity, or pixel revision.
4. During a layer drag, every captured frame shows pixels and yellow frame with
   the same delta; neither disappears.
5. If current pixels are unavailable, both the pixels and selected frame are
   absent; an old bitmap is never stretched through a new coordinate frame.
6. `Ctrl+J` without a selection produces an exactly overlapping layer.
7. `Ctrl+J` with a selection produces a tight pixel store whose placement is
   the copied document bounds and whose transform is identity.
8. `clip.region` changes cannot move or resize the selected-layer frame.
9. Image Size updates pixels, dimensions, placements, pasteboard, and revision
   in one atomic swap.
10. Layer-count and 4K/8K tests demonstrate bounded memory from tight bounds,
    tiles, eviction, and one viewport framebuffer.
11. A native drop over the editor stage is delivered only to the editor; a drop
    over editor chrome imports no layer and cannot fall through to the graph.
12. A multi-image drop preserves source path order in the layer stack even when
    dimension probes complete out of order or invalid entries are filtered.
13. A multi-image drop creates one history transaction; one undo removes every
    layer in the batch, and each added layer has a centred contain-fit placement.
14. A layer moved completely outside the document but still inside the logical
    pasteboard keeps its pixels and yellow frame aligned, can be grabbed again,
    and does not stretch document-normalized mask or vector overlays.

## Migration Status (2026-07-14)

This status records the current landing without weakening any rule above.

| Protocol slice | Status | Current implementation boundary |
| --- | --- | --- |
| Shared logical world and fixed `2.5x` pasteboard | Landed | Pasteboard bounds are document-derived geometry and form the stable retained scene frame; initial fit and `Ctrl+0` still fit the document. The browser pixel plane lives in the shared world, while the document child retains tool/canvas coordinates. Camera changes select a bounded scene window without changing scene identity. |
| Stable viewport resource target | Landed | The image-editor host/target identity is `image_composite:<resourceId>` and does not include the document revision, camera, selection, or drag delta. |
| Atomic document-scene replacement | Landed | `viewport_set_image_scene` builds a complete `RetainedImageScene` off the active state, then swaps the document payload and ordered retained layer nodes together. A failed/superseded build cannot replace the active scene. |
| Compact retained layer nodes | Core landed | Each visible pixel layer retains its own source pixels, explicit placement, document properties, and stack index. No layer owns a document- or pasteboard-sized canvas. Sparse tiles, eviction, and direct GPU-resident nodes remain scaling work. |
| Unified selection/drag presentation | Landed | `viewport_present_image_layer_scene` validates `transactionId`, `baseDocumentKey`, monotonic `sequence`, selected layer, linked affected layers, and one in-memory `moveDraft`; it bumps render state without changing resource/content identity. |
| Drag bounds and committed-scene handoff | Landed | Live preview and history commit share one delta clamped from explicit placement, committed transform, rotated AABB, and the combined linked-layer envelope. Pixels remain sampleable when the layer is outside the document but inside the pasteboard. Pointer up retains the final draft in `committing` until the replacement document scene and matching frame settle, while the new document requests its own baseline. |
| Same-frame yellow-frame metadata | Landed | The retained-scene render computes pixels and `selectedLayerFrame` together. The frame payload returns that geometry with `documentKey`, `transactionId`, and `sequence`; the frontend exposes it only for the exact presented tuple. There is no independent frame IPC. |
| Legacy drag/frame paths | Removed | `SelectedLayerMoveSurface`, its preload/cache modules, moving-layer hidden-document retarget, the separate selected-layer-frame request hook, and dynamic scene-frame helpers were deleted. The remaining `sceneFrame.ts` and `selectedLayerFrame.ts` files are types only. |
| Exclusive native file-drop routing | Code and automated tests landed; native evidence pending | `App` retains the sole Tauri listener and priority-routes each event to one claimant. The editor owns its modal, imports only on the stage, preserves batch order, and records one undo transaction. Direct OS-to-Tauri drag/drop evidence on a native desktop run is still required. |
| Compact Layer Via Copy, atomic Image Size, sparse tiling | Pending | These remain governed by the rules and acceptance tests above; the retained-scene landing must not be treated as completion of the whole protocol. |

## Migration Order

1. Freeze document, pasteboard, layer, camera, and presentation revision types.
2. Make pasteboard bounds document-derived and session-stable; remove stage
   aspect and window size from world geometry.
3. Introduce retained per-layer pixel resources and the single viewport
   compositor.
4. Put pixels, frame, handles, and hit testing under one layer/camera transform.
5. Move navigation to camera-only updates.
6. Move layer dragging to an in-memory layer transform plus one mouse-up
   transaction; delete move-surface and frame fallback paths.
7. Implement `Ctrl+J` duplicate and Layer Via Copy using compact pixel stores
   plus explicit placement; delete clip-based duplication.
8. Implement atomic Image Size and Canvas Size transactions.
9. Add sparse tiles, dirty-region scheduling, mip eviction, and scratch storage.
10. Remove the old dynamic scene-frame, image-composite retarget, stale-frame,
    and pasteboard-bitmap code after native and browser acceptance evidence.
