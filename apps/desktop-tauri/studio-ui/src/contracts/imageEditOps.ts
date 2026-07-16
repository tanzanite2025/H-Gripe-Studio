/** A point on a bezier or vector selection path. */
export interface EditPathPoint {
  x: number;
  y: number;
  in?: [number, number];
  out?: [number, number];
}

/** A vector selection path edit. */
export interface EditPath {
  id: string;
  mode: string;
  tool: string;
  closed: boolean;
  points: EditPathPoint[];
}

/** A freehand brush or eraser stroke. */
export interface BrushStroke {
  id: string;
  mode: string;
  radius: number;
  points: [number, number][];
  hardness?: number;
  flow?: number;
  spacing?: number;
}

/** The image resource a `source_image` op draws, with its natural pixel
 * dimensions. Absent on legacy ops that reuse the document's opened image. */
export interface LayerImageSource {
  path: string;
  width: number;
  height: number;
}

/** A Rust-materialized Layer Via Copy result. The copied pixels already own
 * their final appearance, so the frontend records only this source and its
 * exact document-space placement. */
export interface MaterializedLayerViaCopy {
  source: LayerImageSource;
  placement: [number, number, number, number];
}

/** A recorded morphology, selection, or raster operation. */
export interface ImageEditOperation {
  type: string;
  amount?: number;
  region?: number[];
  points?: [number, number][];
  mode?: string;
  tolerance?: number;
  dx?: number;
  dy?: number;
  scale?: number;
  rotate?: number;
  source?: LayerImageSource;
  /** Document-space rect `[x0, y0, x1, y1]` where the layer's own image
   * draws. Absent means the legacy full-canvas placement. */
  placement?: [number, number, number, number];
}

export interface SelectionAlphaClip {
  width: number;
  height: number;
  startsWith: 0 | 255;
  runs: number[];
}

export interface EditClip {
  region: [number, number, number, number];
  ellipse?: boolean;
  points?: [number, number][];
  selectionAlpha?: SelectionAlphaClip;
}

/** Fields shared by every ordered edit-stack entry. The `clip` selection is
 * a rect by default, an ellipse when `ellipse`, an exact polygon when `points`
 * is present, or a pixel-alpha selection when `selectionAlpha` is present
 * (`region` then holds that alpha map's document-space bounds). */
export interface EditOpBase {
  disabled?: boolean;
  clip?: EditClip;
}

export type PathOp = EditPath & EditOpBase & { type: "path" };
export type BrushOp = BrushStroke & EditOpBase & { type: "brush" };
export type EditOp = PathOp | BrushOp | (ImageEditOperation & EditOpBase);

/** Re-editable record of image editor operations. */
export interface EditPaths {
  version: 2;
  ops: EditOp[];
  matte_strokes: BrushStroke[];
  points: PointPrompt[];
}

/** A built-in include/exclude point prompt in image-pixel space. */
export interface PointPrompt {
  x: number;
  y: number;
  label: 0 | 1;
}

export function emptyEditPaths(): EditPaths {
  return { version: 2, ops: [], matte_strokes: [], points: [] };
}

export function isPathOp(op: EditOp): op is PathOp {
  return op.type === "path";
}

export function isBrushOp(op: EditOp): op is BrushOp {
  return op.type === "brush";
}

export function isImageEditOperation(op: EditOp): op is ImageEditOperation {
  return op.type !== "path" && op.type !== "brush";
}

export function editStackPaths(edits: EditPaths): EditPath[] {
  return edits.ops.filter(isPathOp);
}

export function editStackBrushStrokes(edits: EditPaths): BrushStroke[] {
  return edits.ops.filter(isBrushOp);
}

export function editStackOperations(edits: EditPaths): ImageEditOperation[] {
  return edits.ops.filter(isImageEditOperation);
}
