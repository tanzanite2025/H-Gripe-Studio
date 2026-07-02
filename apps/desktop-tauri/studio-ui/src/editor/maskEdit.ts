// Pure edit-state model for the Mask-Edit modal.
//
// The modal owns an `EditState` (the current `MaskDocument` plus an undo/redo
// stack) and mutates it only through these pure helpers. Keeping the model
// renderer-agnostic and side-effect-free means it is unit-testable on its own
// and the React component stays a thin view. The committed `MaskDocument` is
// what gets written back onto the node's `edit_paths` param; the Rust backend
// replays each layer's ordered `ops` stack on run and composites the layers
// (see `docs/design/ps-editor-architecture.md`, M3), plus the document-level
// `matte_strokes` band.

import type {
  AdjustmentType,
  BrushStroke,
  EditOp,
  EditPath,
  EditPathPoint,
  LayerAdjustment,
  LayerBlend,
  MaskDocument,
  MaskLayer,
  MaskOperation,
  PointPrompt,
} from "../types/production";
import {
  activeLayer,
  emptyAdjustmentLayer,
  emptyMaskDocument,
  emptyMaskLayer,
  isMaskOperation,
  isPathOp,
  LAYER_BLENDS,
} from "../types/production";

export interface EditState {
  /** The committed document. */
  current: MaskDocument;
  /** Snapshots older than `current`, most-recent last. */
  past: MaskDocument[];
  /** Snapshots undone from `current`, most-recent last. */
  future: MaskDocument[];
}

const MAX_HISTORY = 100;

export function initEditState(initial?: unknown): EditState {
  return { current: normalizeEditPaths(initial), past: [], future: [] };
}

/**
 * Coerce an arbitrary stored `edit_paths` value into a well-formed version-3
 * `MaskDocument`. A version-3 value loads directly; a version-2 value (one
 * ordered `ops` stack) becomes the single background layer; a version-1 value
 * (separate `paths` / `brush_strokes` / `operations` arrays) migrates onto one
 * ordered stack in the legacy replay order — paths, then strokes, then
 * operations — so old workflows rasterise identically.
 */
export function normalizeEditPaths(value: unknown): MaskDocument {
  if (!value || typeof value !== "object") return emptyMaskDocument();
  const v = value as {
    layers?: unknown;
    active?: unknown;
    ops?: unknown;
    paths?: unknown;
    brush_strokes?: unknown;
    matte_strokes?: unknown;
    operations?: unknown;
    points?: unknown;
  };
  const matte_strokes = Array.isArray(v.matte_strokes) ? (v.matte_strokes as BrushStroke[]) : [];
  const points = Array.isArray(v.points)
    ? v.points.map(normalizePoint).filter((p): p is PointPrompt => p !== null)
    : [];
  if (Array.isArray(v.layers)) {
    const layers = v.layers.map(normalizeLayer).filter((l): l is MaskLayer => l !== null);
    if (layers.length === 0) layers.push(emptyMaskLayer());
    const active = typeof v.active === "number" ? Math.min(Math.max(Math.trunc(v.active), 0), layers.length - 1) : 0;
    return { version: 3, layers, active, matte_strokes, points };
  }
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
    version: 3,
    layers: [{ ...emptyMaskLayer(), ops }],
    active: 0,
    matte_strokes,
    points,
  };
}

function normalizeLayer(value: unknown): MaskLayer | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    blend?: unknown;
    opacity?: unknown;
    visible?: unknown;
    locked?: unknown;
    ops?: unknown;
    adjustment?: unknown;
  };
  const blank = emptyMaskLayer();
  const adjustment = normalizeAdjustment(v.adjustment);
  const isAdjustment = v.kind === "adjustment" && adjustment !== null;
  return {
    id: typeof v.id === "string" && v.id ? v.id : blank.id,
    name: typeof v.name === "string" && v.name ? v.name : blank.name,
    kind: isAdjustment ? "adjustment" : "mask",
    blend: LAYER_BLENDS.includes(v.blend as LayerBlend) ? (v.blend as LayerBlend) : "normal",
    opacity: typeof v.opacity === "number" ? Math.min(Math.max(v.opacity, 0), 1) : 1,
    visible: v.visible !== false,
    ...(v.locked === true ? { locked: true } : null),
    ops: Array.isArray(v.ops) ? v.ops.filter(isEditOp) : [],
    ...(isAdjustment ? { adjustment } : null),
  };
}

const ADJUSTMENT_TYPES: readonly AdjustmentType[] = ["levels", "curve", "brightness_contrast"];

