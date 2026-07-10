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

import {
  type AdjustmentType,
  type ImageCanvasSize,
  type ImageResample,
  type LayerGroup,
  type LayerAdjustment,
  type LayerBlend,
  type LayerMask,
  type LayerTargetKind,
  type MaskDocument,
  type MaskLayer,
} from "../contracts/maskDocument";
import {
  type BrushStroke,
  type EditOp,
  type EditPath,
  type EditPathPoint,
  type MaskOperation,
  type PointPrompt,
} from "../contracts/maskOps";
import {
  activeLayer,
  activeTargetKind,
  emptyAdjustmentLayer,
  emptyLayerMask,
  emptyMaskDocument,
  emptyMaskLayer,
  LAYER_BLENDS,
} from "../contracts/maskDocument";
import { isBrushOp, isMaskOperation, isPathOp } from "../contracts/maskOps";

export const SOURCE_IMAGE_OP_TYPE = "source_image";

export interface LayerCopySelection {
  region: [number, number, number, number];
  ellipse?: boolean;
  polygon?: [number, number][];
}

export interface EditState {
  /** The committed document. */
  current: MaskDocument;
  /** Snapshots older than `current`, most-recent last. */
  past: MaskDocument[];
  /** Snapshots undone from `current`, most-recent last. */
  future: MaskDocument[];
}

export interface HistorySnapshot {
  /** Chronological index across past -> current -> future. */
  index: number;
  doc: MaskDocument;
  label: string;
  current: boolean;
  layers: number;
  edits: number;
  activeLayerName: string;
}

export const MASK_EDIT_STATE_SCHEMA = "hgripe.maskEditState.v1";

export interface PersistedMaskEditState {
  schema: typeof MASK_EDIT_STATE_SCHEMA;
  version: 1;
  current: MaskDocument;
  past: MaskDocument[];
  future: MaskDocument[];
}

const MAX_HISTORY = 100;
export const LAYER_GROUP_COLORS = ["#5aa7ff", "#59c98f", "#f0b84f", "#ff7f66", "#a68cff", "#48c7d9"] as const;

export function initEditState(initial?: unknown): EditState {
  if (isPersistedMaskEditState(initial)) {
    return {
      current: normalizeEditPaths(initial.current),
      past: initial.past.slice(-MAX_HISTORY).map(normalizeEditPaths),
      future: initial.future.slice(-MAX_HISTORY).map(normalizeEditPaths),
    };
  }
  return { current: normalizeEditPaths(initial), past: [], future: [] };
}

function isPersistedMaskEditState(value: unknown): value is PersistedMaskEditState {
  if (!value || typeof value !== "object") return false;
  const v = value as { schema?: unknown; version?: unknown; current?: unknown; past?: unknown; future?: unknown };
  return v.schema === MASK_EDIT_STATE_SCHEMA && v.version === 1 && Array.isArray(v.past) && Array.isArray(v.future);
}

export function serializeEditState(state: EditState): PersistedMaskEditState {
  return {
    schema: MASK_EDIT_STATE_SCHEMA,
    version: 1,
    current: cloneMaskDocument(state.current),
    past: state.past.slice(-MAX_HISTORY).map(cloneMaskDocument),
    future: state.future.slice(-MAX_HISTORY).map(cloneMaskDocument),
  };
}

/**
 * Coerce an arbitrary stored `edit_paths` value into a well-formed version-3
 * `MaskDocument`. A version-3 value loads directly; a version-2 value (one
 * ordered `ops` stack) becomes the single background layer; a version-1 value
 * (separate `paths` / `brush_strokes` / `operations` arrays) migrates onto one
 * ordered stack in the legacy replay order — paths, inline wand/invert ops,
 * strokes, then operations — so old workflows rasterise identically.
 */
