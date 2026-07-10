import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  commitSelectionDraft,
  createBoxSelection,
  replaceSelectionBox,
  type ActiveSelection,
  type SelectionBox,
  type SelectionDraft,
  type SelectionGeometry,
} from "./selection";

export interface SelectionController {
  activeSelection: ActiveSelection | null;
  activeSelectionRef: MutableRefObject<ActiveSelection | null>;
  setActiveSelection: Dispatch<SetStateAction<ActiveSelection | null>>;
  selectionDraft: SelectionDraft | null;
  setSelectionDraft: Dispatch<SetStateAction<SelectionDraft | null>>;
  visibleSelection: SelectionGeometry | null;
  commitDraft: (draft?: SelectionDraft | null) => boolean;
  cancelDraft: () => boolean;
  clearActiveSelection: () => boolean;
  clearAll: () => void;
  resizeVisibleSelection: (region: SelectionBox, ellipse?: boolean) => void;
}

export function useSelectionController(): SelectionController {
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);
  const activeSelectionRef = useRef(activeSelection);
  activeSelectionRef.current = activeSelection;
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const visibleSelection = selectionDraft ?? activeSelection;

  const commitDraft = (draft: SelectionDraft | null = selectionDraft): boolean => {
    if (!draft) return false;
    setActiveSelection(commitSelectionDraft(draft));
    setSelectionDraft(null);
    return true;
  };

  const cancelDraft = (): boolean => {
    if (!selectionDraft) return false;
    setSelectionDraft(null);
    return true;
  };

  const clearActiveSelection = (): boolean => {
    if (!activeSelectionRef.current) return false;
    setActiveSelection(null);
    return true;
  };

  const clearAll = () => {
    setActiveSelection(null);
    setSelectionDraft(null);
  };

  const resizeVisibleSelection = (region: SelectionBox, ellipse = visibleSelection?.ellipse ?? false) => {
    if (selectionDraft) {
      setSelectionDraft(replaceSelectionBox(selectionDraft, region, ellipse));
      return;
    }
    if (activeSelection) {
      setActiveSelection(replaceSelectionBox(activeSelection, region, ellipse));
      return;
    }
    setSelectionDraft(createBoxSelection(region, ellipse));
  };

  return {
    activeSelection,
    activeSelectionRef,
    setActiveSelection,
    selectionDraft,
    setSelectionDraft,
    visibleSelection,
    commitDraft,
    cancelDraft,
    clearActiveSelection,
    clearAll,
    resizeVisibleSelection,
  };
}
