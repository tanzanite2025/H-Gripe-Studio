// Pure edit-state model for the Mask-Edit modal.
//
// The modal owns an `EditState` (the current `EditPaths` plus an undo/redo
// stack) and mutates it only through these pure helpers. Keeping the model
// renderer-agnostic and side-effect-free means it is unit-testable on its own
// and the React component stays a thin view. The committed `EditPaths` is what
// gets written back onto the node's `edit_paths` param; the Rust backend
// replays its ordered `ops` stack on run (vector paths, brush strokes and
// queued operations, in recorded order), plus the `matte_strokes` band.

import type { BrushStroke, EditOp, EditPath, EditPaths, MaskOperation, PointPrompt } from "../types/production";
import { emptyEditPaths } from "../types/production";

export interface EditState {
  /** The committed edits. */
  current: EditPaths;
  /** Snapshots older than `current`, most-recent last. */
  past: EditPaths[];
  /** Snapshots undone from `current`, most-recent last. */
  future: EditPaths[];
}

const MAX_HISTORY = 100;

export function initEditState(initial?: unknown): EditState {
  return { current: normalizeEditPaths(initial), past: [], future: [] };
}

/**
 * Coerce an arbitrary stored value into a well-formed version-2 `EditPaths`.
 * A version-1 value (separate `paths` / `brush_strokes` / `operations`
 * arrays) migrates onto one ordered `ops` stack in the legacy replay order —
 * paths, then strokes, then operations — so old workflows rasterise
 * identically.
 */
export function normalizeEditPaths(value: unknown): EditPaths {
  if (!value || typeof value !== "object") return emptyEditPaths();
  const v = value as {
    ops?: unknown;
    paths?: unknown;
    brush_strokes?: unknown;
    matte_strokes?: unknown;
    operations?: unknown;
    points?: unknown;
  };
  const ops: EditOp[] = Array.isArray(v.ops)
    ? v.ops.filter(isEditOp)
    : [
        ...(Array.isArray(v.paths) ? v.paths : []).map((p: EditPath) => ({ ...p, type: "path" as const })),
        ...(Array.isArray(v.brush_strokes) ? v.brush_strokes : []).map((s: BrushStroke) => ({
          ...s,
          type: "brush" as const,
        })),
        ...((Array.isArray(v.operations) ? v.operations : []) as MaskOperation[]),
      ];
  return {
    version: 2,
    ops,
    matte_strokes: Array.isArray(v.matte_strokes) ? v.matte_strokes as BrushStroke[] : [],
    points: Array.isArray(v.points) ? v.points.map(normalizePoint).filter((p): p is PointPrompt => p !== null) : [],
  };
}

function isEditOp(value: unknown): value is EditOp {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Coerce a stored point into a `PointPrompt`. Accepts the current
 * `{ x, y, label }` shape and the legacy `[x, y]` pair (read as positive), so
 * workflows saved before negative points stay loadable.
 */
function normalizePoint(value: unknown): PointPrompt | null {
  if (Array.isArray(value) && value.length >= 2) {
    const [x, y] = value;
    if (typeof x === "number" && typeof y === "number") return { x, y, label: 1 };
    return null;
  }
  if (value && typeof value === "object") {
    const v = value as { x?: unknown; y?: unknown; label?: unknown };
    if (typeof v.x === "number" && typeof v.y === "number") {
      return { x: v.x, y: v.y, label: v.label === 0 ? 0 : 1 };
    }
  }
  return null;
}

// Commit a new `current`, pushing the previous onto the undo stack and clearing
// the redo stack. The history is capped so a long editing session cannot grow
// unbounded in memory.
function commit(state: EditState, next: EditPaths): EditState {
  const past = [...state.past, state.current];
  if (past.length > MAX_HISTORY) past.shift();
  return { current: next, past, future: [] };
}

export function addBrushStroke(state: EditState, stroke: BrushStroke): EditState {
  if (stroke.points.length === 0) return state;
  return commit(state, {
    ...state.current,
    ops: [...state.current.ops, { ...stroke, type: "brush" }],
  });
}

/** Append a trimap unknown-band stroke (resolved to soft alpha by the matter). */
export function addMatteStroke(state: EditState, stroke: BrushStroke): EditState {
  if (stroke.points.length === 0) return state;
  return commit(state, {
    ...state.current,
    matte_strokes: [...state.current.matte_strokes, stroke],
  });
}

/** Append a closed pen / lasso vector path (rasterised by the backend on run). */
export function addPath(state: EditState, path: EditPath): EditState {
  if (path.points.length < 3) return state;
  return commit(state, {
    ...state.current,
    ops: [...state.current.ops, { ...path, type: "path" }],
  });
}

export function addOperation(state: EditState, op: MaskOperation): EditState {
  return commit(state, {
    ...state.current,
    ops: [...state.current.ops, op],
  });
}

/**
 * Append a SAM 2 point prompt (image-space). `label` is `1` for a positive
 * (include) point and `0` for a negative (exclude) point.
 */
export function addPoint(state: EditState, point: PointPrompt): EditState {
  return commit(state, {
    ...state.current,
    points: [...state.current.points, point],
  });
}

/** Drop every edit, recording the wipe as an undoable step. */
export function clearEdits(state: EditState): EditState {
  if (isEmpty(state.current)) return state;
  return commit(state, emptyEditPaths());
}

export function undo(state: EditState): EditState {
  if (state.past.length === 0) return state;
  const past = [...state.past];
  const previous = past.pop()!;
  return { current: previous, past, future: [...state.future, state.current] };
}

export function redo(state: EditState): EditState {
  if (state.future.length === 0) return state;
  const future = [...state.future];
  const next = future.pop()!;
  return { current: next, past: [...state.past, state.current], future };
}

export const canUndo = (state: EditState): boolean => state.past.length > 0;
export const canRedo = (state: EditState): boolean => state.future.length > 0;

export function isEmpty(edits: EditPaths): boolean {
  return edits.ops.length === 0 && edits.matte_strokes.length === 0 && edits.points.length === 0;
}

/** Count of applied edits, for the modal's status line. */
export function editCount(edits: EditPaths): number {
  return edits.ops.length + edits.matte_strokes.length + edits.points.length;
}
