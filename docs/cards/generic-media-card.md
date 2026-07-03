# Generic Media Cards And Image Processing Card

This document fixes the canvas product model for media ingestion and image
processing.

Dropping a file onto the canvas creates a source card:

- Image files create an **Image Source** card.
- Video files create a **Video Source** card.
- The two are deliberately separate product cards.

The Image Source card is not a pile of small edit nodes. It is the user's source
asset on the canvas. Its bottom **Edit** action opens the full image editor, so
the user can freely crop, mask, paint, retouch, adjust layers, or make any other
manual edit in one coherent editor.

Flow-level image operations belong in an **Image Processing** card. That card is
a row-based processing panel with row-aligned ports: if the user wants grading,
they wire the Grade row; if they want crop, they wire the Crop row.

## Source Card Rule

The source media card stays a pure input:

- Its path / thumbnail represent the original file.
- Manual editing through the bottom `Edit` action must not destructively mutate
  the original source.
- Confirming the editor creates a traceable edited asset / output reference.
- The edited result can flow into downstream nodes like any other image output.

The source card owns free-form manual editing. Do not spread "manual edit" entry
points across every processing row.

## Image Source Card

The existing `imageSource` node grows from "a path input" into the product image
card:

| Element | Notes |
| --- | --- |
| Thumbnail | Uses lazy thumbnail generation for the selected file. |
| Info row | Shows dimensions, basename, and later format / DPI / size. |
| Output port | Emits the source image reference. |
| Bottom `Edit` action | Opens the full image editor for unrestricted manual edits. |

The bottom `Edit` action is the correct entry for free editing. It is not a
small per-operation shortcut row. Once the edit is confirmed, the app records
the operation stack / edited output as a new non-destructive result.

## Image Processing Card

The Image Processing card is the visible entry for connectable image operations.
It replaces the idea that every small operation needs its own palette card.

| Row | Input Port | Output Port | Notes |
| --- | --- | --- | --- |
| Layer Split | `layerSplit.in` | `layerSplit.out` | Produces a layered image asset for review and downstream use. |
| Enhance | `enhance.in` | `enhance.out` | Parameterized image enhancement. |
| Grade | `grade.in` | `grade.out` | Uses the shared `hgripe-grade` kernel. |
| Crop / Transform | `crop.in` | `crop.out` | Parameterized crop / transform output. |
| Mask / Matte | `mask.in` | `mask.out` / `cutout.out` / `alpha.out` | Produces mask, cutout, or alpha outputs. |
| Repair / Repaint | `repair.in` | `repair.out` | Parameterized repair result, optionally using a quality report. |

Each row has stable height and its ports sit on the row center. Ports must not be
auto-spaced by total port count. A Grade connection dot must align with the
Grade row, and a Crop connection dot must align with the Crop row.

## Row-Aligned Port Contract

The port model must use semantic ids, not anonymous positions:

```ts
type ImageProcessingPort =
  | "layerSplit.in"
  | "layerSplit.out"
  | "enhance.in"
  | "enhance.out"
  | "grade.in"
  | "grade.out"
  | "crop.in"
  | "crop.out"
  | "mask.in"
  | "mask.out"
  | "cutout.out"
  | "alpha.out"
  | "repair.in"
  | "repair.out";
```

Rendering should position React Flow handles from the row layout, not from the
default evenly-spaced node edge layout.

## Relationship To Existing Leaf Nodes

Existing leaf node kinds may remain for runtime compatibility and internal
lowering:

- `subjectMask`
- `crop`
- `imageGrade`
- `imageEnhance`
- `detailWatchdog`
- `detailRepaint`

They should not be the default product palette shape. The visible product shape
is:

```text
Image Source
  bottom Edit -> full image editor

Image Processing
  Layer Split row -> layered image output
  Enhance row     -> enhanced image output
  Grade row       -> graded image output
  Crop row        -> cropped image output
  Mask row        -> mask/cutout/alpha outputs
  Repair row      -> repaired image output
```

The executor may lower a row operation into existing internal node kinds, but
the user-facing canvas should stay organized around the Image Processing card.

## Video Card

Video remains a separate card and backend track.

The Video Source card carries the original video reference, poster frame, and
metadata. Video trim, clip grade, audio handling, and export flow through the
Edit / Timeline workspace and the shared production drawer model, not through
the Image Processing card.

## Drop Routing

Desktop ingestion should use the Tauri file-drop path so the backend receives
absolute filesystem paths.

| Extension | Card |
| --- | --- |
| `png` `jpg` `jpeg` `webp` `gif` `bmp` `tif` `tiff` `heic` `heif` `avif` | Image Source |
| `mp4` `mov` `mkv` `webm` `avi` `m4v` | Video Source |
| anything else | reject with a status note |

Browser preview can remain best-effort because browser file drops do not provide
real disk paths.

## Execution Contract

Running an Image Processing row should execute only the required ancestor graph
and the selected row operation when possible. The result should surface on that
row's output and be available to downstream nodes.

Confirming the full image editor should similarly create a traceable edited
output, but the source card remains the original source.

## Implementation Phases

1. Keep `imageSource` as the source card and give it a clear bottom `Edit`
   action for the full image editor.
2. Add the Image Processing card with stable row layout and row-aligned semantic
   ports.
3. Route row execution through existing internal node kinds where useful.
4. Move leaf processing nodes out of the default palette once the Image
   Processing card covers their product role.
5. Preserve old saved workflows by continuing to load old leaf node kinds.
