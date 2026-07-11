# Image Editor Selection State Protocol Plan

> Status: active planning document.
> Purpose: freeze the image editor's selection state contract before more
> lasso, pen, marquee, layer-via-copy, Studio Action, or WGPU overlay work.

## Hard Gate

Do not add new selection tools, `Ctrl+J` behavior, selection context-menu
commands, Studio Action selection targets, or WGPU selection overlays until this
boundary is preserved:

```text
selection creation tool
  -> solid draft geometry
  -> explicit Make Selection
  -> one active marching-ants selection state
  -> commands such as Ctrl+J / Delete / Invert / Feather
```

The visual result path is also gated:

```text
Rust/controller-owned result
  -> InteractionResultLayer
  -> DOM/SVG now, WGPU renderer later
```

Do not mount separate visual overlay chains for selected layer frames, selection
drafts, marching ants, move previews, brush cursors, or future transform
handles. They all enter the same interaction result layer so zoom, pan, frame
expansion, WGPU migration, and future compositor work cannot drift apart.

The pixel read path is separate again:

```text
Active editable pixel layer
  -> LayerPixelReadSource
ActiveSelection
  -> ReadConstraint
LayerPixelReadSource + ReadConstraint
  -> Layer Via Copy transaction
  -> Rust compositor/materializer reads pixels
```

The interaction result layer never provides pixels. It can display a selected
layer frame or marching ants, but commands such as `Ctrl+J` must read from the
document layer stack, not from DOM/SVG/WGPU preview state.

The interaction result layer also never owns editor chrome. Selection drafts,
marching ants, selected-layer frames, move previews, brush cursors, and future
WGPU interaction overlays are stage-local visuals. They must not require global
CSS, app-root transparency, shared-modal transparency, or `.media-viewer`
behavior changes. If an overlay or WGPU viewport needs a transparent region, it
must be a scoped hole owned by the image-editor stage, not by `App`,
`.media-viewer-backdrop`, or `.media-viewer`.

The tool that drew the shape must not own the command result. A rectangle,
ellipse, pen path, polygon path, magnetic-lasso loop, object selection, quick
selection, magic-wand result, or future model-assisted hint can all create the
same active selection state. After the selection is active, commands must not
branch on which tool created it.

The top selection tool strip is only a tool-entry surface. It must visually and
architecturally separate pure geometry tools (rectangle marquee, ellipse
marquee, pen, polygon lasso) from pixel-assisted tools (magnetic lasso, object
selection, quick selection, magic wand, SAM/model-assisted selection). Neither
family owns the "Make Selection" result or `Ctrl+J`; only the pixel-assisted
family may request a `SelectionAssistReadSource`.

In the UI code, this split is centralized in
`apps/desktop-tauri/studio-ui/src/editor/imageEditorModal/selectionToolProtocol.ts`.
Do not duplicate the tool-family arrays in toolbar, pointer, command, or painter
modules. A tool may trigger `SelectionAssistReadSource` only if
`usesSelectionAssistRead(toolId)` returns true; currently that is limited to
`magnetic_lasso` until wand, quick select, object select, and SAM/model tools
are migrated one by one.

Current migration status:

- `magnetic_lasso`: wired as a pixel-assisted `SelectionDraft` producer and the
  only current `SelectionAssistReadSource` consumer.
- `wand`, `quick_select`, `object_select`: still legacy mask-op producers in
  the replay path. They must not silently read pixels in the editor UI until
  they are converted into explicit `SelectionDraft` producers.
- `point` / SAM 2 prompts: model prompt state, mapped to `sam2` as a selection
  source, but not yet a committed `SelectionDraft` producer.

## Core Decision

The editor has two different concepts that must stay separate:

| Concept | Visual state | Meaning | Can `Ctrl+J` use it? |
| --- | --- | --- | --- |
| Selection draft | Solid outline / anchors / live path | A closed or in-progress candidate drawn by a tool. | No. It must be committed first. |
| Active selection | Marching ants / flowing dashed outline | The current edit constraint, independent of its source tool. | Yes. |

