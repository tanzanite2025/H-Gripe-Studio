import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { materializeLayerViaCopy, type MaterializeLayerViaCopyRequest } from "../../bridge/imageLayerCopy";
import { activeTargetKind } from "../../contracts/imageEditorDocument";
import type { EditState } from "../imageEditorState";
import type { ImageEditorDispatch } from "./actions";
import { selectionClipFromActive, type ActiveSelection, type SelectionDraft } from "./selection";

interface Dimensions {
  w: number;
  h: number;
}

interface UseLayerDuplicateCommandArgs {
  imagePath?: string | null;
  dimensions: Dimensions;
  stateRef: MutableRefObject<EditState>;
  activeSelectionRef: MutableRefObject<ActiveSelection | null>;
  setActiveSelection: Dispatch<SetStateAction<ActiveSelection | null>>;
  selectionDraft: SelectionDraft | null;
  dispatch: ImageEditorDispatch;
  beforeStructuralChange?: () => void;
  materialize?: (request: MaterializeLayerViaCopyRequest) => ReturnType<typeof materializeLayerViaCopy>;
}

export interface LayerDuplicateCommandController {
  runLayerDuplicate: () => void;
  layerDuplicatePending: boolean;
}

/** One command path for ordinary duplicate and Rust-materialized Layer Via
 * Copy. No document mutation occurs while materialization is pending. */
export function useLayerDuplicateCommand({
  imagePath,
  dimensions,
  stateRef,
  activeSelectionRef,
  setActiveSelection,
  selectionDraft,
  dispatch,
  beforeStructuralChange,
  materialize = materializeLayerViaCopy,
}: UseLayerDuplicateCommandArgs): LayerDuplicateCommandController {
  const pendingTokenRef = useRef<object | null>(null);
  const [layerDuplicatePending, setLayerDuplicatePending] = useState(false);

  useEffect(() => () => {
    pendingTokenRef.current = null;
  }, []);

  const runLayerDuplicate = useCallback(() => {
    if (selectionDraft || pendingTokenRef.current) return;
    beforeStructuralChange?.();

    const baseDocument = stateRef.current.current;
    const sourceLayer = baseDocument.layers[baseDocument.active];
    if (!sourceLayer || sourceLayer.locked) return;

    const selection = activeSelectionRef.current;
    if (!selection) {
      dispatch({ type: "layer_duplicate" });
      return;
    }
    if (sourceLayer.kind !== "pixel" || activeTargetKind(baseDocument) !== "pixel") return;

    const token = {};
    pendingTokenRef.current = token;
    setLayerDuplicatePending(true);
    void materialize({
      imagePath,
      document: baseDocument,
      selectedLayerId: sourceLayer.id,
      documentWidth: dimensions.w,
      documentHeight: dimensions.h,
      selection: selectionClipFromActive(selection),
    }).then(
      (materialized) => {
        if (
          pendingTokenRef.current !== token
          || !materialized
          || stateRef.current.current !== baseDocument
          || activeSelectionRef.current !== selection
        ) {
          return;
        }
        dispatch({
          type: "layer_via_copy_commit",
          baseDocument,
          sourceLayerId: sourceLayer.id,
          materialized,
        });
        setActiveSelection((current) => (current === selection ? null : current));
      },
      (error) => {
        if (pendingTokenRef.current === token) console.warn("Layer Via Copy failed", error);
      },
    ).finally(() => {
      if (pendingTokenRef.current !== token) return;
      pendingTokenRef.current = null;
      setLayerDuplicatePending(false);
    });
  }, [
    activeSelectionRef,
    beforeStructuralChange,
    dimensions.h,
    dimensions.w,
    dispatch,
    imagePath,
    materialize,
    selectionDraft,
    setActiveSelection,
    stateRef,
  ]);

  return { runLayerDuplicate, layerDuplicatePending };
}
