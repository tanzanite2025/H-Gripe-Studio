# Image kernel: the standalone image document core

**Status:** Design proposal (not implemented). This document defines the
split between the mask editor, the standalone image editor, and the video
grading dialog — which pieces stay separate, which are abstracted into a
shared kernel, and the migration path. It is the planning baseline for the
image editor growing PS-grade layer features (groups, clipping masks, blend
options, smart objects) without re-implementing the colour core that
`crates/hgripe-grade` already provides.

Companion documents:

- `ps-editor-architecture.md` — the mask editor's document model (EditStack,
  u8 grayscale compositor). Unchanged by this plan.
- `grade-kernel.md` / `grade-kernel-roadmap.md` — the f32 colour core
  (`crates/hgripe-grade`) this plan builds on rather than duplicates.
- `mask-editor-ui-structure.md` — the frontend file layout and the
  node-result → image-editor pipeline rule.
- `colour-pipeline.md` — ICC / working-space ownership; untouched.

## 1. The three surfaces and what each owns

| Surface | Document | Pixel core | Semantics |
| --- | --- | --- | --- |
| Mask popup (`workspace="mask"`) | `MaskDocument` (mask ops replayed to coverage) | u8 grayscale compositor (`subject_mask.rs` + `maskMorphology.ts` proxy) | alpha coverage; 8-bit is correct here (PS does the same) |
| **Image editor** (`workspace="image"`, this plan) | **`ImageDocument` (new)** | **image kernel = `hgripe-grade` compositing + a thin raster layer** | real pixels, layered, colour-managed |
| Video grade dialog | `GradeDoc` | `hgripe-grade` (f32, frame-agnostic) | per-frame grading |

**Key decision: there is no third pixel core.** The image editor's
compositor and adjustment maths are the grade kernel. What the image editor
adds on top is a *document* abstraction (layer kinds, groups, clipping,
masks-as-a-feature) that compiles down to the kernel's existing
`GradeDoc`-shaped layer stack for rendering.

```
┌─ UI layer (React)  — layers panel, right-click menu, adjustments dock
├─ ImageDocument (TS + Rust isomorphic, serde/JSON)   ← NEW
│    compiles down to ↓ for every render
├─ hgripe-grade (crates/hgripe-grade)                 ← EXISTS
│    f32 compositing, separable PS blend set, adjustment ops,
│    golden-vector discipline, CPU reference + GPU preview
└─ colour pipeline (studio/color)                     ← EXISTS
     ICC, WorkingImage u16 ingress/egress
```

## 2. ImageDocument model

Mirrors the two proven document models (`MaskDocument`, `GradeDoc`): plain
serialisable data, rendering = replay + composite, every step revisable.

```rust
pub struct ImageDocument {
    pub version: u32,
    pub canvas: CanvasSize,
    pub layers: Vec<ImageLayer>,     // bottom → top
    pub active: usize,
}

pub struct ImageLayer {
    pub id: String,
    pub name: String,
    pub kind: ImageLayerKind,
    pub blend: GradeBlendMode,       // the kernel's separable PS set, as-is
    pub opacity: f32,
    pub visible: bool,
    pub locked: bool,
    /// Layer mask: grayscale coverage gating the layer. Authored by the
    /// mask feature (the mask popup / model results) — maps to the
    /// kernel's `GradeLayer.mask`.
    pub mask: Option<LayerMask>,
    /// Clipping: composite only where the layer below has coverage
    /// (剪贴蒙版, Alt+Ctrl+G).
    pub clipped: bool,
    /// Blend options (混合选项): channel knock-outs and blend-if ranges.
    pub blend_options: Option<BlendOptions>,
}

pub enum ImageLayerKind {
    /// Real pixels. `source` references the backing image (a node result,
    /// a file, or a rasterised edit); `edits` is the revisable op stack
    /// (brush, heal, clone, transform, resize — today's paint ops,
    /// re-targeted at pixels).
    Pixel { source: SourceRef, edits: Vec<EditOp> },
    /// Parameter-only layer: one kernel `GradeOp` stack applied to the
    /// composite below (levels / curves / HSL / exposure / …).
    Adjustment { ops: Vec<GradeOp> },
    /// Group (新建组): children composite in isolation, then blend as one.
    Group { children: Vec<ImageLayer> },
    /// Reserved (deferred): smart object — `source_ref` to another
    /// document; artboards.
    SmartObject { doc_ref: String },
}
```

