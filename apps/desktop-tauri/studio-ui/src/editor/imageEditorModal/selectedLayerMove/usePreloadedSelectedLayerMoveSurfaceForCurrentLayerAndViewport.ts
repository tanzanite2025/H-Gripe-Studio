import { useEffect, useMemo, useState } from "react";
import type { ImageEditorDocument } from "../../../contracts/imageEditorDocument";
import type { SceneFrame } from "../sceneFrame";
import { createSelectedLayerMoveSurfaceKeyFromDocumentLayerAndViewportFrame } from "./selectedLayerMoveSurfaceCacheKey";
import { requestSelectedLayerMoveSurfacePixelsForCurrentViewportFrame } from "./selectedLayerMoveSurfaceRequest";
import type { SelectedLayerMoveSurface } from "./selectedLayerMoveTypes";

interface UsePreloadedSelectedLayerMoveSurfaceArgs {
  preloadEnabled: boolean;
  workspace: "image" | "mask";
  imagePath: string | null | undefined;
  document: ImageEditorDocument;
  selectedLayerId: string | null;
  documentWidth: number;
  documentHeight: number;
  sceneFrame: SceneFrame;
}

export function usePreloadedSelectedLayerMoveSurfaceForCurrentLayerAndViewport({
  preloadEnabled,
  workspace,
  imagePath,
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
  sceneFrame,
}: UsePreloadedSelectedLayerMoveSurfaceArgs): SelectedLayerMoveSurface | null {
  const documentKey = useMemo(() => JSON.stringify(document), [document]);
  const key = useMemo(
    () =>
      createSelectedLayerMoveSurfaceKeyFromDocumentLayerAndViewportFrame({
        selectedLayerId,
        documentKey,
        documentWidth,
        documentHeight,
        frame: sceneFrame,
      }),
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
    if (!preloadEnabled) return;

    let cancelled = false;
    void requestSelectedLayerMoveSurfacePixelsForCurrentViewportFrame({
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

    return () => {
      cancelled = true;
    };
  }, [
    preloadEnabled,
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