The selected-layer frame is a third concept and must not be folded into either
of those states. It means only "the currently selected layer/element's layer
bounds". It is not a mask bound, not an active selection bound, not an inverse
selection, not a brush/color region, and not a crop command output. The yellow
frame may follow zoom, pan, and move-preview deltas, but the geometry source
remains the selected layer's own recorded pixel bounds.

For source-backed pixel layers, the selected-layer frame is the layer's explicit
`source_image.placement`, narrowed by the same `source_image.clip.region` when
that clip is part of the layer's own recorded pixel source, then transformed by
the layer's committed transform. The resolver must not infer a replacement
rectangle from source-image natural size, active selection bounds,
alpha/content bounds, later crop/edit op clips, or layer masks. A source-backed
layer without explicit placement is invalid for the selected-layer yellow frame;
the producer that created the layer must write the placement.

V/move tool ownership is separate from selection ownership:

```text
pointer V drag
  -> layerMoveInteraction.ts owns begin/update/commit
  -> selected-layer move surface is materialized once for the current layer/frame
  -> moveDraft only moves that selected-layer surface
  -> selected-layer frame presentation reads moveDraft
  -> mouseup writes one transform op to the active layer
```

The V/move path must not CSS-translate the whole rendered composite, must not
put `moveDraft` into viewport placement keys, and must not store selected-frame
handoff state inside `ImageEditorModal.tsx`. Moving a layer and moving the
canvas are different operations. During drag, the image editor must not retarget
or re-render the full composite on every pointer move. It presents a cached
selected-layer surface through `InteractionResultLayer`; moving only changes
that surface's transform. Mouseup commits the same delta as one transform op on
the active layer.

The selected-layer move surface must not be materialized synchronously when the
editor opens or when a V drag begins. It is queued only after the image viewport
is stable and the Move tool is active; the prepared surface is drawn once into a
hidden canvas, then a drag only toggles visibility and updates transform. The
Rust command that materializes pixels must run on a blocking/background task so
the desktop shell does not freeze while decoding or compositing the layer
surface.

The base image/composite must load and remain visible first. Selected-layer
frame and move surface are overlay work queued after that; they must not remove
or blank the base image while they are loading.
When a prepared move surface is actively displayed, the stage may hide the main
pixel presentation with CSS for that interaction only, so the original and moved
image do not double-render. It must not hide the active layer by retargeting the
document, and it must not clear the base image while the move surface is still
loading.
The image surface, selected-layer yellow frame, and transform/action affordance
must consume the same displayed move delta. If the selected-layer move surface
is not ready, the yellow frame and affordance must stay with the loaded image
instead of moving alone.

This is the product rule:

```text
solid outline != active selection
active selection != layer mask
active selection != pixel layer
active selection != node output
selected layer frame != active selection
selected layer frame != mask bounds
interaction result layer != pixel read source
active selection != pixel read source
```

They may convert into each other through explicit commands, but they are not
the same state.

## State Machine

The image editor should use one selection state machine:

```text
idle
  -> drafting_selection
  -> closed_selection_draft
  -> active_selection
  -> transforming_selection   (future)
  -> idle
```

### `idle`

No draft and no active selection. Tool clicks start a new draft. `Ctrl+J`
performs the ordinary layer duplicate only if the command registry says the
active layer can be duplicated.

### `drafting_selection`

The user is dragging or placing points. The overlay is live solid feedback or
tool-specific anchors. No selection command should consume this state.

### `closed_selection_draft`

The user has a closed shape, but it is still a draft. It remains a solid
outline. The available commands are draft commands:

- Make Selection
- Cancel Draft
- Edit Anchors, where supported
- Convert To Path, where supported later

