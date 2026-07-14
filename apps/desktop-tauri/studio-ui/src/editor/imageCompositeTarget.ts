import type { ViewportTarget } from "../bridge/viewport";
import type { ImageEditorDocument } from "../contracts/imageEditorDocument";

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