export function normalizeEditPaths(value: unknown): MaskDocument {
  if (!value || typeof value !== "object") return emptyMaskDocument();
  const v = value as {
    version?: unknown;
    layers?: unknown;
    active?: unknown;
    canvas?: unknown;
    ops?: unknown;
    paths?: unknown;
    brush_strokes?: unknown;
    layerGroups?: unknown;
    matte_strokes?: unknown;
    operations?: unknown;
    points?: unknown;
    activeTarget?: unknown;
  };
  const version =
    typeof v.version === "number"
      ? Math.trunc(v.version)
      : Array.isArray(v.layers)
        ? 3
        : Array.isArray(v.ops)
          ? v.ops.some(isLegacyInlineWand)
            ? 1
            : 2
          : 1;
  const matte_strokes = Array.isArray(v.matte_strokes) ? (v.matte_strokes as BrushStroke[]) : [];
  const points = Array.isArray(v.points)
    ? v.points.map(normalizePoint).filter((p): p is PointPrompt => p !== null)
    : [];
  const canvas = normalizeCanvas(v.canvas);
  if (version >= 3) {
    const layerGroups = normalizeLayerGroups(v.layerGroups);
    const groupIds = new Set(layerGroups.map((g) => g.id));
    const storedLayers = Array.isArray(v.layers) ? v.layers : [];
    const layers = storedLayers
      .map((layer) => normalizeLayer(layer, groupIds))
      .filter((l): l is MaskLayer => l !== null);
    // Tolerant loading is the contract, but a truncated document should not
    // load silently: leave a trace for "where did my layer go".
    if (layers.length < storedLayers.length) {
      console.warn(
        `normalizeEditPaths: dropped ${storedLayers.length - layers.length} malformed layer(s) from stored edit_paths`,
      );
    }
    const active = layers.length === 0
      ? -1
      : typeof v.active === "number"
        ? Math.min(Math.max(Math.trunc(v.active), 0), layers.length - 1)
        : 0;
    return {
      version: 3,
      layers,
      active,
      matte_strokes,
      points,
      ...(canvas ? { canvas } : {}),
      layerGroups,
      ...(v.activeTarget === "mask" && layers[active]?.mask ? { activeTarget: "mask" as const } : {}),
    };
  }
  const ops: EditOp[] =
    version >= 2 && Array.isArray(v.ops)
      ? v.ops.filter(isEditOp)
      : legacyEditOps(v.paths, v.ops, v.brush_strokes, v.operations);
  return {
    version: 3,
    layers: [{ ...emptyMaskLayer(), ops }],
    active: 0,
    matte_strokes,
    points,
    layerGroups: [],
  };
}

function normalizeLayer(value: unknown, validGroupIds?: ReadonlySet<string>): MaskLayer | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    blend?: unknown;
    opacity?: unknown;
    visible?: unknown;
    locked?: unknown;
    linked?: unknown;
    groupId?: unknown;
    ops?: unknown;
    adjustment?: unknown;
    mask?: unknown;
  };
  const blank = emptyMaskLayer();
  const adjustment = normalizeAdjustment(v.adjustment);
  const isAdjustment = v.kind === "adjustment" && adjustment !== null;
  const mask = isAdjustment ? null : normalizeLayerMask(v.mask);
  return {
    id: typeof v.id === "string" && v.id ? v.id : blank.id,
    name: typeof v.name === "string" && v.name ? v.name : blank.name,
    kind: isAdjustment ? "adjustment" : "mask",
    blend: LAYER_BLENDS.includes(v.blend as LayerBlend) ? (v.blend as LayerBlend) : "normal",
    opacity: typeof v.opacity === "number" ? Math.min(Math.max(v.opacity, 0), 1) : 1,
    visible: v.visible !== false,
    ...(v.locked === true ? { locked: true } : null),
    ...(v.linked === true ? { linked: true } : null),
    ...(typeof v.groupId === "string" && (!validGroupIds || validGroupIds.has(v.groupId))
      ? { groupId: v.groupId }
      : null),
    ops: Array.isArray(v.ops) ? v.ops.filter(isEditOp) : [],
    ...(isAdjustment ? { adjustment } : null),
    ...(mask ? { mask } : null),
  };
}

function normalizeLayerMask(value: unknown): LayerMask | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { id?: unknown; ops?: unknown; disabled?: unknown; unlinked?: unknown };
  return {
    id: typeof v.id === "string" && v.id ? v.id : emptyLayerMask().id,
    ops: Array.isArray(v.ops) ? v.ops.filter(isEditOp) : [],
    ...(v.disabled === true ? { disabled: true } : null),
    ...(v.unlinked === true ? { unlinked: true } : null),
  };
}

function normalizeLayerGroups(value: unknown): LayerGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: LayerGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const group = item as { id?: unknown; name?: unknown; color?: unknown };
    const id = typeof group.id === "string" ? group.id.trim() : "";
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (
      !id ||
      !name ||
      seen.has(id) ||
      typeof group.color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(group.color)
    ) {
      continue;
    }
    seen.add(id);
    groups.push({ id, name, color: group.color.toLowerCase() });
  }
  return groups;
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

