import type { ImageEditorDocument, ImageEditorLayer } from "../../contracts/imageEditorDocument";
import { type Rect, transformRect } from "../studioTarget";
import { imageLayerDrawsSource, layerCompositeTransform, layerSourceImageOp } from "../imageCompositeSource";

export interface SceneFrame {
  /** World/document coordinate at the left edge of this rendered frame. */
  x: number;
  /** World/document coordinate at the top edge of this rendered frame. */
  y: number;
  /** Rendered frame width in world/document pixels. */
  w: number;
  /** Rendered frame height in world/document pixels. */
  h: number;
}

export interface StageSize {
  w: number;
  h: number;
}

const PASTEBOARD_MARGIN_MIN = 48;
const PASTEBOARD_MARGIN_MAX = 256;
const PASTEBOARD_MARGIN_RATIO = 0.12;
const MAX_SCENE_FRAME_ABSOLUTE_SPAN = 8192;
const MAX_SCENE_FRAME_DOC_FACTOR = 4;
const WORLD_COORDINATE_LIMIT = 1_000_000;

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeDocumentDims(dims: { w: number; h: number }): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(finiteNumber(dims.w, 1))),
    h: Math.max(1, Math.round(finiteNumber(dims.h, 1))),
  };
}

function clampWorldCoord(value: number): number {
  return Math.max(-WORLD_COORDINATE_LIMIT, Math.min(WORLD_COORDINATE_LIMIT, value));
}

function safeRect(rect: Rect): Rect | null {
  if (!rect.every(Number.isFinite)) return null;
  return [
    clampWorldCoord(rect[0]),
    clampWorldCoord(rect[1]),
    clampWorldCoord(rect[2]),
    clampWorldCoord(rect[3]),
  ];
}

