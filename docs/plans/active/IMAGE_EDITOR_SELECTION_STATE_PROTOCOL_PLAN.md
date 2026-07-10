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

The tool that drew the shape must not own the command result. A rectangle,
ellipse, pen path, polygon path, magnetic-lasso loop, object selection, quick
selection, magic-wand result, or future model-assisted hint can all create the
same active selection state. After the selection is active, commands must not
branch on which tool created it.

## Core Decision

The editor has two different concepts that must stay separate:

| Concept | Visual state | Meaning | Can `Ctrl+J` use it? |
| --- | --- | --- | --- |
| Selection draft | Solid outline / anchors / live path | A closed or in-progress candidate drawn by a tool. | No. It must be committed first. |
| Active selection | Marching ants / flowing dashed outline | The current edit constraint, independent of its source tool. | Yes. |

This is the product rule:

```text
solid outline != active selection
active selection != layer mask
active selection != pixel layer
active selection != node output
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
  maskRef?: SelectionMaskRef;
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
- `maskRef` is the future high-quality path for anti-aliased, feathered, AI, or
  refined selections.
- `outline` is for display and hit testing; `maskRef` is the authoritative
  pixel constraint when available.

## Controllers And Ownership

The code should be split by responsibility, not by tool.

| Module role | Owns | Must not own |
| --- | --- | --- |
| Tool adapter | Pointer gestures for one drawing style. | Selection commands or `Ctrl+J`. |
| Selection controller | Draft lifecycle, active selection lifecycle, one-state rules. | Canvas painting details. |
| Selection compiler | Draft geometry to active selection / mask artifact. | UI or shortcuts. |
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
  -> copy selected pixels from the active pixel layer
  -> create a new pixel layer above the source
  -> preserve source transform, color profile, blend defaults, group label where safe
  -> make the new layer active
  -> record one undoable history transaction
```

Rules:

- `Ctrl+J` never reads the selected tool.
- `Ctrl+J` never consumes a `SelectionDraft`; the draft must be committed first.
- If no active selection exists, `Ctrl+J` may perform ordinary layer duplicate,
  but that is a different capability branch of the same command.
- If the active target is a layer mask, path, adjustment layer, or node output,
  the capability resolver must either disable `Ctrl+J` or route to an explicit
  target-safe command. It must not guess.
- Selection persistence after `Ctrl+J` is a command policy. The preferred
  long-term behavior is to keep the active selection until the user deselects,
  because the selection is a state, not a one-shot tool side effect.

This command should be tested with every selection source:

- rectangle marquee
- ellipse marquee
- pen path
- polygon / magnetic lasso polygon
- mask artifact selection
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
| `Ctrl+J` | Records a full document transaction with the new layer. |
| Delete selected pixels | Records a full document transaction. |
| Deselect | Records selection state only if the product wants reselect/session restore. |

Long-term project persistence should be able to restore old editor history
steps, including the layer stack at that point. A layer-via-copy history entry
therefore cannot store "new empty layer" plus a hidden reference to current
selection. It must store the resulting document state or a deterministic
operation record that replays against the historical selected layer and
selection mask.

## Studio Action Boundary

Studio Action and agent calls can target only committed, addressable states.

Allowed:

```text
ActiveSelection(selectionId) -> selection_to_layer_mask
ActiveSelection(selectionId) + PixelLayer(layerId) -> layer_via_copy
Path(pathId) -> make_selection
MaskArtifact(maskRef) -> make_selection
```

Not allowed:

```text
SelectionDraft -> StudioAction target
current tool -> layer_via_copy
right-click menu item -> hidden document mutation
agent -> raw edit_paths write
```

If an assistant wants to use a pen/magnetic/box hint, it must create or request
a committed selection or mask artifact first, then run the next action.

## WGPU Boundary

WGPU is a renderer and compute/presentation layer. It does not own selection
semantics.

WGPU may own:

- drawing the active selection ants at viewport detail;
- drawing solid draft overlays at viewport detail when moved off the DOM canvas;
- compositing selection/mask tint textures;
- caching selection masks and upload resources.

WGPU must not own:

- deciding draft vs active selection;
- deciding whether `Ctrl+J` is enabled;
- inventing a second selection id or second selection history;
- converting a path to a selection without going through the selection
  compiler/command layer.

## Implementation Order

1. Add a first-class selection state model that contains both `draft` and
   `active`, replacing ad-hoc `workSelection` / `lastMarquee` naming.
2. Move rectangle, ellipse, pen, polygon, and magnetic lasso into
   `SelectionDraft` producers.
3. Add `commitSelectionDraft()` as the only path from solid outline to active
   marching ants.
4. Move right-click "Make Selection" and `Enter`/confirm behavior onto the same
   command.
5. Move `Ctrl+J`, Delete, Invert, Feather, Deselect, and Selection To Mask onto
   the command registry and capability resolver.
6. Add tests that every selection source produces the same `ActiveSelection`
   contract.
7. Add tests that `Ctrl+J` ignores the tool id and depends only on active
   selection + active editable pixel layer.
8. Add overlay-scene tests that solid drafts and active marching ants cannot
   render at the same time for the same candidate.
9. Wire WGPU/2D canvas renderers to the same overlay scene.
10. Only then add stronger selection tools or model-assisted selection.

## Review Checklist

Before accepting image-editor selection work:

- Does the tool produce a draft, not a command result?
- Is there only one active selection state?
- Does the active selection survive independently of the tool that created it?
- Does `Ctrl+J` read active selection + active target, not tool id?
- Does a closed draft stay visible while its context menu is open?
- Are solid drafts and marching ants visually distinct?
- Can the command capability resolver explain why `Ctrl+J` is disabled?
- Does WGPU consume the same overlay scene as the fallback renderer?
- Are selection ids created only after commit?
- Did the change avoid introducing a second mask/layer/selection meaning?

## Related Documents

- [`MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md`](MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md):
  selection targets, layer masks, and Studio Action safety.
- [`../../design/mask-editor-ui-structure.md`](../../design/mask-editor-ui-structure.md):
  frontend file boundaries and modal ownership.
- [`../../design/ps-editor-architecture.md`](../../design/ps-editor-architecture.md):
  long-term Photoshop-grade image editor architecture.
- [`../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](../completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md):
  viewport presentation and overlay rendering boundary.