There should be at most one closed draft unless an explicit multi-draft mode is
introduced. Multiple accidental uncommitted outlines are a bug, not a feature.

### `active_selection`

The draft was committed. The editor now has one unified selection with marching
ants. Tool-specific draft state is gone, except for optional source metadata
used by history, labels, or later re-editing.

The available commands are selection commands:

- Layer Via Copy (`Ctrl+J`)
- Delete / Clear selected pixels
- Invert Selection
- Feather / Refine Edge
- Selection To Layer Mask
- Deselect

### `transforming_selection`

Future state for moving or transforming the active selection boundary. This
must still operate on the active selection object, not on the original drawing
tool.

## Contracts

The exact TypeScript can evolve, but the model should keep these shapes.

```ts
type SelectionSource =
  | "rect_marquee"
  | "ellipse_marquee"
  | "pen"
  | "polygon_lasso"
  | "magnetic_lasso"
  | "object_select"
  | "quick_select"
  | "magic_wand"
  | "sam2"
  | "mask"
  | "path";

type SelectionCombineMode = "replace" | "add" | "subtract" | "intersect";

interface SelectionDraft {
  id: string;
  source: SelectionSource;
  status: "drafting" | "closed";
  combineMode: SelectionCombineMode;
  geometry:
    | { kind: "rect"; region: Rect }
    | { kind: "ellipse"; region: Rect }
    | { kind: "polygon"; points: Point[] }
    | { kind: "bezier_path"; pathId?: string; points: PathPoint[] }
    | { kind: "mask_artifact"; artifactRef: string; bounds: Rect };
  bounds: Rect;
  targetSpace: "document" | "layer";
  targetLayerId?: string;
}

interface ActiveSelection {
  id: string;
  source: SelectionSource;
  bounds: Rect;
  combineMode: SelectionCombineMode;
  outline: SelectionOutline;
  selectionAlphaRef?: SelectionAlphaRef;
  featherPx?: number;
  antiAlias: boolean;
  createdFromDraftId?: string;
  targetSpace: "document" | "layer";
  targetLayerId?: string;
}
```

Important:

- `SelectionDraft` has no `StudioTarget` id yet.
- `ActiveSelection` may become a `StudioTarget`.
- `selectionAlphaRef` is the future high-quality path for anti-aliased,
  feathered, AI, or refined selections.
- `outline` is for display and hit testing; `selectionAlphaRef` is the
  authoritative pixel constraint when available.
- `mask` is reserved for layer masks. Do not name active-selection pixel
  constraints, clip payloads, or future refined-selection artifacts `mask`.
  Those are `selectionAlpha`, `selectionAlphaRef`, or selection-alpha
  artifacts.

## Controllers And Ownership

The code should be split by responsibility, not by tool.

| Module role | Owns | Must not own |
| --- | --- | --- |
| Tool adapter | Pointer gestures for one drawing style. | Selection commands or `Ctrl+J`. |
| Selection controller | Draft lifecycle, active selection lifecycle, one-state rules. | Canvas painting details. |
| Selection compiler | Draft geometry to active selection / selection-alpha artifact. | UI or shortcuts. |
| Overlay scene builder | Which overlays exist and their order. | Business decisions. |
| Renderer (`stagePainter` / WGPU overlay) | Drawing solid draft or marching ants. | Whether a draft is a selection. |
| Command registry | `Ctrl+J`, Delete, Feather, Selection To Mask capabilities. | Tool pointer math. |
| History transaction layer | Undoable document changes and selection/history metadata. | Per-frame pointer updates. |

The key implementation direction:

```text
pointer tool -> SelectionDraft
SelectionDraft -> commitSelection() -> ActiveSelection
ActiveSelection + active StudioTarget -> command capability -> transaction
```

## Rendering Rules

Rendering should be a pure view of state.

