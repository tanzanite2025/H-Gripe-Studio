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

import type { MaskDocument } from "../types/production";
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
  source: "pen" | "lasso" | "marquee" | "sam2" | "wand" | "mask";
  /** Image-space `[x1, y1, x2, y2]`. */
  bounds: [number, number, number, number];
  maskArtifactRef?: string;
  pathId?: string;
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
