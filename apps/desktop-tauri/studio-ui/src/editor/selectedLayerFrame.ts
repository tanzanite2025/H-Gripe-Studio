import type { ImageEditorDocument } from "../contracts/imageEditorDocument";
import { tauriInvoke } from "../bridge/core";
import type { Rect } from "./studioTarget";

export interface SelectedLayerFrame {
  owner: "selected-layer-frame";
  shape: "axis-aligned-rect";
  layerId: string;
  rect: Rect;
  sourceRect: Rect;
  source: "asset-frame";
}

interface ResolveSelectedLayerFrameRequest {
  document: ImageEditorDocument;
  selectedLayerId: string;
  documentWidth: number;
  documentHeight: number;
}

interface SelectedLayerFrameReadinessInput {
  workspace: "image" | "mask";
  selectedLayerId: string | null;
  baseNeedsExplicitSource: boolean;
  documentWidth: number;
  documentHeight: number;
}

export function canResolveSelectedLayerFrame({
  workspace,
  selectedLayerId,
  baseNeedsExplicitSource,
  documentWidth,
  documentHeight,
}: SelectedLayerFrameReadinessInput): boolean {
  return (
    workspace === "image" &&
    Boolean(selectedLayerId) &&
    !baseNeedsExplicitSource &&
    documentWidth > 1 &&
    documentHeight > 1
  );
}

// Bridge only: selected-layer-frame geometry is resolved by Rust. Keep this
// file free of layer-op geometry so DOM, canvas, and WGPU all consume one result.
export async function resolveSelectedLayerFrame({
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
}: ResolveSelectedLayerFrameRequest): Promise<SelectedLayerFrame | null> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("resolve_selected_layer_frame requires the Rust/Tauri backend");
  }
  return (await invoke("resolve_selected_layer_frame", {
    document,
    selectedLayerId,
    documentWidth,
    documentHeight,
  })) as SelectedLayerFrame | null;
}