| State | Renderer output |
| --- | --- |
| `drafting_selection` | Solid live outline, anchors, handles, or magnetic preview. |
| `closed_selection_draft` | Solid closed outline. No marching ants. |
| `active_selection` | Marching ants only. |
| `transforming_selection` | Marching ants plus transform frame, if enabled. |

The marching-ants phase is a renderer parameter. It must not mutate the
selection state. WGPU and 2D canvas renderers must consume the same overlay
scene; neither renderer may decide whether something is a draft or an active
selection.

## Top Selection Tools And Draft Affordance

All top-center selection tools and their shortcut variants must feed one
selection draft flow:

```text
top selection tool strip / shortcut
  -> tool adapter
  -> SelectionDraft solid geometry
  -> draft affordance model
  -> Make Selection command
  -> ActiveSelection marching ants
```

The draft affordance model owns the compact "Make Selection / Cancel / Edit
Anchors" surface for a closed solid draft. That surface may be shown as a
floating action bar, a right-click menu, or both, but those are only render
views of the same draft command model. Do not duplicate this state in the top
toolbar, a painter, an individual tool component, or a local context-menu
branch.

The draft affordance is anchored from draft geometry in document/layer space
and projected through the same screen-space projection path as the draft
outline. It must not be positioned from DOM image bounds, thumbnail sizes, or
the selected-layer yellow frame. Pan, zoom, stage resize, or opening the
right-click menu may move the projected screen position, but they must not make
the panel jump to another owner, disappear before a command is chosen, or
create a second hidden draft.

When the user chooses Make Selection, the draft is consumed by
`commitSelectionDraft()` and replaced by `ActiveSelection`. After that point the
active selection owns its own marching ants and command availability; the tool
that drew the solid outline is no longer consulted.

## Single Interaction Result Layer

`InteractionResultLayer` is the only DOM/SVG layer for image-editor interaction
results. It is mounted once above `.image-editor-stage` and projected to the
current document frame in screen-space layout pixels, not by CSS-scaling a
cached frame. It owns display placement for:

- selected-layer yellow frame;
- move-preview image;
- selection draft outline;
- active marching-ants selection;
- live selection SVG;
- brush cursor;
- future transform frames/handles.

`MaskStage` owns the stage, underlay, canvas, pointer wiring, view transform,
and the single screen-space projection rect used by `InteractionResultLayer`.
It must not mount another selected-frame, selection, move-preview, or transform
overlay outside `InteractionResultLayer`, and it must not let those result
visuals ride the image frame's CSS scale path.

Selected-layer-frame geometry is resolved by Rust through
`resolve_selected_layer_frame`. TypeScript may call the command and render the
returned rect, but it must not re-implement layer-op geometry, asset placement,
layer-mask clipping, transform accumulation, or move-draft math. If the Tauri
command is unavailable, the UI should fail that operation instead of inventing a
second browser-side geometry path.

The current selected-layer-frame pipe is:

```text
image_document.rs::selected_layer_frame()
  -> Tauri command resolve_selected_layer_frame
  -> selectedLayerFrame.ts bridge
  -> InteractionResultLayer
  -> SelectedLayerFrameOverlay
```

The current selection pipe is:

```text
selection controller / overlay scene
  -> InteractionResultLayer
  -> SelectionOverlay / live SVG
```

Future WGPU presentation must consume the same result state. It can change how
the result is drawn; it cannot introduce another source of truth for selection
or selected-layer-frame geometry.

## Pixel Read Source Layer

The image editor needs one named read boundary for commands that create pixels
from existing pixels. Call it `LayerPixelReadSource`.

`LayerPixelReadSource` means:

- the active editable pixel layer in the document layer stack;
- its source image content, including the implicit opened base image when the
  base layer has no explicit `source_image` op yet;
- that layer's ordered pixel/edit ops that define its current content;
- its document-space placement, scale, and transform as interpreted by the
  compositor/materializer at command time;
- its layer mask only when the command is explicitly defined to read the masked
  result. If a future command needs "read before mask", that must be a separate
  named command mode.

