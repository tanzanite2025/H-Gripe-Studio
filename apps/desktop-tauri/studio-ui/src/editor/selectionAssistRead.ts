import { tauriInvoke } from "../bridge/core";
import { decodePixelsPayload, type ViewportPixels } from "../bridge/viewport";
import type { ImageEditorDocument } from "../contracts/imageEditorDocument";

export interface SelectionAssistReadRequest {
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

function finitePositiveInt(value: number, fallback: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : fallback));
}

export async function readSelectionAssistPixels({
  imagePath,
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
  frameX,
  frameY,
  frameWidth,
  frameHeight,
}: SelectionAssistReadRequest): Promise<ViewportPixels> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("selection assist read requires the Rust/Tauri backend");
  }
  if (!imagePath) {
    throw new Error("selection assist read requires an image path");
  }
  if (!selectedLayerId) {
    throw new Error("selection assist read requires an active pixel layer");
  }
  const payload = (await invoke("read_selection_assist_pixels", {
    imagePath,
    document,
    selectedLayerId,
    documentWidth: finitePositiveInt(documentWidth, 1),
    documentHeight: finitePositiveInt(documentHeight, 1),
    frameX: Number.isFinite(frameX) ? frameX : 0,
    frameY: Number.isFinite(frameY) ? frameY : 0,
    frameWidth: finitePositiveInt(frameWidth, 1),
    frameHeight: finitePositiveInt(frameHeight, 1),
  })) as ArrayBuffer | Uint8Array;
  return decodePixelsPayload(payload);
}
