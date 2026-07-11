import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  commitSelectionDraft,
  type ActiveSelection,
  type SelectionDraft,
} from "./selection";

export interface SelectionController {
  activeSelection: ActiveSelection | null;
  activeSelectionRef: MutableRefObject<ActiveSelection | null>;
  setActiveSelection: Dispatch<SetStateAction<ActiveSelection | null>>;
  selectionDraft: SelectionDraft | null;
  setSelectionDraft: Dispatch<SetStateAction<SelectionDraft | null>>;
  commitDraft: (draft?: SelectionDraft | null) => boolean;
  cancelDraft: () => boolean;
  clearActiveSelection: () => boolean;
  clearAll: () => void;
}

export function useSelectionController(): SelectionController {
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);
  const activeSelectionRef = useRef(activeSelection);
  activeSelectionRef.current = activeSelection;
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);

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

  return {
    activeSelection,
    activeSelectionRef,
    setActiveSelection,
    selectionDraft,
    setSelectionDraft,
    commitDraft,
    cancelDraft,
    clearActiveSelection,
    clearAll,
  };
}