`LayerPixelReadSource` does not mean:

- `InteractionResultLayer`;
- `SelectedLayerFrameOverlay`;
- selection draft outline or marching ants SVG;
- WGPU/DOM preview pixels;
- thumbnail pixels;
- the selected-layer yellow frame;
- a mask target, path target, adjustment target, or node output.

`ActiveSelection` is only a `ReadConstraint`. It clips the read source; it is
not the read source. Therefore rectangle marquee, ellipse marquee, pen, lasso,
magnetic lasso, object select, quick select, magic wand, SAM 2, and future
selection sources all feed the same `ReadConstraint` contract after commit.

The read happens against the current document state at the moment the command
runs. If the active layer has been moved, scaled, transformed, or produced by a
previous operation, `LayerPixelReadSource` is the compositor/materializer's
authoritative interpretation of those pixels under the `ActiveSelection`, not a
screen rectangle copied from the current preview. This is the boundary that
keeps `Ctrl+J` correct when the visible layer no longer matches its original
asset size or placement.

The `Ctrl+J` chain must stay:

```text
selection source tool
  -> SelectionDraft
  -> ActiveSelection / ReadConstraint
active layer target
  -> LayerPixelReadSource
LayerPixelReadSource + ReadConstraint
  -> duplicate layer transaction
  -> compositor/materializer produces the copied pixels
```

In today's implementation, the transaction records this by copying the source
layer's ops and attaching the active selection as `clip`; in the image workspace
the implicit base image is materialized as a `source_image` op before clipping.
When the selection is rect/ellipse/polygon, the clip records that geometry.
When the selection is pixel-shaped, the clip records `selectionAlpha`, an RLE
alpha map bounded by `clip.region`. The Rust compositor then rasterizes
`source_image.clip` and true layer masks when it materializes the visible
result. Future WGPU compute may accelerate the same materialization, but it
cannot read from the visual overlay layer or invent a second read source.

## Selection Assist Read

Selection tools split into two families:

| Family | Examples | Reads pixels while drafting? | Output |
| --- | --- | --- | --- |
| Pure geometry draft tools | Rect, ellipse, pen, polygon lasso | No. They only record geometry. | `SelectionDraft` |
| Pixel-assisted draft tools | Magnetic lasso, object selection, quick selection, wand, SAM/model tools | Yes, through an explicit assist-read path. | `SelectionDraft` |

Magnetic lasso must not be treated as an ordinary geometric marquee. It needs a
`SelectionAssistReadSource` built from the active editable pixel layer's
materialized pixels, including that layer's current placement, scale, transform,
and relevant layer ops. This is the same conceptual source family as
`LayerPixelReadSource`, but it is read for tool assistance only and must remain
separate from command-time pixel copy.

`SelectionAssistReadSource` does not mean:

- the whole document composite;
- the underlay image;
- the selected-layer yellow frame;
- the SVG/DOM interaction layer;
- thumbnail pixels;
- a stale viewport readback that does not match the active layer and frame.

Rules:

- assist reads are triggered by an active tool gesture, such as magnetic-lasso
  pointer down, not by merely selecting a tool;
- the current implementation entry is the Rust/Tauri command
  `read_selection_assist_pixels`, called from `readSelectionAssistPixels()`;
  magnetic lasso must use this command path for edge-map pixels instead of
  decoding the underlay image or reading the viewport/composite surface;
- assist reads are cached only as transient gesture/tool-assist state;
- assist reads may help shape a `SelectionDraft`;
- assist reads must never create or mutate layers;
- assist reads must never be used by `Ctrl+J`, Delete, Invert, Feather, Studio
  Action, or any command that reads/copies pixels;
- assist reads must be discarded when the gesture ends, the visible window
  changes, the active layer changes, or the source key no longer matches.

Do not prewarm assist reads on idle just because a tool is selected. If a future
tool wants prediction or pre-analysis, it must go through a named scheduler with
explicit cancellation, source keys, and performance limits, and it still cannot
become the command-time pixel read source.

