import { tauriInvoke } from "../../../bridge/core";
import { decodePixelsPayload, type ViewportPixels } from "../../../bridge/viewport";
import type { ImageEditorDocument } from "../../../contracts/imageEditorDocument";

export interface SelectedLayerMoveSurfacePixelsRequest {
  imagePath: string | null | undefined;
  document: ImageEditorDocument;
  selectedLayerId: string | null | undefined;
  documentWidth: number;
  documentHeight: number;
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
}

function requireFiniteNumberForSelectedLayerMoveSurfaceRequest(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`selected layer move surface read requires finite ${name}`);
  }
  return value;
}

function requireFinitePositiveIntegerForSelectedLayerMoveSurfaceRequest(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`selected layer move surface read requires finite ${name}`);
  }
  const rounded = Math.round(value);
  if (rounded < 1) {
    throw new Error(`selected layer move surface read requires positive ${name}`);
  }
  return rounded;
}

export async function requestSelectedLayerMoveSurfacePixelsForCurrentViewportFrame({
  imagePath,
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
  frameX,
  frameY,
  frameWidth,
  frameHeight,
}: SelectedLayerMoveSurfacePixelsRequest): Promise<ViewportPixels> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("selected layer move surface read requires the Rust/Tauri backend");
  }
  if (!imagePath) {
    throw new Error("selected layer move surface read requires an image path");
  }
  if (!selectedLayerId) {
    throw new Error("selected layer move surface read requires an active pixel layer");
  }
  const payload = (await invoke("read_selected_layer_move_surface_pixels", {
    imagePath,
    document,
    selectedLayerId,
    documentWidth: requireFinitePositiveIntegerForSelectedLayerMoveSurfaceRequest(documentWidth, "documentWidth"),
    documentHeight: requireFinitePositiveIntegerForSelectedLayerMoveSurfaceRequest(documentHeight, "documentHeight"),
    frameX: requireFiniteNumberForSelectedLayerMoveSurfaceRequest(frameX, "frameX"),
    frameY: requireFiniteNumberForSelectedLayerMoveSurfaceRequest(frameY, "frameY"),
    frameWidth: requireFinitePositiveIntegerForSelectedLayerMoveSurfaceRequest(frameWidth, "frameWidth"),
    frameHeight: requireFinitePositiveIntegerForSelectedLayerMoveSurfaceRequest(frameHeight, "frameHeight"),
  })) as ArrayBuffer | Uint8Array;
  return decodePixelsPayload(payload);
}
