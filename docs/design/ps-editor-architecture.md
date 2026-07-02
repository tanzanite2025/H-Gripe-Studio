# Mask-Edit modal → PS-grade image editor: architecture plan

Goal: the mask-edit modal (`MaskEditModal`) gradually grows into a
Photoshop-grade integrated image editor. This is not a one-shot re-implementation
— the point of this document is to **freeze the underlying architecture first**,
so every PS feature lands as an increment on the same skeleton and nothing has
to be rebuilt from scratch.

## 1. Existing foundation (in place / directly reusable)

| Foundation | Status | Why it matters for PS parity |
| --- | --- | --- |
| Non-destructive edit record (`EditPaths` JSON) | frontend records (paths / strokes / operations / point prompts); backend Rust rasterises + executes | Structurally the same model as PS's "history + adjustable parameters" — the single most important piece |
| `Compute` executor lane | in-process Rust image/model work, no network | The execution home for every PS filter / transform |
| 16-bit `WorkingImage` + ICC colour pipeline | ProPhoto wide-gamut canvas, CMYK/ICC management, linear-light maths | PS-grade colour correctness is already here |
| Tool registry (`maskTools`) + scoped shortcuts (full PS key table reserved) | `ready`/`planned` declarative registration; i18n + collisions guarded by CI | A new tool = one registry row + an implementation; UI / shortcuts / translations follow automatically |
| Undo/redo, boolean combine, morphology, feather, proxy preview | shipped | The core of the selection system exists |
| Model foundation (`ort`: SAM 2 / BiRefNet / ViTMatte …) | shipped | PS's "Select Subject / Remove Background"-class AI features are already ahead |

## 2. The architecture-level gaps vs PS (four)

1. **Single mask → document model (layer stack).** Today the modal holds "one
   image + one mask". Everything in PS (layers, adjustment layers, blend modes,
   layer masks, smart objects) hangs off a document model.
2. **Commit-freezes → re-editable operation stack.** A committed path's anchors
   cannot be re-edited; an executed operation's (feather/grow) parameters cannot
   be revised. In PS every step is revisitable.
3. **Tools = mask tools → tools acting on any target.** The brush can only
   paint the mask today; PS's brush paints pixel layers, layer masks, and the
   quick mask alike.
4. **Whole-image proxy preview → tiled / dirty-region rendering.** Every edit
   currently recomputes the whole proxy. With multiple layers only dirty tiles
   may be recomputed.

## 3. Target architecture (layered)

```
┌─ UI layer (React)
│   toolbox / options bar / layers panel / history panel  ← all registry-driven
│   shortcuts: mask-edit scope (full PS key table already reserved)
├─ Document model (TS + Rust isomorphic, serde/JSON)
│   Document { canvas, layers: [Layer], selection, history }
│   Layer = PixelLayer | AdjustmentLayer | …  each: blend_mode, opacity, mask?, edits: EditStack
│   EditStack = ordered list of Ops (a generalisation of today's EditPaths);
│               every Op's params stay revisable → non-destructive
├─ Execution layer (Rust, Compute lane)
│   Op registry: each Op is a pure function (input surfaces, params) → surface
│   Compositor: layer stack + blend mode + mask, in the 16-bit working space
│   Render scheduling: proxy resolution + dirty-region recompute
│               (image_buffer grows into a tile cache)
└─ Model layer (ort): SAM 2 / BiRefNet / ViTMatte / future generative fill —
    attached to the EditStack as Ops
```

**Key decision: the document model is the single source of truth; rendering is
always "replay the EditStack + composite".** This guarantees:

- undo/redo = moving the stack pointer (a history panel falls out for free,
  including PS-style history snapshots);
- any step's parameters are revisable (select the `feather` in history, change
  the value, replay);
- the save format = document JSON + source-image references — a project file
  by construction;
- anchor re-editing = selecting a path Op in the EditStack and moving its
  anchors (gap 2 solved directly).

## 4. Roadmap (each milestone independently shippable; the current mask flow never breaks)