## Context Menu Rules

Right-click behavior is state-specific:

| Hit target | Menu |
| --- | --- |
| Closed draft | Make Selection, Cancel Draft, Edit Anchors where supported. |
| Active selection | Deselect, Invert, Feather, Layer Via Copy, Selection To Mask. |
| Path target | Make Selection, Edit Anchors, Delete Path. |
| Empty canvas | Canvas/tool context only. |

The context menu should never hide the draft outline before the user chooses a
command. If a right-click opens the menu, the solid draft remains visible.

## `Ctrl+J` / Layer Via Copy

`Ctrl+J` must be implemented as one command:

```text
active selection + active editable pixel layer
  -> resolve LayerPixelReadSource from the active pixel layer
  -> treat ActiveSelection as ReadConstraint
  -> copy constrained pixels from that read source
  -> create a new pixel layer above the source
  -> preserve source transform, color profile, blend defaults, group label where safe
  -> make the new layer active
  -> record one undoable history transaction
```

Rules:

- `Ctrl+J` never reads the selected tool.
- `Ctrl+J` never reads from `InteractionResultLayer`, DOM/SVG overlays, WGPU
  preview pixels, thumbnails, or the selected-layer yellow frame.
- `Ctrl+J` never consumes a `SelectionDraft`; the draft must be committed first.
  If a closed solid draft exists, the command surface should guide the user to
  Make Selection instead of guessing from the draft geometry.
- `Ctrl+J` reads only from the active editable pixel layer's
  `LayerPixelReadSource`, constrained by `ActiveSelection` when one exists.
- `Ctrl+J` is an immediate document transaction against the current document
  state. It must not wait for thumbnail refresh, native surface presentation,
  image-preview transport, or overlay repaint.
- If no active selection exists, `Ctrl+J` may perform ordinary layer duplicate,
  but that is a different capability branch of the same command.
- If the active target is a layer mask, path, adjustment layer, or node output,
  the capability resolver must either disable `Ctrl+J` or route to an explicit
  target-safe command. It must not guess.
- After `Ctrl+J` succeeds with an active selection, clear the active selection
  and remove the marching ants. Layer Via Copy is treated as a completed
  selection-consuming command in this product surface, so later edits do not
  accidentally stay constrained by the previous selection.

This command should be tested with every selection source:

- rectangle marquee
- ellipse marquee
- pen path
- polygon / magnetic lasso polygon
- selection-alpha artifact selection
- future SAM/object selection

The expected result is always "new layer from active selection", not
tool-specific output.

## History And Persistence

Selection history should distinguish draft interaction from committed edits.

| Action | History behavior |
| --- | --- |
| Move pointer while drafting | No document history entry. |
| Close draft | Optional UI/session history only. |
| Make Selection | Records active selection state if selections are persisted. |
| `Ctrl+J` | Records a full document transaction with the new layer, then clears the active selection UI state. |
| Delete selected pixels | Records a full document transaction. |
| Deselect | Records selection state only if the product wants reselect/session restore. |

Long-term project persistence should be able to restore old editor history
steps, including the layer stack at that point. A layer-via-copy history entry
therefore cannot store "new empty layer" plus a hidden reference to current
selection. It must store the resulting document state or a deterministic
operation record that replays against the historical selected layer and
selection alpha.

## Studio Action Boundary

Studio Action and agent calls can target only committed, addressable states.

Allowed:

```text
ActiveSelection(selectionId) -> selection_to_layer_mask
ActiveSelection(selectionId) + PixelLayer(layerId) -> layer_via_copy
Path(pathId) -> make_selection
SelectionAlphaArtifact(selectionAlphaRef) -> make_selection
```

Not allowed:

```text
SelectionDraft -> StudioAction target
current tool -> layer_via_copy
right-click menu item -> hidden document mutation
agent -> raw edit_paths write
```

