# Image Kernel: image editor document core

**Status:** Design baseline. This document defines how the software-level image
editor, true layer-mask features, and video grading share computation without
creating another pixel core.

The image editor is one product surface. Node previews and image-source cards
may open it with context, but they do not own a separate editor. True masks are
features inside the image editor: layer masks, quick-mask preview, mask
coverage, and whole-mask operations. They are not a second "image editor".

Companion documents:

- `../plans/active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`: sole
  authority for shared-canvas rendering, layer storage/placement, camera,
  dragging, selected-layer frames, Image Size, and `Ctrl+J`.
- `ps-editor-architecture.md`: PS-grade image editor architecture.
- `image-editor-ui-structure.md`: frontend file layout and editor boundary.
- `grade-kernel.md` / `grade-kernel-roadmap.md`: f32 colour and grading core.
- `colour-pipeline.md`: ICC / working-space ownership.
- `../plans/active/PROFESSIONAL_RAW_DEVELOPMENT_PLAN.md`: immutable RAW source,
  development document, scene surface, and delivery order.

## Surfaces

| Surface | Document | Pixel core | Semantics |
| --- | --- | --- | --- |
| Image editor | `ImageEditorDocument` | image compositor plus raster ops, moving toward `hgripe-grade` where colour math is needed | real pixels, layers, selections, paths, masks |
| RAW development | `RawSource` + `RawDevelopDoc` before `ImageEditorDocument` materialization | shared RAW stages feeding the same image compositor and `hgripe-grade` | immutable sensor source plus revisable development parameters; no second editor |
| True mask features | `LayerMask` / active mask target inside `ImageEditorDocument` | u8 alpha/coverage compositor (`subject_mask.rs` + `maskMorphology.ts`) | coverage and matte operations; 8-bit is correct here |
| Video grade / clip colour | `GradeDoc` | `hgripe-grade` | f32 frame-agnostic grading |

**Key decision:** there is no third pixel core. Image editor compositing and
adjustment math should compile toward the same grade kernel used by video
grading. True mask coverage stays a separate u8 alpha path because it is not a
colour surface. RAW development feeds the same canonical image surface before
the document edit stack; it does not create a second editor or compositor.

```text
React image editor shell
  -> ImageEditorDocument
  -> compositor / materializer
  -> hgripe-grade for colour and adjustment math
  -> true-mask u8 path only when the target is a real mask
  -> viewport / WGPU presentation
```

## Document Model

`ImageEditorDocument` is the persistent source of truth. The interactive view
is a retained layer scene in one shared logical world; commands publish atomic
document/pixel revisions and React does not own large pixel surfaces.

Core concepts:

- **Pixel layer:** references image material and records revisable pixel ops.
- **Adjustment layer:** parameter-only layer compiled to grade operations.
- **Layer mask:** grayscale coverage gating a layer. This is the legitimate
  place to use `mask` terminology.
- **Selection:** active marching-ants state used by commands such as Layer Via
  Copy. It is not the selected-layer frame and not a layer mask.
- **Path:** editable vector geometry that may become a selection or a mask.
- **Selected-layer frame:** yellow rectangle derived only from explicit layer
  placement plus the same layer/camera transform as its pixels. It is
  display-only and never a pixel read source.

## Operation Registry

Every edit should be a revisable operation with explicit ownership.

| Operation family | Target | Execution owner |
| --- | --- | --- |
| Raster ops | pixel layer | image editor materializer / native raster layer |
| Adjustment ops | adjustment layer or video grade | `hgripe-grade` |
| Mask ops | layer mask / active mask target | true-mask u8 path |
| Selection assist | draft selection creation | explicit `SelectionAssistReadSource` only |

Do not create duplicate command chains for the same result. A UI menu, shortcut,
context action, and AI action must resolve through the same command runner and
target resolver.

## Current Rust Responsibilities

The native image-document and viewport implementation is split by computation
ownership:

```text
studio/image_document/
  mod.rs                     -> export/materialization compositor and module boundary;
                                 selected-layer isolation is analysis-read only
  retained_scene.rs          -> immutable document revision, ordered compact
                                 retained layer nodes, viewport-window composite,
                                 and selected-layer frame from the same render pass
  selected_layer_geometry.rs -> explicit placement, committed/draft transforms,
                                 and selected-layer geometry
  selected_layer_pixels.rs   -> selection-assist/readback command adapters only
  layer_sampling.rs          -> placement and transformed pixel sampling
  mask_raster.rs             -> clip/selection/mask raster gates; never placement
  tests.rs                   -> retained-scene, placement, and compositor contracts
studio/viewport/
  retained_image_scene.rs    -> resolve resource-backed pixels and build a complete
                                 replacement retained scene off the active state
  mod.rs                     -> stable resource target, atomic `set_image_scene`,
                                 and sequenced `present_image_layer_scene` transaction
  render_image.rs            -> render the exact retained scene/presentation revision
  frame_io.rs                -> return pixels, document/transaction/sequence identity,
                                 and `selectedLayerFrame` in one frame payload
```

The interactive viewport does not call a selected-layer-frame command and does
not isolate or hide the moving layer in another document. Selection-assist
pixel reads may still isolate one layer for analysis, but that path is not
presentation and cannot become a drag renderer.

## Migration Path

1. **K0: lock the vocabulary.** `mask` only means real mask semantics. Generic
   editor state uses `imageEditor*` names.
2. **K1: keep `ImageEditorDocument` as the editor contract.** Remove legacy
   `ImageEditorDocument` assumptions from new code and docs.
3. **K2: compile adjustment layers through `hgripe-grade`.** The image editor
   and video grade share adjustment math and golden-vector discipline.
4. **K3: retain compact per-layer pixels in one native compositor (core
   landed).** The current scene owns ordered tight RGBA layer nodes in document
   coordinates and never materializes the pasteboard per layer. Sparse tiles
   and eviction remain future scaling work.
5. **K4: present one retained scene through the viewport (transaction contract
   landed).** The resource target and host remain stable; document changes use
   atomic `viewport_set_image_scene`, while selection and drag previews use
   sequenced `viewport_present_image_layer_scene`. Camera-only navigation and
   draft transforms redraw existing nodes. Direct GPU-resident per-layer
   resources remain renderer implementation work under the same contract.
6. **K5: add richer PS-grade layer features one at a time.** Groups, clipping
   masks, blend options, smart objects, and PSD round-trip must all compile
   back to the same document/compositor path.

## Guards

| Risk | Guard |
| --- | --- |
| `mask` drifts back into generic editor naming | CI/search gate and code review: `mask` requires a real mask target |
| Pixels, yellow frames, handles, and hit testing drift | Keep separate state products but project all of them through the same retained layer node and camera matrix |
| Pixels and frame metadata come from different revisions | Accept `selectedLayerFrame` only from the rendered frame whose document/transaction/sequence tuple exactly matches the requested scene transaction |
| Image and video colour paths diverge | Shared `hgripe-grade` ops and golden-vector tests |
| React starts doing heavy pixel work again | Pixel reads/materialization go through native compositor/viewport contracts |
| Node canvas owns editor behavior | Node context is data only; editor behavior stays in the software editor shell |
