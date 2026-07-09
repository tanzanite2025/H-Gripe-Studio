import type { MaskDocument } from "../types/production";
import type { ViewportTarget } from "../bridge/viewport";
import { hasSourceImageContent } from "./maskEdit";

export interface ImageCompositeDims {
  w: number;
  h: number;
}

export function imageDocumentNeedsComposite(doc: MaskDocument): boolean {
  const base = doc.layers[0];
  if (!base) return false;
  if (base.kind !== "adjustment" && (base.visible === false || base.opacity < 1 || base.mask)) return true;
  return doc.layers.some((layer, index) => (
    index > 0 &&
    layer.visible !== false &&
    layer.kind !== "adjustment" &&
    hasSourceImageContent(layer)
  ));
}

export function imageCompositeDocumentKey(doc: MaskDocument, dims: ImageCompositeDims): string {
  return JSON.stringify({
    w: Math.max(1, Math.round(dims.w)),
    h: Math.max(1, Math.round(dims.h)),
    layers: doc.layers.map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      visible: layer.visible,
      opacity: layer.opacity,
      blend: layer.blend,
      ops: layer.ops,
      mask: layer.mask ?? null,
      adjustment: layer.adjustment ?? null,
    })),
  });
}

export function imageCompositeTarget(
  resourceId: string,
  doc: MaskDocument,
  dims: ImageCompositeDims,
): ViewportTarget {
  return {
    kind: "image_composite",
    resourceId,
    document: doc,
    documentKey: imageCompositeDocumentKey(doc, dims),
    documentWidth: Math.max(1, Math.round(dims.w)),
    documentHeight: Math.max(1, Math.round(dims.h)),
  };
}

export function withActiveLayerDraftTransform(
  doc: MaskDocument,
  draft: readonly [number, number] | null,
): MaskDocument {
  if (!draft || (Math.abs(draft[0]) < 0.01 && Math.abs(draft[1]) < 0.01)) return doc;
  const active = Math.min(Math.max(doc.active, 0), doc.layers.length - 1);
  return {
    ...doc,
    layers: doc.layers.map((layer, index) => (
      index === active && layer.kind !== "adjustment"
        ? { ...layer, ops: [...layer.ops, { type: "transform", dx: draft[0], dy: draft[1] }] }
        : layer
    )),
  };
}
