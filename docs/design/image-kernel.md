# Image Kernel: image editor document core

**Status:** Design baseline. This document defines how the software-level image
editor, true layer-mask features, and video grading share computation without
creating another pixel core.

The image editor is one product surface. Node previews and image-source cards
may open it with context, but they do not own a separate editor. True masks are
features inside the image editor: layer masks, quick-mask preview, mask
coverage, and whole-mask operations. They are not a second "image editor".

Companion documents:

- `ps-editor-architecture.md`: PS-grade image editor architecture.
- `image-editor-ui-structure.md`: frontend file layout and editor boundary.
- `grade-kernel.md` / `grade-kernel-roadmap.md`: f32 colour and grading core.
- `colour-pipeline.md`: ICC / working-space ownership.

## Surfaces

| Surface | Document | Pixel core | Semantics |
| --- | --- | --- | --- |
| Image editor | `ImageEditorDocument` | image compositor plus raster ops, moving toward `hgripe-grade` where colour math is needed | real pixels, layers, selections, paths, masks |
| True mask features | `LayerMask` / active mask target inside `ImageEditorDocument` | u8 alpha/coverage compositor (`subject_mask.rs` + `maskMorphology.ts`) | coverage and matte operations; 8-bit is correct here |
| Video grade / clip colour | `GradeDoc` | `hgripe-grade` | f32 frame-agnostic grading |

**Key decision:** there is no third pixel core. Image editor compositing and
adjustment math should compile toward the same grade kernel used by video
grading. True mask coverage stays a separate u8 alpha path because it is not a
colour surface.

```text
React image editor shell
  -> ImageEditorDocument
  -> compositor / materializer
  -> hgripe-grade for colour and adjustment math
  -> true-mask u8 path only when the target is a real mask
  -> viewport / WGPU presentation
```

## Document Model

`ImageEditorDocument` is the single source of truth for the image editor.
Rendering is replay plus composite; commands write data, not pixels directly in
React state.

Core concepts:

- **Pixel layer:** references image material and records revisable pixel ops.
- **Adjustment layer:** parameter-only layer compiled to grade operations.
- **Layer mask:** grayscale coverage gating a layer. This is the legitimate
  place to use `mask` terminology.
- **Selection:** active marching-ants state used by commands such as Layer Via
  Copy. It is not the selected-layer frame and not a layer mask.
- **Path:** editable vector geometry that may become a selection or a mask.
- **Selected-layer frame:** yellow rectangular bounds overlay for the active
  element/layer. It is display-only and must not be used as a pixel read source.

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

## Migration Path

1. **K0: lock the vocabulary.** `mask` only means real mask semantics. Generic
   editor state uses `imageEditor*` names.
2. **K1: keep `ImageEditorDocument` as the editor contract.** Remove legacy
   `ImageEditorDocument` assumptions from new code and docs.
3. **K2: compile adjustment layers through `hgripe-grade`.** The image editor
   and video grade share adjustment math and golden-vector discipline.
4. **K3: materialize pixel layers through a native compositor.** Pixel reads
   for `Ctrl+J`, magnetic lasso, previews, and export use the same resolved
   placement/scale/transform path.
5. **K4: move heavy preview/presentation to WGPU viewports.** React should
   own controls and state, not large pixel surfaces.
6. **K5: add richer PS-grade layer features one at a time.** Groups, clipping
   masks, blend options, smart objects, and PSD round-trip must all compile
   back to the same document/compositor path.

## Guards

| Risk | Guard |
| --- | --- |
| `mask` drifts back into generic editor naming | CI/search gate and code review: `mask` requires a real mask target |
| Selection overlays, selected-layer frames, and mask previews get coupled | Keep separate state products and separate render paths |
| Image and video colour paths diverge | Shared `hgripe-grade` ops and golden-vector tests |
| React starts doing heavy pixel work again | Pixel reads/materialization go through native compositor/viewport contracts |
| Node canvas owns editor behavior | Node context is data only; editor behavior stays in the software editor shell |
