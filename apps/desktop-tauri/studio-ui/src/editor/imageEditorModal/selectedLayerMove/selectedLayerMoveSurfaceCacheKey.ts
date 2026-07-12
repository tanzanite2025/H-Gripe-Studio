import type { SceneFrame } from "../sceneFrame";

export function createSelectedLayerMoveSurfaceKeyFromDocumentLayerAndViewportFrame({
  selectedLayerId,
  documentKey,
  documentWidth,
  documentHeight,
  frame,
}: {
  selectedLayerId: string | null;
  documentKey: string;
  documentWidth: number;
  documentHeight: number;
  frame: SceneFrame;
}): string {
  return [
    selectedLayerId ?? "",
    documentKey,
    Math.round(documentWidth),
    Math.round(documentHeight),
    Math.round(frame.x),
    Math.round(frame.y),
    Math.round(frame.w),
    Math.round(frame.h),
  ].join(":");
}
