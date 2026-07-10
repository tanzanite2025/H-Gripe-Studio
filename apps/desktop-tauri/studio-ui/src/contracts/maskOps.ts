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

/** A recorded morphology, selection, or raster operation. */
export interface MaskOperation {
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
}

/** Fields shared by every ordered edit-stack entry. */
export interface EditOpBase {
  disabled?: boolean;
  clip?: { region: [number, number, number, number]; ellipse?: boolean };
}

export type PathOp = EditPath & EditOpBase & { type: "path" };
export type BrushOp = BrushStroke & EditOpBase & { type: "brush" };
export type EditOp = PathOp | BrushOp | (MaskOperation & EditOpBase);

/** Re-editable record of manual Subject Mask edits. */
export interface EditPaths {
  version: 2;
  ops: EditOp[];
  matte_strokes: BrushStroke[];
  points: PointPrompt[];
}

/** A SAM 2 point prompt in image-pixel space. */
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

export function isMaskOperation(op: EditOp): op is MaskOperation {
  return op.type !== "path" && op.type !== "brush";
}

export function editStackPaths(edits: EditPaths): EditPath[] {
  return edits.ops.filter(isPathOp);
}

export function editStackBrushStrokes(edits: EditPaths): BrushStroke[] {
  return edits.ops.filter(isBrushOp);
}

export function editStackOperations(edits: EditPaths): MaskOperation[] {
  return edits.ops.filter(isMaskOperation);
}