If an assistant wants to use a pen/magnetic/box hint, it must create or request
a committed selection or selection-alpha artifact first, then run the next
action.

## WGPU Boundary

WGPU is a renderer and compute/presentation layer. It does not own selection
semantics.

WGPU may own:

- presenting the image editor frame on the native viewport surface as the
  normal desktop path, with PNG transport only as a platform/hardware fallback;
- drawing the active selection ants at viewport detail;
- drawing solid draft overlays at viewport detail when moved off the DOM canvas;
- compositing selection-alpha previews and true layer-mask tint textures;
- caching `selectionAlpha` textures and upload resources.

WGPU must not own:

- deciding draft vs active selection;
- deciding whether `Ctrl+J` is enabled;
- inventing a second selection id or second selection history;
- converting a path to a selection without going through the selection
  compiler/command layer.

## Implementation Order

### Current Code Landing

The first implementation slice now exists in the image editor code:

- `selection.ts` defines `SelectionDraft` and `ActiveSelection`; solid draft
  geometry and marching-ants selection are separate states.
- `useSelectionController.ts` owns draft commit/cancel, active selection clear,
  and the single active-selection ref used by command dispatch. It must not
  expose a "visible selection resize" path that treats solid drafts and active
  marching ants as the same editable object.
- `selectionActions.ts` applies the active selection as an exact edit `clip`
  for ordinary paint/path/op actions. Polygon selections must stay polygon
  clips; they must not fall back to only their bounding box.
- `selectionCommands.ts` owns keyboard/system selection command resolution for
  Clear, Escape/Cancel, Delete, Invert, Duplicate, Deselect, and Feather.
  `Ctrl+J` / Layer Duplicate with an active selection is Layer Via Copy and
  clears the active marching-ants selection after dispatch. The selection
  context menu's Deselect, Invert, Feather, and Layer Via Copy items route
  through `runImageEditorCommand()` and the same resolver, so the menu, the
  shortcuts, and the Layers panel share one selection command path.
- `runImageEditorCommand()` and the Layers panel duplicate button route layer
  duplicate through the same selection command resolver, so shortcuts, context
  actions, and layer-panel actions do not fork selection semantics.
- `duplicateLayer()` is the current transaction writer for Layer Via Copy. It
  does not read pixels from UI overlays; it records the active layer's
  `LayerPixelReadSource` plus the active selection `ReadConstraint` as clipped
  layer ops for the compositor/materializer.
- `buildSelectionOverlayScene()` in `selection.ts` is the one place that
  decides which selection representation renders: a solid draft outline always
  suppresses the marching ants. The SVG overlay (`SelectionOverlay`), the 2D
  canvas renderer (`paintStage`), and the WGPU host scene
  (`buildViewportOverlayScene`) all consume this shared scene instead of
  making their own draft/active decisions.
- `image_document.rs::selected_layer_frame()` is the only selected-layer-frame
  geometry authority. It resolves the selected layer's asset/frame bounds plus
  transform and optional move draft, and intentionally ignores masks, selection
  clips, normal edit ops, inverse/color/brush regions, and Layer Via Copy source
  clips.
- `selectedLayerFrame.ts` is only an IPC bridge to the Rust command. It must not
  grow a browser-side geometry implementation.
- `InteractionResultLayer.tsx` is the only DOM/SVG mount point for interaction
  result visuals: selected-layer frame, selection draft, marching ants, move
  preview, brush cursor, and future transform handles all pass through it.
- `stageProjection.ts` is the only current screen-space projection helper for
  that interaction layer. It converts stage size plus zoom/pan into layout
  pixels so SVG strokes stay sharp instead of being CSS-scaled with the image
  frame.
- The top selection tool strip, context menus, and draft action bar now share
  the same draft command model: solid draft first, explicit Make Selection,
  then active marching ants. No toolbar button or floating panel owns a private
  draft/selection state.
