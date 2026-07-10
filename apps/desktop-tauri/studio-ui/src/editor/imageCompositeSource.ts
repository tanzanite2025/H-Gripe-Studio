import { type MaskDocument, type MaskLayer } from "../contracts/maskDocument";
import { isMaskOperation, type EditOpBase, type MaskOperation } from "../contracts/maskOps";
import type { ViewportTarget } from "../bridge/viewport";
import { composeTransforms, hasSourceImageContent, SOURCE_IMAGE_OP_TYPE, type TransformParams } from "./maskEdit";
import { layerAlphaBounds, type AlphaBounds, type LayerAlphaBoundsOptions } from "./maskMorphology";

export interface ImageCompositeDims {
  w: number;
  h: number;
}

export function imageDocumentNeedsComposite(doc: MaskDocument): boolean {
  const base = doc.layers[0];
  if (!base) return false;
  if (base.kind !== "adjustment" && (base.visible === false || base.opacity < 1 || base.mask)) return true;
  if (doc.layers.some((layer) => layerSourceImageOp(layer))) return true;
  return doc.layers.some((layer, index) => index > 0 && imageLayerDrawsSource(layer, index));
}

/** The layer's `source_image` op when it carries its own image resource or a
 * placement rect — the placed-layer model the compositor must resolve. */
export function layerSourceImageOp(layer: MaskLayer): (MaskOperation & EditOpBase) | null {
  if (layer.kind === "adjustment") return null;
  for (const op of layer.ops) {
    if (op.type !== SOURCE_IMAGE_OP_TYPE || op.disabled || !isMaskOperation(op)) continue;
    if (op.source || op.placement) return op;
  }
  return null;
}


export function imageLayerDrawsSource(layer: MaskLayer, index: number): boolean {
  return layer.visible !== false && (layer.opacity ?? 1) > 0 && imageLayerHasSourceContent(layer, index);
}

export function imageLayerHasSourceContent(layer: MaskLayer, index: number): boolean {
  return layer.kind !== "adjustment" && (index === 0 || hasSourceImageContent(layer));
}

export function imageDocumentHasVisibleSource(doc: MaskDocument): boolean {
  return doc.layers.some((layer, index) => imageLayerDrawsSource(layer, index));
}

export function imageDocumentFrameHidden(doc: MaskDocument): boolean {
  return !imageDocumentHasVisibleSource(doc);
}

export function imageLayerContentBounds(
  layer: MaskLayer,
  index: number,
  dims: ImageCompositeDims,
  options: Pick<LayerAlphaBoundsOptions, "proxyWidth" | "alphaThreshold"> = {},
): AlphaBounds | null {
  if (layer.kind === "adjustment") return null;
  return layerAlphaBounds(layer, dims, { ...options, implicitSource: index === 0, ignoreTransforms: true });
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

function isIdentityTransform(transform: TransformParams): boolean {
  return transform.dx === 0 && transform.dy === 0 && transform.scale === 1 && transform.rotate === 0;
}

export function layerCompositeTransform(
  layer: MaskLayer | null | undefined,
  draft: readonly [number, number] | null = null,
): TransformParams | null {
  if (!layer || layer.kind === "adjustment") return null;
  let transform: TransformParams | null = null;
  for (const op of layer.ops) {
    if (op.disabled || op.type !== "transform") continue;
    const next = {
      dx: op.dx ?? 0,
      dy: op.dy ?? 0,
      scale: op.scale ?? 1,
      rotate: op.rotate ?? 0,
    };
    transform = transform ? composeTransforms(transform, next) : next;
  }
  if (draft && (Math.abs(draft[0]) >= 0.01 || Math.abs(draft[1]) >= 0.01)) {
    const next = { dx: draft[0], dy: draft[1], scale: 1, rotate: 0 };
    transform = transform ? composeTransforms(transform, next) : next;
  }
  return transform && !isIdentityTransform(transform) ? transform : null;
}
