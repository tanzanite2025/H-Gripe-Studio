import type { ImageEditorDocument, ImageEditorLayer } from "../contracts/imageEditorDocument";
import { isImageEditOperation, type EditOpBase, type ImageEditOperation } from "../contracts/imageEditOps";

export const SOURCE_IMAGE_OP_TYPE = "source_image";

export function hasSourceImageContent(layer: ImageEditorLayer): boolean {
  return layerSourceImageOp(layer) !== null;
}

function hasValidPlacement(placement: readonly number[] | undefined): boolean {
  return Boolean(
    placement
    && placement.length >= 4
    && placement.slice(0, 4).every(Number.isFinite)
    && placement[0] !== placement[2]
    && placement[1] !== placement[3],
  );
}

/** The layer's enabled `source_image` op with explicit document placement. */
export function layerSourceImageOp(layer: ImageEditorLayer): (ImageEditOperation & EditOpBase) | null {
  if (layer.kind === "adjustment") return null;
  for (const op of layer.ops) {
    if (op.type !== SOURCE_IMAGE_OP_TYPE || op.disabled || !isImageEditOperation(op)) continue;
    if (hasValidPlacement(op.placement)) return op;
  }
  return null;
}

export function imageLayerDrawsSource(layer: ImageEditorLayer): boolean {
  return layer.visible !== false && (layer.opacity ?? 1) > 0 && imageLayerHasSourceContent(layer);
}

export function imageLayerHasSourceContent(layer: ImageEditorLayer): boolean {
  return hasSourceImageContent(layer);
}

export function imageCompositeBackingPath(doc: ImageEditorDocument, imagePath?: string | null): string | null {
  if (imagePath) return imagePath;
  for (const layer of doc.layers) {
    const source = layerSourceImageOp(layer)?.source?.path;
    if (source) return source;
  }
  return null;
}
