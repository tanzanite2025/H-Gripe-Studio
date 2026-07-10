# Mask editor UI: file structure & contribution rules

Scope: the frontend of the mask-edit modal (`apps/desktop-tauri/studio-ui/src/editor`).
For the long-term PS-parity architecture (document model, execution layer) see
`ps-editor-architecture.md`. This document freezes **where frontend code goes**
so the editor keeps absorbing PS features without any single file re-bloating.

## File responsibilities

```
src/editor/
  MaskEditModal.tsx          ← orchestrator ONLY: state wiring, shortcut table,
                               pointer→dispatch routing, panel composition.
                               Do NOT add drawing code or panel markup here.
  maskEdit.ts                ← edit-state model (undo/redo stacks, layers, ops)
  maskTools.ts               ← tool registry (a new tool = one registry row)
  maskMorphology.ts          ← pixel maths: proxy rasterisation, grow/feather/…
  canvasView.ts              ← zoom / pan / rotate view maths (pure)
  maskEditModal/             ← everything mask-modal-specific lives here
    actions.ts               ← the modal's reducer (dispatch actions)
    PanelDock.tsx            ← generic PS-style tabbed dock group (render-only)
    dockLayout.ts            ← dock layout as data: groups/tabs/rail width,
                               pure move/select/resize fns + persistence hook
    MaskToolbar.tsx          ← left icon rail (+ flyouts)
    MaskStage.tsx            ← the canvas element + view transform
    stagePainter.ts          ← ALL overlay canvas painting (pure functions)
    selection.ts             -> selection state contracts: draft vs active
                               selection shapes shared by shortcuts, context
                               menus, overlay scene, and commands
    ToolOptionsPanel.tsx     ← per-tool options (top dock)
    PropertiesPanel.tsx      ← active adjustment layer's parameters (PS 属性)
    InfoPanel.tsx            ← mask info (top dock)
    LayersPanel.tsx          ← PS-style layers panel (bottom dock)
    CurveEditor.tsx          ← draggable tone-curve grid (curve adjustment)
    HistoryPanel.tsx         ← history steps (bottom dock)
    toolIcons.tsx            ← SVG tool icons
    maskEditModal.css        ← ALL mask-editor styles + PS design tokens
```

## Rules (enforce these in review)

1. **`MaskEditModal.tsx` must not grow logic.** It owns React state and glues
   the pieces together. New behaviour goes into the appropriate module:
   - canvas drawing → a pure painter in `stagePainter.ts` (ctx + data in,
     pixels out; no React state, no refs);
   - a new tool → a registry row in `maskTools.ts` + its painter / pointer
     branch; keep the pointer branch a thin dispatch;
   - view/navigation maths → `canvasView.ts`.
2. **Right-rail panels register through `PanelDock`.** A new panel (Channels,
   Paths, …) is a new component in `maskEditModal/` plus one entry in
   `MaskEditModal`'s panel map and the default layout in `dockLayout`'s
   consumer — never bespoke tab markup. Panels render a headerless
   `.mask-panel-body`; the dock's tab strip is the only chrome.
   **The dock layout itself is data** (`dockLayout.ts`): which tabs live in
   which group, the active tab per group, and the rail width. Users re-dock
   tabs by dragging and resize the rail; the layout persists in localStorage
   (`hgripe.studio.maskDock.v1`) and is reconciled against the known panel
   ids on load. Never hard-code group membership in JSX.
3. **Styles go in `maskEditModal.css`, not the global `styles.css`.** Express
   PS design-language values through the tokens at the top of that file
   (`--ps-dock-border`, `--ps-tab-strip`, `--ps-hover`, `--ps-active-overlay`,
   `--ps-row-h`) instead of repeating hex literals. New tokens are fine —
   literals sprinkled across rules are not.
4. **State model changes go through the reducer** (`maskEditModal/actions.ts`
   \+ `maskEdit.ts`), never by mutating `MaskDocument` in a component.
5. **Selection tools create drafts; commands consume active selections.** The
   selection state contract is defined in
   `../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`. Pointer
   handlers may create/update/cancel a solid selection draft, but must not own
   `Ctrl+J`, Delete, Feather, Selection To Mask, or Studio Action behavior.
6. **Panels receive props, not the whole state.** If a panel needs six new
   props, consider whether the logic belongs in the reducer or a hook instead.

## Workspaces & the node-result → image-editor pipeline

The same modal serves two product surfaces via the `workspace` prop:

- **`workspace="mask"`** — the node-bound mask popup. Opened from a mask node
  (or the Preview gate's `Edit`); commits write `edit_paths` back onto the
  node and re-run it. Mask-only chrome (mask-only view, quick mask, the
  paths / mask-ops docks) exists **only** here.
- **`workspace="image"`** — the standalone image editor (`MediaEditModal`).
  No mask chrome; its right rail is adjustments/options +
  layers/channels/history.

**Pipeline rule:** any node result — subject mask today, future local-LLM /
API / algorithm cards — enters the image editor through one route:

```
node result → PreviewModal (review gate) → "Image editor" entry
           → openMediaEdit(nodeId) → EditorRequest{ editor:"media",
               target:{ imagePath: cutout ?? last output ?? source path, nodeId } }
```

New result-producing cards get this for free by populating the node's result
fields (`cutoutImagePath` / `imagePath`); never add a bespoke editor entry
per card.

## Selection state boundary

Selection tools are not selection commands. The top selection row and the left
toolbar variants (pen, marquee, ellipse, polygon/magnetic lasso, object/quick
selection, wand/SAM variants) may draw different geometry, but they all feed
the same state model defined by
[`../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).

```text
tool pointer handler -> SelectionDraft
SelectionDraft -> Make Selection -> ActiveSelection
ActiveSelection + active target -> command
```

Implementation consequences:

- `pointer/*` modules may create/update/cancel a draft, but must not implement
  `Ctrl+J`, Delete, Feather, Selection To Mask, or other selection commands.
- `stagePainter.ts` / WGPU overlay code only renders state: solid outline for a
  draft, marching ants for an active selection.
- `ContextActionBar` and context menus render command models; capability checks
  live in the command layer, not in toolbar or painter code.
- `Ctrl+J` must read the active selection plus the active editable pixel layer.
  It must not branch on whether the selection came from pen, marquee, lasso,
  wand, or a model-assisted tool.
- A solid closed draft is not a `StudioTarget` and cannot be called by Studio
  Action until it is explicitly committed into an active selection.

## PS design tokens

The right rail follows PS's dark dock language. The canonical values live in
`maskEditModal.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--ps-dock-border` | `#0c0e13` | hairline borders, row dividers |
| `--ps-tab-strip` | `#11131a` | inactive tab strip, input wells |
| `--ps-hover` | `#2a2f3d` | hover wash on flat icon buttons |
| `--ps-active-overlay` | `rgba(255,255,255,0.14)` | neutral grey active-row highlight |
| `--ps-row-h` | `34px` | layer-row height |

Dock groups are square-cornered; the active tab shares the panel body colour
with no seam; active rows highlight with the neutral grey overlay (never an
accent-coloured pill).
