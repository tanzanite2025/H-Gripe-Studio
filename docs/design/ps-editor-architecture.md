# Image Editor modal → PS-grade image editor: architecture plan

Goal: the image-editor modal (`ImageEditorModal`) gradually grows into a
Photoshop-grade integrated image editor. This is not a one-shot re-implementation
— the point of this document is to **freeze the underlying architecture first**,
so every PS feature lands as an increment on the same skeleton and nothing has
to be rebuilt from scratch.

Rendering and layer positioning are not defined in this roadmap. The sole
authority for shared logical canvas, compact layer pixels/tiles, viewport
composition, camera navigation, dragging, selected-layer frames, Image Size,
and `Ctrl+J` is
[`../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).
Any older wording below must be interpreted through that protocol.

## 1. Existing foundation (in place / directly reusable)

| Foundation | Status | Why it matters for PS parity |
| --- | --- | --- |
| Non-destructive edit record (`EditPaths` JSON) | frontend records (paths / strokes / operations / point prompts); backend Rust rasterises + executes | Structurally the same model as PS's "history + adjustable parameters" — the single most important piece |
| `Compute` executor lane | in-process Rust image/model work, no network | The execution home for every PS filter / transform |
| 16-bit `WorkingImage` + ICC colour pipeline | ProPhoto wide-gamut canvas, CMYK/ICC management, linear-light maths | PS-grade colour correctness is already here |
| Tool registry (`imageEditorTools`) + scoped shortcuts (full PS key table reserved) | `ready`/`planned` declarative registration; i18n + collisions guarded by CI | A new tool = one registry row + an implementation; UI / shortcuts / translations follow automatically |
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
│   shortcuts: image-editor scope (full PS key table already reserved)
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

### Modal Shell Boundary

The image editor is a software-level editor, not a graph node and not a generic
preview surface. It may be opened from node cards, preview gates, or project
assets, but once open it owns an independent editor shell:

```text
app shell
  -> editor host decides which software editor is open
  -> image-editor shell owns image-editor chrome, stage, right rail, history
  -> image-editor viewport slot owns any native/GPU presentation hole
```

The following must stay true:

- The image editor may reuse primitive button/input tokens, but it must not
  depend on shared modal classes for editor-specific behavior.
- Shared shells such as `.media-viewer` are layout primitives only. They must
  not contain image-editor selection behavior, layer behavior, WGPU surface
  policy, alpha policy, or stage transparency policy.
- A bug inside the image editor must not change the clip editor, grade editor,
  model manager, export dialog, or any other modal's background/layout.
- Image alpha belongs inside the document/stage frame. It must never be wired
  to the modal shell, backdrop, app root, or WebView root.
- Native WGPU presentation for the image editor requires a scoped surface hole
  inside the image-editor viewport slot. Until that scoped matte/hole exists,
  native presentation must stay off for this editor rather than making shared
  ancestors transparent.

This boundary is architectural, not styling preference. If a future change needs
to touch `App`, `body`, `.media-viewer-backdrop`, or `.media-viewer` to make the
image editor display pixels, the change is at the wrong layer.

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

**M7 — Retained layer compositor.** Layers share one logical
document/pasteboard space and store tight pixel resources, migrating to 256 px
sparse tiles. One viewport compositor recomputes dirty visible tiles only; the
pasteboard never becomes a bitmap and layers never receive full-document
canvases. Validate 8K and high-layer-count memory before completion.

**M8 — Camera navigation.** Zoom, pan, and rotate-view update only the retained
scene camera matrix; document data, pasteboard bounds, layer resources, and
pixel revisions stay untouched. `H` is hand, `Z` is cursor-anchored zoom,
Space pans with any tool, and `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1` control
the camera. Pixels, yellow frames, handles, and hit testing share this matrix.

**M9 — Selection commands.** Implementation authority:
[`../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).
`Ctrl+A` select all and `Delete` as recorded ops (`select_all` / `delete` —
history steps, replayed identically by the proxy and the Rust run, unlike
`Ctrl+D` clear which wipes the stack itself); `Ctrl+Shift+D` reselect restores
the last selection snapshot. `Ctrl+J` without a selection duplicates compact
pixel storage, placement, and transform at the same document position. With an
active selection it rasterizes the final selected pixels into a tight resource,
writes the copied document bounds as the new placement, and uses identity
transform. It never positions a duplicate with `clip.region`, never reads a
selection draft or preview pixels, and never branches on the source tool.

**M10 — Gradient tool.** `G` gradient as a recorded `gradient` op: dragging a
start → end vector composites a linear selection ramp (full at the start,
none at the end) into the mask — `add` unions it in, Alt-drag records
`subtract` (cuts it away). A revisable history step, replayed identically by
the proxy (`fillGradient`) and the Rust run (`fill_gradient`).

**M11 — Remaining small PS commands.** `Shift+F5` fill dialog: a mode
(add / subtract) + opacity panel that records a `fill` op — flooding the
active layer at the opacity (100% add ≡ select all, 100% subtract ≡ delete,
but as one revisable history step), replayed identically by the proxy
(`fillCoverage`) and the Rust run. `Shift+F6` feather dialog: opens the
feather preview lane (set the radius on the amount slider, preview, Apply)
recording the existing revisable `feather` op. Both combos flip from
`planned` to `ready`.

**M12 — Viewport polish.** `R` rotate-view tool: dragging rotates the view
around the canvas centre — a screen-space CSS transform on top of the M8
zoom/pan (`CanvasView.rotate`), never part of the document; Esc resets,
`Ctrl+0` fits and resets. `F` cycles screen modes: full UI → right panels
hidden → canvas only (PS full-screen cycle). Both combos flip from `planned`
to `ready`.

**M13 — Retouch tools (PS toolbar order).** The toolbar mirrors PS's icon
sequence, with unimplemented tools as greyed placeholders; the retouch batch
then ships one tool per step, flipping each from `planned` to `ready`:
`J` spot-healing brush (paint a region — it is rebuilt smoothly from the
surrounding mask by diffusion, a revisable `heal` op replayed identically by
the proxy `healStroke` and the Rust `heal_region`); `S` clone stamp
(Alt+click picks a source point, painting copies the mask from the fixed
source offset — a revisable `clone` op, proxy `cloneStroke` / Rust
`clone_region`); `Y` history brush (paint a region back to the layer's
initial pre-edit state — a revisable `history_brush` op, proxy
`historyStroke` / Rust `history_region`); `O` dodge / burn (paint lightens
the mask toward on, Alt-drag burns it toward off, each pass at a fixed 50%
exposure — a revisable `dodge_burn` op, proxy `dodgeBurnStroke` / Rust
`dodge_burn_region`).

**M14 — Eyedropper.** `I` eyedropper as a pure view read: clicking samples
the image colour under the cursor from the underlay thumbnail (offscreen
canvas at document size) and shows the `#rrggbb` swatch in tool options —
nothing is recorded on the document. Flips from `planned` to `ready`; with
it every non-deferred toolbar slot is live.

**M15 — Shape tool.** `U` shape tool: drag a bounding box and the chosen
shape (triangle / regular polygon / star / line) commits as an ordinary
vector path step (`shapeVertices` → path op with `tool: "shape"`), so it
reuses the existing polygon rasteriser on both the proxy and the Rust
backend, supports add / subtract / intersect, and replays / re-edits like
any pen or lasso step. No backend changes.

## 5. Explicitly deferred / out of scope

- Type tool `T`, frame tool `K`: weakly related to the product goal
  (product-image processing); their keys stay reserved, implementation
  deferred indefinitely. (Shape tools `U` shipped in M15.)
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
