// Studio target vocabulary (docs/plans/active/
// MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md). Every manual tool, compute
// block, and future Studio Action addresses the same first-class target ids:
//
//   canvas -> document -> layer -> layer mask / selection / path / node output
//
// A selection is not a layer mask is not a pixel layer is not a node output —
// they convert into each other but are never conflated. Actions resolve a
// `StudioTarget` before they run, so "make a mask" can never silently mean
// "create a new layer."

import type { EditPath, MaskDocument, MaskLayer } from "../types/production";
import { activeLayer, activeTargetKind } from "../types/production";

export type StudioTarget =
  | { kind: "document"; canvasId: string; documentId: string }
  | { kind: "pixel_layer"; canvasId: string; documentId: string; layerId: string }
  | { kind: "layer_mask"; canvasId: string; documentId: string; layerId: string; maskId: string }
  | { kind: "selection"; canvasId: string; documentId: string; selectionId: string }
  | { kind: "path"; canvasId: string; documentId: string; pathId: string }
  | { kind: "node_output"; canvasId: string; nodeId: string; portId: string };

/** Where a document lives: the graph canvas and the node param holding it. */
export interface StudioDocumentRef {
  canvasId: string;
  documentId: string;
}

/**
 * Resolve the document's explicitly stored active target — the pixel content
 * or the layer mask of the active layer. The target is read from document
 * state, never inferred from the last clicked tool.
 */
export function resolveActiveTarget(doc: MaskDocument, ref: StudioDocumentRef): StudioTarget {
  const layer = activeLayer(doc);
  if (activeTargetKind(doc) === "mask" && layer.mask) {
    return { kind: "layer_mask", ...ref, layerId: layer.id, maskId: layer.mask.id };
  }
  return { kind: "pixel_layer", ...ref, layerId: layer.id };
}

/**
 * A selection target: persistent id + source metadata. The selection may be
 * temporary, but while it exists it is addressable by actions and previews
 * (a selection is never itself a layer mask — it can be committed into one).
 */
export interface SelectionTarget {
  id: string;
  source: "pen" | "magnetic_lasso" | "polygon_lasso" | "marquee" | "sam2" | "wand" | "mask";
  /** Image-space `[x1, y1, x2, y2]`. */
  bounds: [number, number, number, number];
  maskArtifactRef?: string;
  pathId?: string;
}

export type Rect = [number, number, number, number];

export type TargetBounds =
  | { kind: "none" }
  | { kind: "document"; rect: Rect }
  | { kind: "layer_frame"; rect: Rect; layerId: string }
  | { kind: "content"; rect: Rect; layerId: string; source: "alpha" | "ops" | "asset" | "override" }
  | { kind: "mask"; rect: Rect; layerId: string; maskId: string }
  | { kind: "selection"; rect: Rect; selectionId: string }
  | { kind: "path"; rect: Rect; pathId: string }
  | { kind: "node_output"; rect: Rect; nodeId: string; portId: string };

export interface TargetBoundsTransform {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
}

export interface TargetBoundsContext {
  dims: { w: number; h: number };
  selections?: readonly SelectionTarget[];
  paths?: readonly EditPath[];
  layerContentBounds?: RectLookup;
  layerMaskBounds?: RectLookup;
  nodeOutputBounds?: RectLookup;
}

type RectLookup = ReadonlyMap<string, Rect> | Record<string, Rect | undefined>;

function lookupRect(source: RectLookup | undefined, key: string): Rect | null {
  if (!source) return null;
  if (source instanceof Map) return source.get(key) ?? null;
  return (source as Record<string, Rect | undefined>)[key] ?? null;
}

function fullDocumentRect(dims: { w: number; h: number }): Rect {
  return [0, 0, Math.max(0, dims.w), Math.max(0, dims.h)];
}

