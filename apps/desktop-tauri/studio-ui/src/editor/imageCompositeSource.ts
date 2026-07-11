import { type ImageEditorDocument, type ImageEditorLayer } from "../contracts/imageEditorDocument";
import { isImageEditOperation, type EditOpBase, type ImageEditOperation } from "../contracts/imageEditOps";
import type { ViewportTarget } from "../bridge/viewport";
import { composeTransforms, hasSourceImageContent, SOURCE_IMAGE_OP_TYPE, type TransformParams } from "./imageEditorState";
import { layerAlphaBounds, type AlphaBounds, type LayerAlphaBoundsOptions } from "./maskMorphology";

export interface ImageCompositeDims {
  w: number;
  h: number;
}

export interface ImageCompositeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

function finiteRound(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function identityFrame(dims: ImageCompositeDims): ImageCompositeFrame {
  return { x: 0, y: 0, w: Math.max(1, finiteRound(dims.w, 1)), h: Math.max(1, finiteRound(dims.h, 1)) };
}

function sanitizeCompositeFrame(frame: ImageCompositeFrame, dims: ImageCompositeDims): ImageCompositeFrame {
  const fallback = identityFrame(dims);
  return {
    x: finiteRound(frame.x, fallback.x),
    y: finiteRound(frame.y, fallback.y),
    w: Math.max(1, finiteRound(frame.w, fallback.w)),
    h: Math.max(1, finiteRound(frame.h, fallback.h)),
  };
}

/** The layer's `source_image` op when it carries its own image resource or a
 * placement rect — the placed-layer model the compositor must resolve. */
export function layerSourceImageOp(layer: ImageEditorLayer): (ImageEditOperation & EditOpBase) | null {
  if (layer.kind === "adjustment") return null;
  for (const op of layer.ops) {
    if (op.type !== SOURCE_IMAGE_OP_TYPE || op.disabled || !isImageEditOperation(op)) continue;
    if (op.source || op.placement) return op;
  }
  return null;
}


export function imageLayerDrawsSource(layer: ImageEditorLayer, index: number): boolean {
  return layer.visible !== false && (layer.opacity ?? 1) > 0 && imageLayerHasSourceContent(layer, index);
}

export function imageLayerHasSourceContent(layer: ImageEditorLayer, index: number): boolean {
  return layer.kind !== "adjustment" && (index === 0 || hasSourceImageContent(layer));
}

export function imageCompositeBackingPath(doc: ImageEditorDocument, imagePath?: string | null): string | null {
  if (imagePath) return imagePath;
  for (const layer of doc.layers) {
    const source = layerSourceImageOp(layer)?.source?.path;
    if (source) return source;
  }
  return null;
}

export function imageLayerContentBounds(
  layer: ImageEditorLayer,
  index: number,
  dims: ImageCompositeDims,
  options: Pick<LayerAlphaBoundsOptions, "proxyWidth" | "alphaThreshold"> = {},
): AlphaBounds | null {
  if (layer.kind === "adjustment") return null;
  return layerAlphaBounds(layer, dims, { ...options, implicitSource: index === 0, ignoreTransforms: true });
}

export function imageCompositeDocumentKey(
  doc: ImageEditorDocument,
  dims: ImageCompositeDims,
  frame: ImageCompositeFrame = identityFrame(dims),
): string {
  const safeDims = identityFrame(dims);
  return JSON.stringify({
    w: safeDims.w,
    h: safeDims.h,
    frame: {
      ...sanitizeCompositeFrame(frame, dims),
    },
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
  doc: ImageEditorDocument,
  dims: ImageCompositeDims,
  frame: ImageCompositeFrame = identityFrame(dims),
): ViewportTarget {
  const safeDims = identityFrame(dims);
  const resolvedFrame = sanitizeCompositeFrame(frame, dims);
  return {
    kind: "image_composite",
    resourceId,
    document: doc,
    documentKey: imageCompositeDocumentKey(doc, dims, resolvedFrame),
    documentWidth: safeDims.w,
    documentHeight: safeDims.h,
    frameX: resolvedFrame.x,
    frameY: resolvedFrame.y,
    frameWidth: resolvedFrame.w,
    frameHeight: resolvedFrame.h,
  };
}

function isIdentityTransform(transform: TransformParams): boolean {
  return transform.dx === 0 && transform.dy === 0 && transform.scale === 1 && transform.rotate === 0;
}

export function layerCompositeTransform(
  layer: ImageEditorLayer | null | undefined,
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
  return transform && !isIdentityTransform(transform) ? transform : null;
}
