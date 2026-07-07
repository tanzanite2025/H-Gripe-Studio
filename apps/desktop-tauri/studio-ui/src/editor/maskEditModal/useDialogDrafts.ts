// Dialog draft state: the free-transform panel (Ctrl+T), the fill dialog
// (Shift+F5) and the Image Size dialog (Ctrl+Alt+I) — three "draft +
// open / apply / close" clusters the modal shell surfaces.
import { useCallback, useRef, useState } from "react";
import { activeOps, type EditState, type TransformParams } from "../maskEdit";
import { isBrushOp, isPathOp, type EditOp, type ImageResample } from "../../types/production";
import type { FillDraft, MaskEditDispatch } from "./actions";

/** Image Size dialog draft: pixel size + linked aspect + resample filter. */
export interface ImageSizeDraft {
  w: number;
  h: number;
  linked: boolean;
  resample: ImageResample;
}

export interface DialogDrafts {
  /** Free-transform panel (M5, Ctrl+T): a numeric draft of move / scale /
   * rotate. `editingTransform` points at the history step being revised
   * (null ⇒ Apply appends a new `transform` op). */
  transformDraft: TransformParams | null;
  setTransformDraft: React.Dispatch<React.SetStateAction<TransformParams | null>>;
  editingTransform: number | null;
  closeTransformPanel: () => void;
  /** Ctrl+T: re-open the last transform step for revision when one exists;
   * otherwise start a fresh identity draft (PS free transform). */
  openFreeTransform: () => void;
  /** Open the transform draft panel pointed at history step `index`. */
  editTransformStep: (index: number, op: EditOp) => void;
  /** Fill dialog (M11, Shift+F5): a draft of mode + opacity; Apply records a
   * revisable `fill` op. */
  fillDraft: FillDraft | null;
  setFillDraft: React.Dispatch<React.SetStateAction<FillDraft | null>>;
  openFillDialog: () => void;
  /** Image Size dialog (PS Ctrl+Alt+I): a draft of the output pixel size;
   * 确定 records it on the document as an undoable step. */
  imageSizeDraft: ImageSizeDraft | null;
  setImageSizeDraft: React.Dispatch<React.SetStateAction<ImageSizeDraft | null>>;
  openImageSize: () => void;
  applyImageSize: () => void;
  /** Escape: close the topmost open draft; false when none is open. */
  cancelDialog: () => boolean;
}

export function useDialogDrafts(
  dims: { w: number; h: number },
  dispatch: MaskEditDispatch,
  stateRef: React.MutableRefObject<EditState>,
): DialogDrafts {
  const [transformDraft, setTransformDraft] = useState<TransformParams | null>(null);
  const [editingTransform, setEditingTransform] = useState<number | null>(null);
  const [fillDraft, setFillDraft] = useState<FillDraft | null>(null);
  const [imageSizeDraft, setImageSizeDraft] = useState<ImageSizeDraft | null>(null);
  // Shortcut handlers read the open drafts through refs, so the handler map
  // does not have to re-bind on every draft keystroke.
  const transformDraftRef = useRef<TransformParams | null>(null);
  transformDraftRef.current = transformDraft;
  const fillDraftRef = useRef<FillDraft | null>(null);
  fillDraftRef.current = fillDraft;
  const imageSizeDraftRef = useRef<ImageSizeDraft | null>(null);
  imageSizeDraftRef.current = imageSizeDraft;

  const closeTransformPanel = useCallback(() => {
    setTransformDraft(null);
    setEditingTransform(null);
  }, []);

  const editTransformStep = (index: number, op: EditOp) => {
    if (isPathOp(op) || isBrushOp(op) || op.type !== "transform") return;
    setEditingTransform(index);
    setTransformDraft({ dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 });
  };

  const openFreeTransform = () => {
    const ops = activeOps(stateRef.current.current);
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (!isPathOp(op) && !isBrushOp(op) && op.type === "transform") {
        setEditingTransform(i);
        setTransformDraft({ dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 });
        return;
      }
    }
    setEditingTransform(null);
    setTransformDraft({ dx: 0, dy: 0, scale: 1, rotate: 0 });
  };

  const openFillDialog = () => setFillDraft({ mode: "add", opacity: 100 });

  const openImageSize = () => {
    const canvas = stateRef.current.current.canvas;
    setImageSizeDraft({ w: canvas?.w ?? dims.w, h: canvas?.h ?? dims.h, linked: true, resample: canvas?.resample ?? "auto" });
  };

  const applyImageSize = () => {
    const draft = imageSizeDraftRef.current;
    if (!draft) return;
    dispatch({ type: "canvas_size", canvas: { w: draft.w, h: draft.h, resample: draft.resample } });
    setImageSizeDraft(null);
  };

  const cancelDialog = useCallback((): boolean => {
    if (transformDraftRef.current) {
      closeTransformPanel();
      return true;
    }
    if (fillDraftRef.current) {
      setFillDraft(null);
      return true;
    }
    if (imageSizeDraftRef.current) {
      setImageSizeDraft(null);
      return true;
    }
    return false;
  }, [closeTransformPanel]);

  return {
    transformDraft,
    setTransformDraft,
    editingTransform,
    closeTransformPanel,
    openFreeTransform,
    editTransformStep,
    fillDraft,
    setFillDraft,
    openFillDialog,
    imageSizeDraft,
    setImageSizeDraft,
    openImageSize,
    applyImageSize,
    cancelDialog,
  };
}
