import {
  emptyLayerMask,
  emptyPixelLayer,
  type ImageEditorDocument,
  type ImageEditorLayer,
  type LayerMask,
} from "../contracts/imageEditorDocument";
import type { MaterializedLayerViaCopy } from "../contracts/imageEditOps";

/**
 * Build the document produced by the current Ctrl+J transaction.
 *
 * Ordinary duplicate copies the layer's existing explicit source op and
 * placement. Layer Via Copy is a separate materialization transaction.
 */
export function duplicateActiveLayerInDocument(
  document: ImageEditorDocument,
): ImageEditorDocument {
  const index = Math.min(Math.max(document.active, 0), document.layers.length - 1);
  const source = document.layers[index];
  if (!source) return document;
  const copyOps = source.ops.map((op) => ({ ...op }));
  const mask: LayerMask | null = source.mask
    ? { ...source.mask, id: emptyLayerMask().id, ops: source.mask.ops.map((op) => ({ ...op })) }
    : null;
  const copy: ImageEditorLayer = {
    ...source,
    id: emptyPixelLayer().id,
    name: `${source.name} copy`,
    ops: copyOps,
    ...(mask ? { mask } : null),
  };
  const layers = [
    ...document.layers.slice(0, index + 1),
    copy,
    ...document.layers.slice(index + 1),
  ];
  return { ...document, layers, active: index + 1 };
}

function isValidMaterializedCopy(copy: MaterializedLayerViaCopy): boolean {
  const { source, placement } = copy;
  return (
    source.path.trim().length > 0
    && Number.isInteger(source.width)
    && source.width > 0
    && Number.isInteger(source.height)
    && source.height > 0
    && placement.length === 4
    && placement.every(Number.isInteger)
    && placement[2] > placement[0]
    && placement[3] > placement[1]
    && placement[2] - placement[0] === source.width
    && placement[3] - placement[1] === source.height
  );
}

/** Insert a fully materialized compact copy above its source layer. No source
 * operation, mask, transform, or clip from the original layer is replayed. */
export function insertMaterializedLayerViaCopyInDocument(
  document: ImageEditorDocument,
  sourceLayerId: string,
  materialized: MaterializedLayerViaCopy,
): ImageEditorDocument {
  const index = document.layers.findIndex((layer) => layer.id === sourceLayerId);
  const sourceLayer = document.layers[index];
  if (!sourceLayer || sourceLayer.kind !== "pixel" || !isValidMaterializedCopy(materialized)) return document;
  const copy: ImageEditorLayer = {
    ...emptyPixelLayer(`${sourceLayer.name} copy`),
    blend: sourceLayer.blend,
    ops: [{
      type: "source_image",
      source: { ...materialized.source },
      placement: [...materialized.placement],
    }],
  };
  const layers = [
    ...document.layers.slice(0, index + 1),
    copy,
    ...document.layers.slice(index + 1),
  ];
  return { ...document, layers, active: index + 1 };
}