- `surfacePresentation.ts` defines the image-editor native-surface policy. The
  native viewport surface is the default display path; only states the surface
  cannot represent, such as rotate-view, transparency-only preview, crop view,
  grade preview, or enter/leave animation, may fall back to PNG.

This is still a first command layer, not the final full command registry. The
remaining long-term work is to move future Feather, Refine Edge, Selection To
Mask, and persistent selection targets into the same resolver/capability path
instead of adding one-off handlers.

1. Add a first-class selection state model that contains both `draft` and
   `active`, replacing ad-hoc `workSelection` / `lastMarquee` naming.
2. Move rectangle, ellipse, pen, and polygon lasso into pure geometry
   `SelectionDraft` producers.
3. Move magnetic lasso and other pixel/model-assisted tools into assist-read
   `SelectionDraft` producers that use `SelectionAssistReadSource` only while
   the tool gesture is active.
4. Add `commitSelectionDraft()` as the only path from solid outline to active
   marching ants.
5. Move right-click "Make Selection", the draft action bar, and
   `Enter`/confirm behavior onto the same draft command model.
6. Move `Ctrl+J`, Delete, Invert, Feather, Deselect, and Selection To Mask onto
   the command registry and capability resolver.
7. Add tests that every selection source produces the same `ActiveSelection`
   contract.
8. Add tests that `Ctrl+J` ignores the tool id and depends only on active
   selection + active editable pixel layer.
9. Add overlay-scene tests that solid drafts and active marching ants cannot
   render at the same time for the same candidate.
10. Wire WGPU/2D canvas renderers to the same overlay scene.
10. Only then add stronger selection tools or model-assisted selection.

## Review Checklist

Before accepting image-editor selection work:

- Does the tool produce a draft, not a command result?
- Is there only one active selection state?
- Does the active selection survive independently of the tool that created it?
- Does `Ctrl+J` read active selection + active target, not tool id?
- Does `Ctrl+J` resolve `LayerPixelReadSource` from the active editable pixel
  layer at command time, including layer placement/scale/transform, with
  `ActiveSelection` only as a read constraint?
- Did the change avoid reading pixels from `InteractionResultLayer`, DOM/SVG
  overlays, WGPU preview pixels, thumbnails, or the selected-layer yellow frame?
- Is there only one draft affordance model for Make Selection / Cancel / Edit
  Anchors, shared by the top tool strip, right-click menu, and floating action
  bar?
- Is the draft affordance projected from draft geometry through the same
  interaction projection path, instead of being positioned from DOM image
  bounds, preview pixels, toolbar state, or the selected-layer frame?
- Does `Ctrl+J` clear the marching-ants selection after a successful Layer Via Copy?
- Does a closed draft stay visible while its context menu is open?
- Are solid drafts and marching ants visually distinct?
- Can the command capability resolver explain why `Ctrl+J` is disabled?
- Does WGPU consume the same overlay scene as the 2D canvas renderer?
- Are selection ids created only after commit?
- Did the change avoid introducing a second mask/layer/selection meaning?
- Did the change route interaction visuals through `InteractionResultLayer`
  instead of mounting a second overlay chain?
- Did selected-layer-frame geometry stay in Rust, with TypeScript only calling
  the command and rendering the returned result?
- Did the selected-layer yellow frame stay limited to the selected layer/element
  bounds, not selection, mask, crop, brush, inverse, or copied-pixel bounds?

## Related Documents

- [`MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md`](MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md):
  selection targets, layer masks, and Studio Action safety.
- [`../../design/image-editor-ui-structure.md`](../../design/image-editor-ui-structure.md):
  frontend file boundaries and modal ownership.
- [`../../design/ps-editor-architecture.md`](../../design/ps-editor-architecture.md):
  long-term Photoshop-grade image editor architecture.
- [`../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md):
  viewport presentation and overlay rendering boundary.
