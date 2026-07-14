# Image Editor UI: file structure and contribution rules

Scope: the frontend of the software-level image editor under
`apps/desktop-tauri/studio-ui/src/editor`, plus the viewport identity boundary
it consumes under `apps/desktop-tauri/studio-ui/src/viewport`.

The image editor is not a node-card widget and not a mask-only popup. Canvas
nodes, preview gates, and image-source cards may open it with context, but the
editor owns its own panels, shortcuts, viewport, state reducer, and command
execution boundary.

This file freezes only frontend file ownership. Rendering, layer positioning,
navigation, dragging, selected-layer frames, Image Size, and `Ctrl+J` are
defined exclusively by
[`../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).
Do not restate or override that protocol here.

## File Responsibilities

```text
src/editor/
  ImageEditorModal.tsx       -> orchestrator only: state wiring, shortcut
                                 scope, pointer dispatch, panel composition.
                                 Do not add drawing code or panel markup here.
  imageEditorState.ts        -> edit-state history, commit boundary, layer and
                                 operation mutations, snapshots, and migrations.
  imageLayerSource.ts        -> source_image discovery, source-content
                                 predicates, and composite backing-path lookup.
  imageLayerTransform.ts     -> TransformParams and transform composition math.
  imageLayerGeometry.ts      -> compatibility content-bounds and committed
                                 layer-transform resolution helpers.
  imageCompositeTarget.ts    -> resource-backed image-scene target construction,
                                 document scene keys, dimensions, and frame
                                 sanitizing. The resource target stays stable
                                 while document revisions change.
  imageEditorLayerDuplication.ts -> pure Ctrl+J duplicate-document builder.
                                 imageEditorState owns the history commit; the
                                 current selection clip-copy branch is isolated
                                 here until its protocol migration replaces it.
  imageEditorTools.ts        -> image-editor tool registry.
  maskMorphology.ts          -> real mask/alpha proxy math only.
  canvasView.ts              -> zoom, pan, and rotate view math.
  selectedLayerFrame.ts      -> type-only contract for selected-layer metadata
                                 returned with the rendered viewport frame.
  selectionAssistRead.ts     -> explicit pixel read source for assisted tools.
  imageEditorModal/          -> image-editor-modal-specific UI and gestures.
    actions.ts               -> reducer actions shared by shell and panels.
    PanelDock.tsx            -> PS-style dock group, render-only.
    dockLayout.ts            -> dock layout as data and persistence.
    ImageEditorToolbar.tsx   -> icon rails and tool slots.
    ImageEditorStage.tsx     -> stage layout/input shell and child-layer
                                 composition; target/resource work stays out.
    ViewportFrameLayer.tsx   -> rendered browser-frame presentation, native
                                 placement anchor, and decoded-pixel reporting.
    useObservedElementSize.ts -> reusable positive integer CSS-size observer.
    useRegisteredImageResource.ts -> backing-path registration, dimension
                                 probing, and stale async-result cancellation.
    layerMovePreviewStore.ts -> requestAnimationFrame-paced layer-preview
                                 transaction (`transactionId`, document key,
                                 sequence, and one move delta).
    useImageEditorViewport.ts -> editor viewport orchestration: navigation,
                                 stable resource target, atomic document-scene
                                 commits, layer-preview transactions, overlays,
                                 and native presentation.
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
src/viewport/
  viewportTargetIdentity.ts  -> stable resource target/host identity plus the
                                 independently changing image-scene revision key.
  useViewportUnderlay.ts     -> one desired-state controller per host; orders
                                 target, `set_image_scene`, view/overlay, and
                                 `present_image_layer_scene` before rendering,
                                 then exposes same-frame metadata only when the
                                 exact target/scene transaction was presented.
src/bridge/viewport/
  contracts.ts               -> image-scene commit, layer-presentation
                                 transaction, and viewport-frame metadata types.
  client.ts                  -> thin Tauri calls; no image-editor geometry.
```

## Retained Scene Landing

The current image-editor viewport path has one stable resource target and one
mutable retained scene:

```text
resource registration
  -> stable image_composite:<resourceId> target and viewport host
  -> viewport_set_image_scene(document revision)
  -> atomic retained-layer-node swap
  -> viewport_present_image_layer_scene(transaction)
  -> render pixels plus selectedLayerFrame metadata in the same frame payload
```

`viewport_set_image_scene` prepares the complete replacement off the active
state and swaps it only after every retained layer node is ready. A selection
or drag updates only the layer-presentation transaction; it does not replace
the target, rebuild the host, or create a second moving-layer pixel surface.
The returned `documentKey`, `transactionId`, and `sequence` gate both the
pixels and the yellow-frame metadata at the frontend boundary.

The former `SelectedLayerMoveSurface`, `selectedLayerMove/` cache/preload
modules, moving-layer hidden-document retarget, and separate selected-layer
frame request hook have been deleted. `sceneFrame.ts` now defines only a
rectangle type, and `selectedLayerFrame.ts` defines only the metadata type.
Do not restore a command, cache, retry, or fallback behind either file.

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
7. **Rendering behavior has one authority.** Do not add local scene-frame,
   move-surface, stale-frame, clip-positioning, per-layer canvas, or pixel-read
   rules to this file. Follow the active shared-canvas protocol linked above.

## Styling Tokens

The editor follows a compact PS-style dock language. Canonical values live in
`imageEditorModal.css`.

Dock groups are square-cornered; active rows use neutral contrast; command
buttons and tool icons must remain visually distinct from the app shell.
