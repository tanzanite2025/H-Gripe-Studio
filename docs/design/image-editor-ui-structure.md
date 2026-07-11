# Image Editor UI: file structure and contribution rules

Scope: the frontend of the software-level image editor under
`apps/desktop-tauri/studio-ui/src/editor`.

The image editor is not a node-card widget and not a mask-only popup. Canvas
nodes, preview gates, and image-source cards may open it with context, but the
editor owns its own panels, shortcuts, viewport, state reducer, and command
execution boundary.

For the longer PS-grade architecture, see `ps-editor-architecture.md`. This
file freezes where frontend code goes so PS-style features can be added without
turning one file back into a catch-all component.

## File Responsibilities

```text
src/editor/
  ImageEditorModal.tsx       -> orchestrator only: state wiring, shortcut
                                scope, pointer dispatch, panel composition.
                                Do not add drawing code or panel markup here.
  imageEditorState.ts        -> edit-state model: history, layers, operations,
                                snapshots, migrations, and pure state helpers.
  imageEditorTools.ts        -> image-editor tool registry.
  maskMorphology.ts          -> real mask/alpha proxy math only.
  canvasView.ts              -> zoom, pan, and rotate view math.
  selectedLayerFrame.ts      -> selected element frame resolution.
  selectionAssistRead.ts     -> explicit pixel read source for assisted tools.
  imageEditorModal/          -> image-editor-modal-specific UI and gestures.
    actions.ts               -> reducer actions shared by shell and panels.
    PanelDock.tsx            -> PS-style dock group, render-only.
    dockLayout.ts            -> dock layout as data and persistence.
    ImageEditorToolbar.tsx   -> icon rails and tool slots.
    ImageEditorStage.tsx     -> stage element and view transform shell.
    stageScene.ts            -> overlay scene assembly and painter calls.
    selectionToolProtocol.ts -> geometry vs pixel-assisted selection families.
    ContextActionBar.tsx     -> command affordances for draft/active selection.
    ToolOptionsPanel.tsx     -> per-tool options.
    WholeMaskOperationsPanel.tsx -> true whole-mask operations only.
    LayersPanel.tsx          -> PS-style layers panel.
    ChannelsPanel.tsx        -> channel and mask visibility controls.
    PathsPanel.tsx           -> vector paths.
    AdjustmentsPanel.tsx     -> image adjustments.
    HistoryPanel.tsx         -> history snapshots.
    InfoPanel.tsx            -> document/layer info.
    imageEditorModal.css     -> all image-editor modal styles and tokens.
```

## Rules

1. **`ImageEditorModal.tsx` stays an orchestrator.** New behavior belongs in a
   focused module: pure drawing in `stageScene.ts`/viewport overlay helpers,
   pointer behavior in `pointer/` or `pointerMachine.ts`, view math in
   `canvasView.ts`, state mutation in the reducer and `imageEditorState.ts`.
2. **Panel UI registers through `PanelDock`.** A new panel is a component in
   `imageEditorModal/` plus one dock entry. Do not hand-code a second tab
   system inside the modal.
3. **Styles stay local.** Image editor styles belong in
   `imageEditorModal.css`; they must not leak into the global app shell or the
   video editor drawer. Shared app tokens are fine, but editor chrome is local.
4. **State changes go through the reducer.** Components do not mutate
   `ImageEditorDocument`, layer arrays, selection state, or command results
   directly.
5. **`mask` has one meaning.** Use `mask` only for real masks: layer masks,
   active mask targets, quick-mask preview, mask alpha/coverage, and true
   whole-mask operations. Do not use `mask` to mean image editor, editor
   document, modal state, generic selection, node result, or UI shell.
6. **Node context is data only.** A node or preview can open the image editor
   with an image path, node id, or save-back target. The image editor must not
   depend on node-card layout, node canvas state, or graph UI components.
7. **Selection tools create drafts; commands consume active selections.** The
   selection protocol is defined in
   `../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`.

## Selection Boundary

Selection tools are not selection commands.

```text
toolbar / shortcut / context entry
  -> tool pointer handler
  -> solid SelectionDraft
  -> Make Selection
  -> ActiveSelection
  -> command reads ActiveSelection + active editable target
```

Implementation consequences:

- Geometry tools such as rectangle, ellipse, pen, and polygon lasso create
  solid draft geometry without reading pixels.
- Pixel-assisted tools such as magnetic lasso read pixels only through
  `SelectionAssistReadSource`, and only from the active editable layer material
  resolved for that tool.
- `Ctrl+J` reads the active selection plus the active editable pixel layer's
  `LayerPixelReadSource`, including placement/scale/transform resolved by the
  compositor/materializer. It must not branch on which tool created the
  selection.
- Solid drafts, marching ants, selected-layer frames, and command affordances
  are separate overlay products. Do not merge their state or make one overlay
  secretly drive another.
- A solid closed draft is not a `StudioTarget` and cannot be called by Studio
  Action until it is explicitly committed into an active selection.

## Selected-Layer Frame Boundary

The yellow selected-layer frame is not a selection. It is an independent
display overlay resolved from the active element/layer bounds after current
placement, scale, rotation, crop, and viewport transform.

Rules:

- Selecting a layer or element updates the selected-layer frame.
- Moving a layer moves the layer data first; the frame follows from the same
  resolved materialized bounds. The frame must not become the object being
  moved.
- The frame remains a rectangular bounds overlay even for irregular pixels,
  text, vector paths, or cut-out layers.
- Selection commands must not read pixels from the selected-layer frame. Pixel
  extraction uses the active selection plus `LayerPixelReadSource`.

## Styling Tokens

The editor follows a compact PS-style dock language. Canonical values live in
`imageEditorModal.css`.

Dock groups are square-cornered; active rows use neutral contrast; command
buttons and tool icons must remain visually distinct from the app shell.