function rectUnion(a: Rect, b: Rect): Rect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function normalizeRect(rect: Rect): Rect | null {
  const safe = safeRect(rect);
  if (!safe) return null;
  const x0 = Math.min(safe[0], safe[2]);
  const y0 = Math.min(safe[1], safe[3]);
  const x1 = Math.max(safe[0], safe[2]);
  const y1 = Math.max(safe[1], safe[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function frameToRect(frame: SceneFrame | null | undefined): Rect | null {
  if (!frame) return null;
  return normalizeRect([frame.x, frame.y, frame.x + frame.w, frame.y + frame.h]);
}

function frameFromRect(rect: Rect): SceneFrame {
  const safe = normalizeRect(rect) ?? [0, 0, 1, 1];
  const x = Math.floor(safe[0]);
  const y = Math.floor(safe[1]);
  const right = Math.ceil(safe[2]);
  const bottom = Math.ceil(safe[3]);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

function expandRectToAspect(rect: Rect, stage: StageSize | null | undefined): Rect {
  if (!stage || stage.w <= 0 || stage.h <= 0) return rect;
  const targetAspect = stage.w / stage.h;
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) return rect;

  const width = Math.max(1, rect[2] - rect[0]);
  const height = Math.max(1, rect[3] - rect[1]);
  const currentAspect = width / height;
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;

  if (currentAspect > targetAspect) {
    const nextHeight = width / targetAspect;
    return [rect[0], cy - nextHeight / 2, rect[2], cy + nextHeight / 2];
  }

  const nextWidth = height * targetAspect;
  return [cx - nextWidth / 2, rect[1], cx + nextWidth / 2, rect[3]];
}

function pasteboardMargin(dims: { w: number; h: number }): { x: number; y: number } {
  const safe = safeDocumentDims(dims);
  return {
    x: Math.min(PASTEBOARD_MARGIN_MAX, Math.max(PASTEBOARD_MARGIN_MIN, safe.w * PASTEBOARD_MARGIN_RATIO)),
    y: Math.min(PASTEBOARD_MARGIN_MAX, Math.max(PASTEBOARD_MARGIN_MIN, safe.h * PASTEBOARD_MARGIN_RATIO)),
  };
}

function padRect(rect: Rect, margin: { x: number; y: number }): Rect {
  return [rect[0] - margin.x, rect[1] - margin.y, rect[2] + margin.x, rect[3] + margin.y];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxSceneFrameSpan(dims: { w: number; h: number }, margin: { x: number; y: number }): { w: number; h: number } {
  const safe = safeDocumentDims(dims);
  return {
    w: Math.max(safe.w + margin.x * 2, Math.min(MAX_SCENE_FRAME_ABSOLUTE_SPAN, safe.w * MAX_SCENE_FRAME_DOC_FACTOR + margin.x * 2)),
    h: Math.max(safe.h + margin.y * 2, Math.min(MAX_SCENE_FRAME_ABSOLUTE_SPAN, safe.h * MAX_SCENE_FRAME_DOC_FACTOR + margin.y * 2)),
  };
}

function limitRectSpan(rect: Rect, anchor: Rect, maxSpan: { w: number; h: number }): Rect {
  const safe = normalizeRect(rect) ?? anchor;
  const anchorSafe = normalizeRect(anchor) ?? [0, 0, 1, 1];
  const anchorW = anchorSafe[2] - anchorSafe[0];
  const anchorH = anchorSafe[3] - anchorSafe[1];
  const width = Math.max(anchorW, Math.min(safe[2] - safe[0], maxSpan.w));
  const height = Math.max(anchorH, Math.min(safe[3] - safe[1], maxSpan.h));
  const desiredLeft = (safe[0] + safe[2] - width) / 2;
  const desiredTop = (safe[1] + safe[3] - height) / 2;
  const left = clamp(desiredLeft, anchorSafe[2] - width, anchorSafe[0]);
  const top = clamp(desiredTop, anchorSafe[3] - height, anchorSafe[1]);
  return [left, top, left + width, top + height];
}

function layerBaseRect(layer: ImageEditorLayer, index: number, dims: { w: number; h: number }): Rect | null {
  if (!imageLayerDrawsSource(layer, index)) return null;
  const source = layerSourceImageOp(layer);
  if (source?.placement) return normalizeRect(source.placement);
  const safe = safeDocumentDims(dims);
  return [0, 0, safe.w, safe.h];
}

function transformedLayerRect(layer: ImageEditorLayer, index: number, dims: { w: number; h: number }): Rect | null {
  const rect = layerBaseRect(layer, index, dims);
  if (!rect) return null;
  const transform = layerCompositeTransform(layer);
  if (!transform || !Object.values(transform).every(Number.isFinite)) return rect;
  return normalizeRect(transformRect(rect, transform, safeDocumentDims(dims)));
}

export function imageSceneBounds(doc: ImageEditorDocument, dims: { w: number; h: number }): Rect {
  const safe = safeDocumentDims(dims);
  const documentRect: Rect = [0, 0, safe.w, safe.h];
  let world = documentRect;

  doc.layers.forEach((layer, index) => {
    const rect = transformedLayerRect(layer, index, dims);
    if (rect) world = rectUnion(world, rect);
  });

  return world;
}

/**
 * The image editor is an infinite pasteboard. The document size remains the
 * edit coordinate system; this frame is only the current rendered window.
 */
export function imageSceneFrame(
  doc: ImageEditorDocument,
  dims: { w: number; h: number },
  stage: StageSize | null | undefined,
): SceneFrame {
  const safe = safeDocumentDims(dims);
  return frameFromRect(expandRectToAspect(imageSceneBounds(doc, safe), stage));
}

/**
 * Stable pasteboard frame for interactive editing. It starts with a modest
 * guard band around the document/content and grows only when content escapes
 * that band; it never shrinks while the editor session stays on the same
 * document size. This keeps layer drags from changing the fit scale every
 * pointer tick.
 */
export function stableImageSceneFrame(
  _doc: ImageEditorDocument,
  dims: { w: number; h: number },
  stage: StageSize | null | undefined,
  previous?: SceneFrame | null,
): SceneFrame {
  const safe = safeDocumentDims(dims);
  const margin = pasteboardMargin(safe);
  const anchor = padRect([0, 0, safe.w, safe.h], margin);
  const base = frameToRect(previous) ?? anchor;
  const expanded = expandRectToAspect(base, stage);
  return frameFromRect(limitRectSpan(expanded, anchor, maxSceneFrameSpan(safe, margin)));
}

export function identitySceneFrame(dims: { w: number; h: number }): SceneFrame {
  const safe = safeDocumentDims(dims);
  return { x: 0, y: 0, w: safe.w, h: safe.h };
}