function transformPoint(point: [number, number], transform: TargetBoundsTransform, dims: { w: number; h: number }): [number, number] {
  const cx = dims.w / 2;
  const cy = dims.h / 2;
  const rad = (transform.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = (point[0] - cx) * transform.scale;
  const sy = (point[1] - cy) * transform.scale;
  return [cx + sx * cos - sy * sin + transform.dx, cy + sx * sin + sy * cos + transform.dy];
}

export function transformRect(rect: Rect, transform: TargetBoundsTransform, dims: { w: number; h: number }): Rect {
  const points = [
    transformPoint([rect[0], rect[1]], transform, dims),
    transformPoint([rect[2], rect[1]], transform, dims),
    transformPoint([rect[2], rect[3]], transform, dims),
    transformPoint([rect[0], rect[3]], transform, dims),
  ];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function isLayerBoundTargetBounds(bounds: TargetBounds): bounds is Extract<TargetBounds, { layerId: string }> {
  return bounds.kind === "layer_frame" || bounds.kind === "content" || bounds.kind === "mask";
}

export function transformLayerTargetBounds(bounds: TargetBounds, transform: TargetBoundsTransform | null, dims: { w: number; h: number }): TargetBounds {
  if (!transform || !isLayerBoundTargetBounds(bounds)) return bounds;
  return { ...bounds, rect: transformRect(bounds.rect, transform, dims) };
}

function normalizeRect(rect: Rect, dims: { w: number; h: number }): Rect | null {
  const x1 = Math.max(0, Math.min(rect[0], rect[2], dims.w));
  const y1 = Math.max(0, Math.min(rect[1], rect[3], dims.h));
  const x2 = Math.max(0, Math.min(Math.max(rect[0], rect[2]), dims.w));
  const y2 = Math.max(0, Math.min(Math.max(rect[1], rect[3]), dims.h));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function findLayer(doc: MaskDocument, layerId: string): MaskLayer | null {
  return doc.layers.find((layer) => layer.id === layerId) ?? null;
}

export function pathBounds(path: EditPath, dims: { w: number; h: number }): Rect | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of path.points) {
    xs.push(point.x);
    ys.push(point.y);
    if (point.in) {
      xs.push(point.in[0]);
      ys.push(point.in[1]);
    }
    if (point.out) {
      xs.push(point.out[0]);
      ys.push(point.out[1]);
    }
  }
  if (xs.length === 0) return null;
  return normalizeRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], dims);
}

export function resolveTargetBounds(doc: MaskDocument, target: StudioTarget, ctx: TargetBoundsContext): TargetBounds {
  const { dims } = ctx;
  const documentRect = fullDocumentRect(dims);
  switch (target.kind) {
    case "document":
      return { kind: "document", rect: documentRect };
    case "pixel_layer": {
      const layer = findLayer(doc, target.layerId);
      if (!layer) return { kind: "none" };
      const contentOverride = lookupRect(ctx.layerContentBounds, target.layerId);
      const content = contentOverride ? normalizeRect(contentOverride, dims) : null;
      return content
        ? { kind: "content", rect: content, layerId: layer.id, source: "override" }
        : { kind: "layer_frame", rect: documentRect, layerId: layer.id };
    }
    case "layer_mask": {
      const layer = findLayer(doc, target.layerId);
      if (!layer || !layer.mask || layer.mask.id !== target.maskId) return { kind: "none" };
      const mask = normalizeRect(lookupRect(ctx.layerMaskBounds, target.maskId) ?? documentRect, dims);
      return mask ? { kind: "mask", rect: mask, layerId: layer.id, maskId: layer.mask.id } : { kind: "none" };
    }
    case "selection": {
      const selection = ctx.selections?.find((item) => item.id === target.selectionId);
      if (!selection) return { kind: "none" };
      const rect = normalizeRect(selection.bounds, dims);
      return rect ? { kind: "selection", rect, selectionId: selection.id } : { kind: "none" };
    }
    case "path": {
      const path = ctx.paths?.find((item) => item.id === target.pathId);
      if (!path) return { kind: "none" };
      const rect = pathBounds(path, dims);
      return rect ? { kind: "path", rect, pathId: path.id } : { kind: "none" };
    }
    case "node_output": {
      const key = `${target.nodeId}:${target.portId}`;
      const rect = normalizeRect(lookupRect(ctx.nodeOutputBounds, key) ?? lookupRect(ctx.nodeOutputBounds, target.nodeId) ?? documentRect, dims);
      return rect ? { kind: "node_output", rect, nodeId: target.nodeId, portId: target.portId } : { kind: "none" };
    }
  }
}

/** A stable human/log-readable id for a resolved target. */
export function describeTarget(target: StudioTarget): string {
  switch (target.kind) {
    case "document":
      return `document(${target.documentId})`;
    case "pixel_layer":
      return `pixel_layer(${target.layerId})`;
    case "layer_mask":
      return `layer_mask(${target.layerId}/${target.maskId})`;
    case "selection":
      return `selection(${target.selectionId})`;
    case "path":
      return `path(${target.pathId})`;
    case "node_output":
      return `node_output(${target.nodeId}:${target.portId})`;
  }
}