function normalizeAdjustment(value: unknown): LayerAdjustment | null {
  if (!value || typeof value !== "object") return null;
  const v = value as LayerAdjustment;
  if (!ADJUSTMENT_TYPES.includes(v.type)) return null;
  return v;
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
function commit(state: EditState, next: MaskDocument): EditState {
  const past = [...state.past, state.current];
  if (past.length > MAX_HISTORY) past.shift();
  return { current: next, past, future: [] };
}

/** The active layer's ordered edit stack (what the history panel shows). */
export function activeOps(doc: MaskDocument): EditOp[] {
  return activeLayer(doc).ops;
}

/** Whether the layer receiving new edits is locked (PS "lock all"). */
export function activeLayerLocked(doc: MaskDocument): boolean {
  return activeLayer(doc).locked === true;
}

// Replace the active layer's ops (all sequential edits target the active layer).
function withActiveOps(doc: MaskDocument, ops: EditOp[]): MaskDocument {
  const active = Math.min(Math.max(doc.active, 0), doc.layers.length - 1);
  return {
    ...doc,
    layers: doc.layers.map((l, i) => (i === active ? { ...l, ops } : l)),
  };
}

export function addBrushStroke(state: EditState, stroke: BrushStroke): EditState {
  if (stroke.points.length === 0 || activeLayerLocked(state.current)) return state;
  return commit(state, withActiveOps(state.current, [...activeOps(state.current), { ...stroke, type: "brush" }]));
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
  if (path.points.length < 3 || activeLayerLocked(state.current)) return state;
  return commit(state, withActiveOps(state.current, [...activeOps(state.current), { ...path, type: "path" }]));
}

export function addOperation(state: EditState, op: MaskOperation): EditState {
  if (activeLayerLocked(state.current)) return state;
  return commit(state, withActiveOps(state.current, [...activeOps(state.current), op]));
}

// --- history-panel step revision (M2: every recorded step stays revisable) ---

/** Delete one step from the active layer's edit stack (undoable). */
export function removeOp(state: EditState, index: number): EditState {
  const ops = activeOps(state.current);
  if (index < 0 || index >= ops.length) return state;
  return commit(state, withActiveOps(state.current, ops.filter((_, i) => i !== index)));
}

/**
 * Toggle a step's `disabled` flag (undoable). Disabled steps stay recorded
 * and visible in the history panel but are skipped on replay.
 */
export function toggleOp(state: EditState, index: number): EditState {
  const ops = activeOps(state.current);
  const op = ops[index];
  if (!op) return state;
  const next: EditOp = { ...op, disabled: !op.disabled };
  if (!next.disabled) delete next.disabled;
  return commit(state, withActiveOps(state.current, ops.map((o, i) => (i === index ? next : o))));
}

/** Revise the scalar parameter of a queued operation step (undoable). */
export function updateOpAmount(state: EditState, index: number, amount: number): EditState {
  const ops = activeOps(state.current);
  const op = ops[index];
  if (!op || !isMaskOperation(op)) return state;
  if (op.amount === amount) return state;
  return commit(state, withActiveOps(state.current, ops.map((o, i) => (i === index ? { ...o, amount } : o))));
}

/** Free-transform params (identity when a field is absent on the op). */
export interface TransformParams {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
}

/** Revise a committed `transform` step's params (undoable; M5 re-transform). */
export function updateOpTransform(state: EditState, index: number, params: TransformParams): EditState {
  const ops = activeOps(state.current);
  const op = ops[index];
  if (!op || !isMaskOperation(op) || op.type !== "transform") return state;
  const next: EditOp = { ...op, dx: params.dx, dy: params.dy, scale: params.scale, rotate: params.rotate };
  return commit(state, withActiveOps(state.current, ops.map((o, i) => (i === index ? next : o))));
}

/** Replace a committed path step's anchors (undoable; anchor re-editing). */
export function updatePathAnchors(state: EditState, index: number, points: EditPathPoint[]): EditState {
  const ops = activeOps(state.current);
  const op = ops[index];
  if (!op || !isPathOp(op) || points.length < 3) return state;
  return commit(state, withActiveOps(state.current, ops.map((o, i) => (i === index ? { ...op, points } : o))));
}

// --- layer stack (M3: minimal document model) ---

/** Append a new empty layer above the stack and make it active (undoable). */
export function addLayer(state: EditState, name?: string): EditState {
  const layers = [...state.current.layers, emptyMaskLayer(name ?? `Layer ${state.current.layers.length + 1}`)];
  return commit(state, { ...state.current, layers, active: layers.length - 1 });
}

/** Append an identity adjustment layer above the stack, active (undoable; M6). */
export function addAdjustmentLayer(state: EditState, type: AdjustmentType): EditState {
  const layers = [...state.current.layers, emptyAdjustmentLayer(type)];
  return commit(state, { ...state.current, layers, active: layers.length - 1 });
}

/** Revise an adjustment layer's tone-map params (undoable; M6). */
export function updateLayerAdjustment(state: EditState, index: number, adjustment: LayerAdjustment): EditState {
  const layer = state.current.layers[index];
  if (!layer || layer.kind !== "adjustment") return state;
  return withLayer(state, index, { adjustment });
}

/** Delete one layer (undoable). The last remaining layer and locked layers cannot be deleted. */
export function removeLayer(state: EditState, index: number): EditState {
  const { layers } = state.current;
  if (layers.length <= 1 || index < 0 || index >= layers.length || layers[index].locked) return state;
  const next = layers.filter((_, i) => i !== index);
  const active = Math.min(state.current.active > index ? state.current.active - 1 : state.current.active, next.length - 1);
  return commit(state, { ...state.current, layers: next, active });
}

/** Select the layer new edits are recorded onto. Not an undo step. */
export function setActiveLayer(state: EditState, index: number): EditState {
  if (index < 0 || index >= state.current.layers.length || index === state.current.active) return state;
  return { ...state, current: { ...state.current, active: index } };
}

function withLayer(state: EditState, index: number, patch: Partial<MaskLayer>): EditState {
  const layer = state.current.layers[index];
  if (!layer) return state;
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? { ...l, ...patch } : l)),
  });
}