function isLegacyInlineWand(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const op = value as { type?: unknown; x?: unknown; y?: unknown };
  return op.type === "wand" && typeof op.x === "number" && typeof op.y === "number";
}

function legacyEditOps(paths: unknown, inlineOps: unknown, brushStrokes: unknown, operations: unknown): EditOp[] {
  const migrated: EditOp[] = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (path && typeof path === "object") migrated.push({ ...(path as EditPath), type: "path" });
  }
  for (const op of Array.isArray(inlineOps) ? inlineOps : []) {
    if (!op || typeof op !== "object") continue;
    const legacy = op as { type?: unknown; x?: unknown; y?: unknown; tolerance?: unknown };
    if (legacy.type === "invert") {
      migrated.push({ type: "invert" });
    } else if (legacy.type === "wand" && typeof legacy.x === "number" && typeof legacy.y === "number") {
      migrated.push({
        type: "wand",
        region: [Math.max(0, Math.trunc(legacy.x)), Math.max(0, Math.trunc(legacy.y))],
        ...(typeof legacy.tolerance === "number"
          ? { amount: Math.min(Math.max(Math.trunc(legacy.tolerance), 0), 255) }
          : {}),
      });
    }
  }
  for (const stroke of Array.isArray(brushStrokes) ? brushStrokes : []) {
    if (stroke && typeof stroke === "object") migrated.push({ ...(stroke as BrushStroke), type: "brush" });
  }
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (isEditOp(operation)) migrated.push(operation);
  }
  return migrated;
}

export function cloneMaskDocument(doc: MaskDocument): MaskDocument {
  return typeof structuredClone === "function"
    ? structuredClone(doc)
    : (JSON.parse(JSON.stringify(doc)) as MaskDocument);
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

const RESAMPLES: readonly ImageResample[] = ["auto", "nearest", "bilinear", "bicubic"];

function normalizeCanvas(value: unknown): ImageCanvasSize | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { w?: unknown; h?: unknown; resample?: unknown };
  if (typeof v.w !== "number" || typeof v.h !== "number" || v.w < 1 || v.h < 1) return null;
  return {
    w: Math.round(v.w),
    h: Math.round(v.h),
    resample: RESAMPLES.includes(v.resample as ImageResample) ? (v.resample as ImageResample) : "auto",
  };
}

/**
 * PS Image Size (Ctrl+Alt+I): record the requested output pixel size on the
 * document (undoable). The backend resamples the node's result on run.
 */
export function setCanvasSize(state: EditState, canvas: ImageCanvasSize): EditState {
  const next = normalizeCanvas(canvas);
  if (!next) return state;
  return commit(state, { ...state.current, canvas: next });
}

// Commit a new `current`, pushing the previous onto the undo stack and clearing
// the redo stack. The history is capped so a long editing session cannot grow
// unbounded in memory.
function commit(state: EditState, next: MaskDocument): EditState {
  const past = [...state.past, cloneMaskDocument(state.current)];
  if (past.length > MAX_HISTORY) past.shift();
  return { current: cloneMaskDocument(next), past, future: [] };
}

function chronologicalDocuments(state: EditState): MaskDocument[] {
  return [...state.past, state.current, ...state.future.slice().reverse()];
}

export function currentHistoryIndex(state: EditState): number {
  return state.past.length;
}

export function historySnapshots(state: EditState): HistorySnapshot[] {
  const docs = chronologicalDocuments(state);
  const currentIndex = currentHistoryIndex(state);
  return docs.map((doc, index) => ({
    index,
    doc,
    label: snapshotLabel(index > 0 ? docs[index - 1] : null, doc),
    current: index === currentIndex,
    layers: doc.layers.length,
    edits: editCount(doc),
    activeLayerName: doc.layers[Math.min(Math.max(doc.active, 0), doc.layers.length - 1)]?.name ?? "Layer",
  }));
}

export function jumpToHistorySnapshot(state: EditState, index: number): EditState {
  const docs = chronologicalDocuments(state);
  if (index < 0 || index >= docs.length || index === currentHistoryIndex(state)) return state;
  return {
    current: cloneMaskDocument(docs[index]),
    past: docs.slice(0, index).map(cloneMaskDocument),
    future: docs.slice(index + 1).reverse().map(cloneMaskDocument),
  };
}

