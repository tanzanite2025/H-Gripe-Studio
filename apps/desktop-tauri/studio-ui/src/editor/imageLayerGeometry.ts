import type { ImageEditorLayer } from "../contracts/imageEditorDocument";
import type { ImageCompositeDims } from "./imageCompositeTarget";
import { composeTransforms, type TransformParams } from "./imageLayerTransform";
import { layerAlphaBounds, type AlphaBounds, type LayerAlphaBoundsOptions } from "./maskMorphology";
import { layerSourceImageOp } from "./imageLayerSource";

export function imageLayerContentBounds(
  layer: ImageEditorLayer,
  dims: ImageCompositeDims,
  options: Pick<LayerAlphaBoundsOptions, "proxyWidth" | "alphaThreshold"> = {},
): AlphaBounds | null {
  if (layer.kind === "adjustment" || !layerSourceImageOp(layer)) return null;
  return layerAlphaBounds(layer, dims, { ...options, ignoreTransforms: true });
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
