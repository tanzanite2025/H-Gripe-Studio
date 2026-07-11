// Path editing state: the pending pen anchors awaiting a close-path click
// and the anchor re-edit session on a committed path op (double-click a path
// step to drag its anchors, Enter commits / Escape reverts).
import { useCallback, useRef, useState } from "react";
import { activeOps, type EditState } from "../imageEditorState";
import { isPathOp, type EditPathPoint } from "../../contracts/imageEditOps";
import type { ImageEditorDispatch } from "./actions";

export interface PathEditing {
  /** Pending pen anchors (image-space) awaiting a close-path click. */
  penAnchors: [number, number][];
  setPenAnchors: React.Dispatch<React.SetStateAction<[number, number][]>>;
  /** Index of the active layer's path op being anchor-re-edited. */
  editingPath: number | null;
  /** The re-edit's working copy of the path's anchors. */
  anchorDraft: EditPathPoint[] | null;
  setAnchorDraft: React.Dispatch<React.SetStateAction<EditPathPoint[] | null>>;
  /** Ref mirrors, so pointer/shortcut handlers read the current values
   * without re-binding on every anchor drag. */
  penPendingRef: React.MutableRefObject<boolean>;
  editingPathRef: React.MutableRefObject<number | null>;
  anchorDraftRef: React.MutableRefObject<EditPathPoint[] | null>;
  /** Open an anchor re-edit session on the active ops' path at `index`. */
  startPathEdit: (index: number) => void;
  /** Commit the anchor draft as a revision of the edited path op. */
  commitPathEdit: () => void;
  /** Close the re-edit session, discarding the draft. */
  cancelPathEdit: () => void;
}

export function usePathEditing(
  dispatch: ImageEditorDispatch,
  stateRef: React.MutableRefObject<EditState>,
): PathEditing {
  const [penAnchors, setPenAnchors] = useState<[number, number][]>([]);
  const [editingPath, setEditingPath] = useState<number | null>(null);
  const [anchorDraft, setAnchorDraft] = useState<EditPathPoint[] | null>(null);

  const penPendingRef = useRef(false);
  penPendingRef.current = penAnchors.length > 0;
  const editingPathRef = useRef<number | null>(null);
  editingPathRef.current = editingPath;
  const anchorDraftRef = useRef<EditPathPoint[] | null>(null);
  anchorDraftRef.current = anchorDraft;

  const startPathEdit = useCallback((index: number) => {
    const op = activeOps(stateRef.current.current)[index];
    if (!op || !isPathOp(op)) return;
    setPenAnchors([]);
    setEditingPath(index);
    setAnchorDraft(op.points.map((p) => ({ ...p })));
  }, [stateRef]);

  const commitPathEdit = useCallback(() => {
    if (editingPathRef.current != null && anchorDraftRef.current) {
      dispatch({ type: "path_anchors", index: editingPathRef.current, points: anchorDraftRef.current });
    }
    setEditingPath(null);
    setAnchorDraft(null);
  }, [dispatch]);

  const cancelPathEdit = useCallback(() => {
    setEditingPath(null);
    setAnchorDraft(null);
  }, []);

  return {
    penAnchors,
    setPenAnchors,
    editingPath,
    anchorDraft,
    setAnchorDraft,
    penPendingRef,
    editingPathRef,
    anchorDraftRef,
    startPathEdit,
    commitPathEdit,
    cancelPathEdit,
  };
}
