import { useLayoutEffect, useRef } from "react";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import type { Rect } from "../studioTarget";

interface SelectedLayerMoveFrameCache {
  layerId: string;
  baseFrame: SelectedLayerFrame;
}

interface UseSelectedLayerMoveFrameCacheArgs {
  selectedLayerId: string | null;
  resolvedFrame: SelectedLayerFrame | null;
  layerMoveActive: boolean;
  displayedLayerMoveDraft: readonly [number, number] | null;
  viewportTargetSettled: boolean;
}

function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
}

export function translateSelectedLayerFrame(
  frame: SelectedLayerFrame,
  draft: readonly [number, number],
): SelectedLayerFrame {
  const [dx, dy] = draft;
  return {
    ...frame,
    rect: translateRect(frame.rect, dx, dy),
  };
}

export function useSelectedLayerMoveFrameCache({
  selectedLayerId,
  resolvedFrame,
  layerMoveActive,
  displayedLayerMoveDraft,
  viewportTargetSettled,
}: UseSelectedLayerMoveFrameCacheArgs): SelectedLayerFrame | null {
  const cacheRef = useRef<SelectedLayerMoveFrameCache | null>(null);

  if (layerMoveActive && selectedLayerId && resolvedFrame && cacheRef.current?.layerId !== selectedLayerId) {
    cacheRef.current = { layerId: selectedLayerId, baseFrame: resolvedFrame };
  }

  useLayoutEffect(() => {
    if (!layerMoveActive || !selectedLayerId || !resolvedFrame) return;
    const current = cacheRef.current;
    if (current?.layerId === selectedLayerId) return;
    cacheRef.current = { layerId: selectedLayerId, baseFrame: resolvedFrame };
  }, [layerMoveActive, selectedLayerId, resolvedFrame]);

  useLayoutEffect(() => {
    if (!selectedLayerId || cacheRef.current?.layerId === selectedLayerId) return;
    cacheRef.current = null;
  }, [selectedLayerId]);

  useLayoutEffect(() => {
    if (layerMoveActive || displayedLayerMoveDraft || !viewportTargetSettled) return;
    cacheRef.current = null;
  }, [layerMoveActive, displayedLayerMoveDraft, viewportTargetSettled]);

  const cache = cacheRef.current;
  if (displayedLayerMoveDraft && cache && cache.layerId === selectedLayerId) {
    return translateSelectedLayerFrame(cache.baseFrame, displayedLayerMoveDraft);
  }
  if (layerMoveActive || displayedLayerMoveDraft) return null;
  return viewportTargetSettled ? resolvedFrame : null;
}
