import { useLayoutEffect, useRef, useState } from "react";
import type { SelectedLayerMoveSurface } from "./selectedLayerMoveTypes";

interface UseSelectedLayerMovePresentationArgs {
  layerMoveActive: boolean;
  moveDraft: readonly [number, number] | null;
  selectedLayerMoveSurface: SelectedLayerMoveSurface | null;
  viewportTargetSettled: boolean;
}

export interface SelectedLayerMovePresentation {
  displayedLayerMoveDraft: readonly [number, number] | null;
  selectedLayerMoveSurfaceActive: boolean;
  suppressPixelLayer: boolean;
}

export function useSelectedLayerMovePresentation({
  layerMoveActive,
  moveDraft,
  selectedLayerMoveSurface,
  viewportTargetSettled,
}: UseSelectedLayerMovePresentationArgs): SelectedLayerMovePresentation {
  const [committedMoveSurfaceDraft, setCommittedMoveSurfaceDraft] = useState<readonly [number, number] | null>(null);
  const lastLiveMoveDraftRef = useRef<readonly [number, number] | null>(null);
  const committedMoveSawUnsettledRef = useRef(false);

  useLayoutEffect(() => {
    if (!layerMoveActive || !moveDraft) return;
    lastLiveMoveDraftRef.current = moveDraft;
    setCommittedMoveSurfaceDraft(null);
    committedMoveSawUnsettledRef.current = false;
  }, [layerMoveActive, moveDraft]);

  useLayoutEffect(() => {
    if (layerMoveActive || moveDraft || !selectedLayerMoveSurface) return;
    const draft = lastLiveMoveDraftRef.current;
    lastLiveMoveDraftRef.current = null;
    if (!draft || (Math.abs(draft[0]) < 0.001 && Math.abs(draft[1]) < 0.001)) return;
    setCommittedMoveSurfaceDraft(draft);
    committedMoveSawUnsettledRef.current = false;
  }, [layerMoveActive, moveDraft, selectedLayerMoveSurface]);

  useLayoutEffect(() => {
    if (!committedMoveSurfaceDraft) {
      committedMoveSawUnsettledRef.current = false;
      return;
    }
    if (!viewportTargetSettled) {
      committedMoveSawUnsettledRef.current = true;
      return;
    }
    if (committedMoveSawUnsettledRef.current) {
      setCommittedMoveSurfaceDraft(null);
      committedMoveSawUnsettledRef.current = false;
    }
  }, [committedMoveSurfaceDraft, viewportTargetSettled]);

  const selectedLayerMoveDraft = layerMoveActive && moveDraft ? moveDraft : committedMoveSurfaceDraft;
  const selectedLayerMoveSurfaceActive = Boolean(selectedLayerMoveSurface && selectedLayerMoveDraft);
  const displayedLayerMoveDraft = selectedLayerMoveSurfaceActive ? selectedLayerMoveDraft : null;

  return {
    displayedLayerMoveDraft,
    selectedLayerMoveSurfaceActive,
    suppressPixelLayer: selectedLayerMoveSurfaceActive,
  };
}