/** Toggle a layer's PS "lock all" flag (undoable). Locked layers reject new edits and deletion. */
export function toggleLayerLock(state: EditState, index: number): EditState {
  const layer = state.current.layers[index];
  if (!layer) return state;
  return withLayer(state, index, layer.locked ? { locked: undefined } : { locked: true });
}

/** Toggle a layer's visibility (undoable); hidden layers skip compositing. */
export function toggleLayerVisible(state: EditState, index: number): EditState {
  const layer = state.current.layers[index];
  if (!layer) return state;
  return withLayer(state, index, { visible: !layer.visible });
}

/** Set a layer's opacity, clamped to 0..1 (undoable). */
export function setLayerOpacity(state: EditState, index: number, opacity: number): EditState {
  const layer = state.current.layers[index];
  const next = Math.min(Math.max(opacity, 0), 1);
  if (!layer || layer.opacity === next) return state;
  return withLayer(state, index, { opacity: next });
}

/** Rename a layer (undoable; PS double-click rename). Blank names are ignored. */
export function renameLayer(state: EditState, index: number, name: string): EditState {
  const layer = state.current.layers[index];
  const next = name.trim();
  if (!layer || !next || layer.name === next) return state;
  return withLayer(state, index, { name: next });
}

/**
 * Move a layer to another stack position (undoable; PS drag-reorder). The
 * active layer stays active by identity, wherever it lands.
 */
export function moveLayer(state: EditState, from: number, to: number): EditState {
  const { layers } = state.current;
  if (from === to || from < 0 || from >= layers.length || to < 0 || to >= layers.length) return state;
  const next = [...layers];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const activeId = layers[state.current.active]?.id;
  const active = Math.max(next.findIndex((l) => l.id === activeId), 0);
  return commit(state, { ...state.current, layers: next, active });
}

/** Set a layer's blend mode (undoable). */
export function setLayerBlend(state: EditState, index: number, blend: LayerBlend): EditState {
  const layer = state.current.layers[index];
  if (!layer || layer.blend === blend) return state;
  return withLayer(state, index, { blend });
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
  return commit(state, emptyMaskDocument());
}

/**
 * PS Reselect (Ctrl+Shift+D; M9): when the document is empty (after a clear),
 * restore the most recent non-empty snapshot from the undo stack as a new
 * undoable step. A no-op when there is a live document or no snapshot.
 */
export function reselect(state: EditState): EditState {
  if (!isEmpty(state.current)) return state;
  for (let i = state.past.length - 1; i >= 0; i--) {
    if (!isEmpty(state.past[i])) return commit(state, state.past[i]);
  }
  return state;
}

/**
 * PS duplicate-via-copy (Ctrl+J; M9): copy the active layer (fresh id,
 * "… copy" name) directly above itself and make the copy active (undoable).
 * Adjustment layers duplicate too — the copy re-tone-maps the composite.
 */
export function duplicateLayer(state: EditState): EditState {
  const doc = state.current;
  const index = Math.min(Math.max(doc.active, 0), doc.layers.length - 1);
  const source = doc.layers[index];
  const copy: MaskLayer = {
    ...source,
    id: emptyMaskLayer().id,
    name: `${source.name} copy`,
    ops: source.ops.map((op) => ({ ...op })),
  };
  const layers = [...doc.layers.slice(0, index + 1), copy, ...doc.layers.slice(index + 1)];
  return commit(state, { ...doc, layers, active: index + 1 });
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

export function isEmpty(doc: MaskDocument): boolean {
  return (
    doc.layers.length === 1 &&
    doc.layers.every((l) => l.ops.length === 0) &&
    doc.matte_strokes.length === 0 &&
    doc.points.length === 0
  );
}

/** Count of applied edits, for the modal's status line. */
export function editCount(doc: MaskDocument): number {
  return (
    doc.layers.reduce((n, l) => n + l.ops.length, 0) + doc.matte_strokes.length + doc.points.length
  );
}