function snapshotLabel(previous: MaskDocument | null, doc: MaskDocument): string {
  if (!previous) return "Open state";
  if (doc.layers.length > previous.layers.length) return `Add layer (${doc.layers.length})`;
  if (doc.layers.length < previous.layers.length) return `Remove layer (${doc.layers.length})`;
  if (doc.canvas?.w !== previous.canvas?.w || doc.canvas?.h !== previous.canvas?.h) return "Canvas size";
  if ((doc.layerGroups?.length ?? 0) !== (previous.layerGroups?.length ?? 0)) return "Layer groups";
  const prevEdits = editCount(previous);
  const nextEdits = editCount(doc);
  if (nextEdits > prevEdits) return labelEditOp(lastVisibleOp(doc)) ?? "Add edit";
  if (nextEdits < prevEdits) return "Remove edit";
  return "Document snapshot";
}

function lastVisibleOp(doc: MaskDocument): EditOp | null {
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const layer = doc.layers[li];
    const maskOps = layer.mask?.ops ?? [];
    const op = maskOps[maskOps.length - 1] ?? layer.ops[layer.ops.length - 1];
    if (op) return op;
  }
  return null;
}

export function labelEditOp(op: EditOp | null | undefined): string | null {
  if (!op) return null;
  if (isPathOp(op)) return `${op.tool} ${op.mode} (${op.points.length})`;
  if (isBrushOp(op)) return `${op.mode === "subtract" ? "eraser" : "brush"} r${op.radius} (${op.points.length})`;
  if (op.type === "transform") {
    const scale = op.scale ?? 1;
    const rotate = op.rotate ?? 0;
    return `transform d${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}${scale !== 1 ? ` x${scale}` : ""}${rotate !== 0 ? ` ${rotate}deg` : ""}`;
  }
  if (op.type === "fill") return `fill ${op.mode === "subtract" ? "subtract" : "add"} ${op.amount ?? 100}%`;
  if (op.type === "heal") return `heal r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "clone") return `clone r${op.amount ?? 8} d${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}`;
  if (op.type === "history_brush") return `history r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "dodge_burn") return `${op.mode === "burn" ? "burn" : "dodge"} r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "sponge") return `sponge ${op.mode === "desaturate" ? "desat" : "sat"} r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "healing_brush") return `healing r${op.amount ?? 8} d${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}`;
  if (op.type === "quick_select") return `quick select tol${op.amount ?? 0} (${op.points?.length ?? 0})`;
  if (op.type === "background_eraser") return `bg eraser r${op.amount ?? 8} tol${op.tolerance ?? 0}`;
  if (op.type === "patch") return `patch d${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)} (${op.points?.length ?? 0})`;
  if (op.type === "perspective_crop") return "perspective crop";
  if (op.type === "red_eye") return `red eye @${Math.round(op.region?.[0] ?? 0)},${Math.round(op.region?.[1] ?? 0)}`;
  if (op.type === "object_select") return "object select";
  if (op.type === "remove") return `remove r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "content_aware_move") return `ca move d${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)} (${op.points?.length ?? 0})`;
  if (op.type === "pattern_stamp") return `pattern r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "art_history_brush") return `art history r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  return op.type;
}

/** The active target's ordered edit stack (what the history panel shows):
 * the active layer's pixel stack, or its layer mask's stack when the mask
 * thumbnail is the active target. */
export function activeOps(doc: MaskDocument): EditOp[] {
  const layer = activeLayer(doc);
  if (!layer) return [];
  return activeTargetKind(doc) === "mask" && layer.mask ? layer.mask.ops : layer.ops;
}

/** Whether the layer receiving new edits is locked (PS "lock all"). */
export function activeLayerLocked(doc: MaskDocument): boolean {
  const layer = activeLayer(doc);
  return !layer || layer.locked === true;
}

// Replace the active target's ops: the active layer's pixel stack, or its
// layer mask's stack when the mask is the active target.
function withActiveOps(doc: MaskDocument, ops: EditOp[]): MaskDocument {
  const active = Math.min(Math.max(doc.active, 0), doc.layers.length - 1);
  const toMask = activeTargetKind(doc) === "mask";
  return {
    ...doc,
    layers: doc.layers.map((l, i) =>
      i !== active ? l : toMask && l.mask ? { ...l, mask: { ...l.mask, ops } } : { ...l, ops },
    ),
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

/** Append a closed vector selection path (rasterised by the backend on run). */
export function addPath(state: EditState, path: EditPath): EditState {
  if (path.points.length < 3 || activeLayerLocked(state.current)) return state;
  return commit(state, withActiveOps(state.current, [...activeOps(state.current), { ...path, type: "path" }]));
}

export function addOperation(state: EditState, op: MaskOperation): EditState {
  if (activeLayerLocked(state.current)) return state;
  const doc = withActiveOps(state.current, [...activeOps(state.current), op]);
  // PS layer link: a transform recorded on a linked layer mirrors onto every
  // other linked, unlocked mask layer (one undo step for the whole move).
  if (op.type === "transform" && activeLayer(state.current)?.linked) {
    return commit(state, {
      ...doc,
      layers: doc.layers.map((l, i) =>
        i !== doc.active && l.linked && l.kind === "mask" && !l.locked ? { ...l, ops: [...l.ops, { ...op }] } : l,
      ),
    });
  }
  return commit(state, doc);
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

/** Compose `b` applied after `a`. A transform op scales and rotates about
 * the image centre, then translates: `b ∘ a` keeps that shape, with `a`'s
 * translation carried through `b`'s rotation and scale. */
export function composeTransforms(a: TransformParams, b: TransformParams): TransformParams {
  const rad = (b.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    dx: b.scale * (cos * a.dx - sin * a.dy) + b.dx,
    dy: b.scale * (sin * a.dx + cos * a.dy) + b.dy,
    scale: a.scale * b.scale,
    rotate: a.rotate + b.rotate,
  };
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
export function addAdjustmentLayer(state: EditState, type: AdjustmentType, name?: string): EditState {
  const layers = [...state.current.layers, emptyAdjustmentLayer(type, name)];
  return commit(state, { ...state.current, layers, active: layers.length - 1 });
}

/** Revise an adjustment layer's tone-map params (undoable; M6). */
export function updateLayerAdjustment(state: EditState, index: number, adjustment: LayerAdjustment): EditState {
  const layer = state.current.layers[index];
  if (!layer || layer.kind !== "adjustment") return state;
  return withLayer(state, index, { adjustment });
}

/** Delete one unlocked layer (undoable), including the final layer. */
export function removeLayer(state: EditState, index: number): EditState {
  const { layers } = state.current;
  if (index < 0 || index >= layers.length || layers[index].locked) return state;
  const next = layers.filter((_, i) => i !== index);
  const active = Math.min(state.current.active > index ? state.current.active - 1 : state.current.active, next.length - 1);
  if (next.length === 0 || index === state.current.active) {
    const { activeTarget: _, ...doc } = state.current;
    return commit(state, { ...doc, layers: next, active });
  }
  return commit(state, { ...state.current, layers: next, active });
}

/** Select the layer new edits are recorded onto. Not an undo step. The
 * active target resets to the pixel content — the mask target never moves
 * across layers implicitly. */
export function setActiveLayer(state: EditState, index: number): EditState {
  if (index < 0 || index >= state.current.layers.length) return state;
  if (index === state.current.active && activeTargetKind(state.current) === "pixel") return state;
  const { activeTarget: _, ...doc } = state.current;
  return { ...state, current: { ...doc, active: index } };
}

/** Activate the pixel content or the layer mask of the active layer as the
 * edit target (PS: click the content / mask thumbnail). Not an undo step. */
export function setActiveTarget(state: EditState, target: LayerTargetKind): EditState {
  if (target === "mask" && !activeLayer(state.current)?.mask) return state;
  if (activeTargetKind(state.current) === target) return state;
  const { activeTarget: _, ...doc } = state.current;
  return { ...state, current: target === "mask" ? { ...doc, activeTarget: "mask" } : doc };
}

// --- layer mask attachments (PS: masks are targets on a layer, not layers) ---

/** Attach an empty layer mask to a layer and activate it (undoable). No-op
 * when the layer already owns a mask, is locked, or is an adjustment layer. */
export function addLayerMask(state: EditState, index: number): EditState {
  const layer = state.current.layers[index];
  if (!layer || layer.mask || layer.locked || layer.kind === "adjustment") return state;
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? { ...l, mask: emptyLayerMask() } : l)),
    active: index,
    activeTarget: "mask",
  });
}

/** Remove a layer's mask attachment only — never the layer itself (undoable). */
export function removeLayerMask(state: EditState, index: number): EditState {
  const layer = state.current.layers[index];
  if (!layer?.mask || layer.locked) return state;
  const { activeTarget: _, ...doc } = state.current;
  return commit(state, {
    ...doc,
    layers: state.current.layers.map((l, i) => {
      if (i !== index) return l;
      const { mask: __, ...rest } = l;
      return rest;
    }),
  });
}

/** Toggle a mask's disabled flag: keep the data, bypass the gating (undoable). */
export function toggleLayerMaskDisabled(state: EditState, index: number): EditState {
  const mask = state.current.layers[index]?.mask;
  if (!mask) return state;
  const next: LayerMask = { ...mask, disabled: !mask.disabled };
  if (!next.disabled) delete next.disabled;
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? { ...l, mask: next } : l)),
  });
}

/** Toggle the pixel↔mask link (PS chain icon; undoable). */
export function toggleLayerMaskLink(state: EditState, index: number): EditState {
  const mask = state.current.layers[index]?.mask;
  if (!mask) return state;
  const next: LayerMask = { ...mask, unlinked: !mask.unlinked };
  if (!next.unlinked) delete next.unlinked;
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? { ...l, mask: next } : l)),
  });
}

/** A layer's replayable op stacks: the pixel stack plus its enabled layer
 * mask's stack (disabled masks keep their data but do not replay). */
export function layerOpStacks(layer: MaskLayer): { target: LayerTargetKind; ops: EditOp[] }[] {
  const stacks: { target: LayerTargetKind; ops: EditOp[] }[] = [{ target: "pixel", ops: layer.ops }];
  if (layer.mask && !layer.mask.disabled) stacks.push({ target: "mask", ops: layer.mask.ops });
  return stacks;
}

export function hasSourceImageContent(layer: MaskLayer): boolean {
  return layer.kind !== "adjustment" && layer.ops.some((op) => op.type === SOURCE_IMAGE_OP_TYPE);
}

function withLayer(state: EditState, index: number, patch: Partial<MaskLayer>): EditState {
  const layer = state.current.layers[index];
  if (!layer) return state;
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? { ...l, ...patch } : l)),
  });
}

function sameLayerGroups(a: readonly LayerGroup[], b: readonly LayerGroup[]): boolean {
  return (
    a.length === b.length &&
    a.every((group, index) => {
      const next = b[index];
      return group.id === next.id && group.name === next.name && group.color === next.color;
    })
  );
}

function withoutLayerGroupId(layer: MaskLayer): MaskLayer {
  const next = { ...layer };
  delete next.groupId;
  return next;
}

/** Replace the document's visual layer-group tags without changing stack order. */
export function setLayerGroups(state: EditState, groups: LayerGroup[]): EditState {
  const nextGroups = normalizeLayerGroups(groups);
  const valid = new Set(nextGroups.map((g) => g.id));
  let changed = !sameLayerGroups(state.current.layerGroups, nextGroups);
  const layers = state.current.layers.map((layer) => {
    if (!layer.groupId || valid.has(layer.groupId)) return layer;
    changed = true;
    return withoutLayerGroupId(layer);
  });
  if (!changed) return state;
  return commit(state, {
    ...state.current,
    layers,
    layerGroups: nextGroups,
  });
}

/** Assign or clear one layer's visual group tag. Ungrouped layers keep default styling. */
export function setLayerGroup(state: EditState, index: number, groupId: string | null): EditState {
  const layer = state.current.layers[index];
  const nextId = groupId || undefined;
  if (!layer || layer.groupId === nextId) return state;
  if (nextId && !state.current.layerGroups.some((group) => group.id === nextId)) return state;
  const nextLayer = nextId ? { ...layer, groupId: nextId } : withoutLayerGroupId(layer);
  return commit(state, {
    ...state.current,
    layers: state.current.layers.map((l, i) => (i === index ? nextLayer : l)),
  });
}

/** Toggle a layer's PS link flag (undoable). Transforms mirror across linked layers. */
export function toggleLayerLink(state: EditState, index: number): EditState {
  const layer = state.current.layers[index];
  if (!layer) return state;
  return withLayer(state, index, layer.linked ? { linked: undefined } : { linked: true });
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

/**
 * PS merge (合并图层 / 向下合并): collapse two or more mask layers into the
 * lowest one by replaying their edit stacks bottom-up onto it (undoable).
 * Adjustment layers and locked layers cannot merge; the merged layer keeps
 * the bottom layer's identity, blend and opacity and becomes active.
 */
export function mergeLayers(state: EditState, indices: number[]): EditState {
  const { layers } = state.current;
  const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < layers.length).sort((a, b) => a - b);
  if (sorted.length < 2) return state;
  if (sorted.some((i) => layers[i].kind !== "mask" || layers[i].locked)) return state;
  const [target, ...rest] = sorted;
  const merged: MaskLayer = {
    ...layers[target],
    ops: sorted.flatMap((i) => layers[i].ops.map((op) => ({ ...op }))),
  };
  const removed = new Set(rest);
  const next = layers.map((l, i) => (i === target ? merged : l)).filter((_, i) => !removed.has(i));
  const active = next.findIndex((l) => l.id === merged.id);
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
 * With an active selection this is PS Layer Via Copy: the copy carries a
 * layer mask filled with the selection, so it holds only the selected region's
 * content. In the image workspace the base layer is the opened image even
 * when its op stack is empty; `includeSourceImage` records that source-backed
 * content explicitly so the copy is not mistaken for a transparent layer.
 */
export function duplicateLayer(
  state: EditState,
  selection?: LayerCopySelection | null,
  options: { includeSourceImage?: boolean } = {},
): EditState {
  const doc = state.current;
  const index = Math.min(Math.max(doc.active, 0), doc.layers.length - 1);
  const source = doc.layers[index];
  const copyOps = source.ops.map((op) => ({ ...op }));
  const shouldCarrySourceImage =
    source.kind !== "adjustment" && (hasSourceImageContent(source) || (options.includeSourceImage === true && index === 0));
  if (shouldCarrySourceImage && !copyOps.some((op) => op.type === SOURCE_IMAGE_OP_TYPE)) {
    copyOps.unshift({ type: SOURCE_IMAGE_OP_TYPE });
  }
  const mask: LayerMask | null = selection
    ? {
        ...emptyLayerMask(),
        ops:
          selection.polygon && selection.polygon.length >= 3
            ? [
                {
                  type: "path",
                  id: `copy-mask-${Math.random().toString(36).slice(2, 10)}`,
                  mode: "add",
                  tool: "selection",
                  closed: true,
                  points: selection.polygon.map(([x, y]) => ({ x, y })),
                },
              ]
            : [{ type: selection.ellipse ? "ellipse" : "rect", region: [...selection.region] }],
      }
    : source.mask
      ? { ...source.mask, id: emptyLayerMask().id, ops: source.mask.ops.map((op) => ({ ...op })) }
      : null;
  const copy: MaskLayer = {
    ...source,
    id: emptyMaskLayer().id,
    name: `${source.name} copy`,
    ops: copyOps,
    ...(mask ? { mask } : null),
  };
  const layers = [...doc.layers.slice(0, index + 1), copy, ...doc.layers.slice(index + 1)];
  return commit(state, { ...doc, layers, active: index + 1 });
}

export function undo(state: EditState): EditState {
  if (state.past.length === 0) return state;
  const past = [...state.past];
  const previous = past.pop()!;
  return { current: cloneMaskDocument(previous), past, future: [...state.future, cloneMaskDocument(state.current)] };
}

export function redo(state: EditState): EditState {
  if (state.future.length === 0) return state;
  const future = [...state.future];
  const next = future.pop()!;
  return { current: cloneMaskDocument(next), past: [...state.past, cloneMaskDocument(state.current)], future };
}

export const canUndo = (state: EditState): boolean => state.past.length > 0;
export const canRedo = (state: EditState): boolean => state.future.length > 0;

export function isEmpty(doc: MaskDocument): boolean {
  return (
    doc.layers.length === 1 &&
    doc.layers.every((l) => l.ops.length === 0 && !l.mask) &&
    doc.matte_strokes.length === 0 &&
    doc.points.length === 0
  );
}

/** Count of applied edits, for the modal's status line. */
export function editCount(doc: MaskDocument): number {
  return (
    doc.layers.reduce((n, l) => n + l.ops.length + (l.mask?.ops.length ?? 0), 0) +
    doc.matte_strokes.length +
    doc.points.length
  );
}
