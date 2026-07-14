import type { ImageEditorDocument } from "../contracts/imageEditorDocument";
import type { EditClip, MaterializedLayerViaCopy } from "../contracts/imageEditOps";
import { tauriInvoke } from "./core";

export interface MaterializeLayerViaCopyRequest {
  imagePath: string | null | undefined;
  document: ImageEditorDocument;
  selectedLayerId: string;
  documentWidth: number;
  documentHeight: number;
  selection: EditClip;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function decodeMaterializedLayerViaCopy(value: unknown): MaterializedLayerViaCopy | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("materialize_layer_via_copy returned an invalid result");
  }
  const candidate = value as {
    source?: { path?: unknown; width?: unknown; height?: unknown };
    placement?: unknown;
  };
  const source = candidate.source;
  const placement = candidate.placement;
  if (
    !source
    || typeof source.path !== "string"
    || source.path.trim().length === 0
    || !isPositiveInteger(source.width)
    || !isPositiveInteger(source.height)
    || !Array.isArray(placement)
    || placement.length !== 4
    || !placement.every((coordinate) => typeof coordinate === "number" && Number.isInteger(coordinate))
    || placement[2] <= placement[0]
    || placement[3] <= placement[1]
    || placement[2] - placement[0] !== source.width
    || placement[3] - placement[1] !== source.height
  ) {
    throw new Error("materialize_layer_via_copy returned an invalid result");
  }
  return {
    source: {
      path: source.path,
      width: source.width,
      height: source.height,
    },
    placement: [...placement] as [number, number, number, number],
  };
}

export async function materializeLayerViaCopy(
  request: MaterializeLayerViaCopyRequest,
): Promise<MaterializedLayerViaCopy | null> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("Layer Via Copy requires the Rust/Tauri backend");
  if (!request.selectedLayerId.trim()) throw new Error("Layer Via Copy requires an active pixel layer");
  if (!isPositiveInteger(request.documentWidth) || !isPositiveInteger(request.documentHeight)) {
    throw new Error("Layer Via Copy requires valid document dimensions");
  }
  return decodeMaterializedLayerViaCopy(await invoke("materialize_layer_via_copy", {
    imagePath: request.imagePath ?? null,
    document: request.document,
    selectedLayerId: request.selectedLayerId,
    documentWidth: request.documentWidth,
    documentHeight: request.documentHeight,
    selection: request.selection,
  }));
}