Rendering compiles this tree to the kernel: groups flatten to nested
composites, `Adjustment` layers become `GradeLayer { ops }`, pixel layers
become surfaces (their `edits` replayed by the raster ops), `clipped` and
`blend_options` become mask/gate inputs. The kernel stays document-agnostic.

## 3. The op registry (one vocabulary, three consumers)

Every editing action is recorded as an **Op** — plain revisable data. Today
there are three op vocabularies: mask `EditOp`s, grade `GradeOp`s, and the
image editor implicitly reusing mask ops. The registry unifies *declaration*,
not implementation:

- **One registry table** (TS, mirroring `maskTools.ts`' pattern): op name,
  parameter schema, which kernel executes it (`mask` u8 / `grade` f32 /
  `raster`), which options panel edits it, i18n keys.
- **Adjustments are declared once** and consumed by both the image editor's
  `Adjustment` layers and the video grade dialog — both execute in
  `hgripe-grade`, both are pinned by the same golden vectors. Adding an
  adjustment = add vectors, one Rust op, one TS mirror, one registry row.
  It appears in both editors with no further work.
- **Raster ops** (brush / heal / clone / transform / resize on pixels) are
  image-editor-only registry rows executing in the raster layer.
- **Mask ops** stay in the mask kernel, unchanged.

## 4. What is mask-only, and how the mask remains a feature

The mask popup keeps its own document, kernel, and chrome (mask-only view,
quick mask, paths / mask-ops docks). The image editor consumes masks as
*data*: a model / API / manual mask result lands as `ImageLayer.mask` (or a
selection), entering through the node-result pipeline
(`mask-editor-ui-structure.md`). No mask tooling is rebuilt inside the image
editor.

## 5. Migration path (each step independently shippable)

- **K0 — freeze this document; registry skeleton.** The op registry table
  with today's ops declared (no behaviour change).
- **K1 — `ImageDocument` type + MaskDocument bridge.** The image editor's
  state becomes `ImageDocument`; a lossless bridge maps today's stored
  `MaskDocument` drafts (background layer → `Pixel`, adjustment layers →
  `Adjustment`) both ways, so nothing breaks while both models coexist.
- **K2 — render through the grade kernel.** Image-editor preview and commit
  composite via `hgripe-grade` (ingress/egress on `WorkingImage` already
  exists from the grade dialog, G4). Adjustment layers switch from the u8
  mask LUTs to the f32 kernel ops. Acceptance: golden comparisons against
  the current output within documented tolerances.
- **K3 — layer features on the document.** Groups, clipping masks, blend
  options, lock / rename / merge-visible / flatten — pure document + UI
  work, compiled down to the kernel (the right-click menu grows here).
- **K4 — raster op layer.** Brush / heal / clone / transform on pixel
  layers (f32 surfaces), reusing the existing stroke recording.
- **K5 — deferred.** Smart objects (`doc_ref`), artboards, PSD layer
  round-trip (per `ps-editor-architecture.md` §5).

## 6. Risks and guards

| Risk | Guard |
| --- | --- |
| Two document models drift during K1–K2 | the bridge is property-tested both directions; drafts stay loadable |
| Kernel output differs from today's u8 adjustments | K2 golden comparisons; u8 path kept behind a flag until parity signed off |
| Registry becomes a third place to forget | CI check: every op in either kernel must have a registry row (like the shortcut/i18n gates) |
| Scope creep on layer features | K3 lands menu items one PR at a time; unimplemented entries stay hidden, not greyed |
