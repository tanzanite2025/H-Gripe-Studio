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
    PanelDock.tsx            ← generic PS-style tabbed dock group
    MaskToolbar.tsx          ← left icon rail (+ flyouts)
    MaskStage.tsx            ← the canvas element + view transform
    stagePainter.ts          ← ALL overlay canvas painting (pure functions)
    ToolOptionsPanel.tsx     ← per-tool options (top dock)
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
   Paths, Properties, …) is a new component in `maskEditModal/` plus one
   `DockPanel` entry in `MaskEditModal` — never bespoke tab markup.
3. **Styles go in `maskEditModal.css`, not the global `styles.css`.** Express
   PS design-language values through the tokens at the top of that file
   (`--ps-dock-border`, `--ps-tab-strip`, `--ps-hover`, `--ps-active-overlay`,
   `--ps-row-h`) instead of repeating hex literals. New tokens are fine —
   literals sprinkled across rules are not.
4. **State model changes go through the reducer** (`maskEditModal/actions.ts`
   \+ `maskEdit.ts`), never by mutating `MaskDocument` in a component.
5. **Panels receive props, not the whole state.** If a panel needs six new
   props, consider whether the logic belongs in the reducer or a hook instead.

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