**M1 — EditPaths → EditStack (the foundation; no UI change).**
Unify `EditPaths`'s four arrays (`paths` / `brush_strokes` / `operations` /
`points`) into one ordered `ops: [Op]` with versioned migration (old JSON
upgrades automatically; existing workflows keep loading). The backend
(`subject_mask`) replays ops in order. Acceptance: the full existing test suite
plus golden replays of legacy `edit_paths` snapshots produce identical output.

**M2 — History panel + parameter revision + anchor re-editing.**
The UI shows the EditStack as a history list; steps can be disabled / deleted /
re-parameterised; selecting a pen-path Op returns its anchors to the canvas for
re-editing. PS equivalents: History panel, transform path. Shortcuts `A` (path
select) and `Alt+Ctrl+Z` flip from `planned` to `ready`.

**M3 — Minimal layer stack (document model lands).**
`Document`/`Layer` model + compositor: initially two layer kinds (pixel layer,
mask layer) + `normal`/`multiply`/`screen` blends + opacity. The modal gains a
layers panel. Today's "single-mask editing" becomes the single-layer special
case of a document. Acceptance: a single-layer document's output is
byte-identical to today's mask flow.

**M4 — Tool/target decoupling + brush upgrade.**
A Tool acts on the active target (pixel layer / layer mask / quick-mask
selection). The brush gains soft edges / hardness / flow / spacing (`Shift+[`
`]` flip to `ready`). `Q` quick mask and the `D`/`X` foreground-background
semantics flip to `ready`.

**M5 — Transform & crop.** `Ctrl+T` free transform (move / scale / rotate as a
revisable Op), `V` move, `C` crop inside the modal (reusing `CropEditModal`'s
box logic).

**M6 — Adjustment layers + filter Ops.** Levels / curves / hue-saturation /
brightness-contrast as `AdjustmentLayer` (the 16-bit working space pays off
directly); gaussian blur / sharpen as filter Ops. From here on, every feature is
a "registry row + one pure Rust function" increment.

**M7 — Performance layer.** `image_buffer` → tile cache (256 px tiles); the
compositor recomputes dirty tiles only; large-image interaction validated (8K
scenarios). M7 comes after M3 because tiling should wait for the compositor's
shape to stabilise.

**M8 — Canvas navigation.** Zoom / pan as a pure view layer (a CSS transform
on the canvas; the document and the M7 render path are untouched): `H` hand
tool, `Z` zoom tool (click in / Alt+click out, cursor-anchored), Space-hold
pan with any tool, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (fit) / `Ctrl+1` (100%).
Follows M7 so 100% zoom on 8K images lands on an interaction that stays cheap.

**M9 — Selection commands.** `Ctrl+A` select all and `Delete` as recorded ops
(`select_all` / `delete` — history steps, replayed identically by the proxy
and the Rust run, unlike `Ctrl+D` clear which wipes the stack itself);
`Ctrl+Shift+D` reselect (restores the last snapshot a clear dropped, itself
undoable); `Ctrl+J` duplicate the active layer via copy (fresh id, "… copy"
name, active above the source).

## 5. Explicitly deferred / out of scope

- Type tool `T`, shape tools `U`, frame tool `K`: weakly related to the product
  goal (product-image processing); their keys stay reserved, implementation
  deferred indefinitely.
- Smart objects / linked files: the document model reserves a
  `Layer.source_ref` field; not implemented.
- PSD layer-level round-tripping: the psd-tools foundation exists; a separate
  initiative once the document model stabilises.

## 6. Risks and guards

| Risk | Guard |
| --- | --- |
| The M1 migration breaks old workflows | Versioned envelope (the existing `version: 1` mechanism); legacy-format golden replay tests in CI |
| Compositor colour regressions | Reuse the existing byte-identical / golden test pattern; single-layer document ≡ current mask flow as an equivalence test |
| Performance cliff after layering | 4K/8K benchmarks per milestone from M3; a layer-count advisory until M7 |
| Scope creep | Each milestone is an independent PR series; the tool registry's `planned` states publicise what is not yet built |
