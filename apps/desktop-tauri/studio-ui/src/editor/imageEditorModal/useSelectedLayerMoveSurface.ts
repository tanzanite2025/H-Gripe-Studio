import { useEffect, useMemo, useState } from "react";
import type { ViewportPixels } from "../../bridge/viewport";
import type { ImageEditorDocument } from "../../contracts/imageEditorDocument";
import { readSelectionAssistPixels } from "../selectionAssistRead";
import type { SceneFrame } from "./sceneFrame";

interface UseSelectedLayerMoveSurfaceArgs {
  queueEnabled: boolean;
  workspace: "image" | "mask";
  imagePath: string | null | undefined;
  document: ImageEditorDocument;
  selectedLayerId: string | null;
  documentWidth: number;
  documentHeight: number;
  sceneFrame: SceneFrame;
}

export interface SelectedLayerMoveSurface {
  pixels: ViewportPixels;
  key: string;
}

function surfaceKey(
  selectedLayerId: string | null,
  documentKey: string,
  documentWidth: number,
  documentHeight: number,
  frame: SceneFrame,
): string {
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

export function useSelectedLayerMoveSurface({
  queueEnabled,
  workspace,
  imagePath,
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
  sceneFrame,
}: UseSelectedLayerMoveSurfaceArgs): SelectedLayerMoveSurface | null {
  const documentKey = useMemo(() => JSON.stringify(document), [document]);
  const key = useMemo(
    () => surfaceKey(selectedLayerId, documentKey, documentWidth, documentHeight, sceneFrame),
    [selectedLayerId, documentKey, documentWidth, documentHeight, sceneFrame.x, sceneFrame.y, sceneFrame.w, sceneFrame.h],
  );
  const [surface, setSurface] = useState<SelectedLayerMoveSurface | null>(null);

  useEffect(() => {
    if (
      workspace !== "image" ||
      !imagePath ||
      !selectedLayerId ||
      documentWidth <= 1 ||
      documentHeight <= 1 ||
      sceneFrame.w <= 1 ||
      sceneFrame.h <= 1
    ) {
      setSurface(null);
      return;
    }
    if (!queueEnabled) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void readSelectionAssistPixels({
        imagePath,
        document,
        selectedLayerId,
        documentWidth,
        documentHeight,
        frameX: sceneFrame.x,
        frameY: sceneFrame.y,
        frameWidth: sceneFrame.w,
        frameHeight: sceneFrame.h,
      }).then(
        (pixels) => {
          if (!cancelled) setSurface({ key, pixels });
        },
        () => {
          if (!cancelled) setSurface(null);
        },
      );
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    queueEnabled,
    workspace,
    imagePath,
    document,
    selectedLayerId,
    documentWidth,
    documentHeight,
    sceneFrame.x,
    sceneFrame.y,
    sceneFrame.w,
    sceneFrame.h,
    key,
  ]);

  return surface?.key === key ? surface : null;
}
