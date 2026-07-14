import type { ImageEditorAction } from "./actions";
import type { ActiveSelection, SelectionDraft } from "./selection";

export type SelectionCommandId =
  | "clear"
  | "cancel"
  | "delete"
  | "invert"
  | "deselect"
  | "feather";

export interface SelectionCommandState {
  activeSelection: ActiveSelection | null;
  selectionDraft: SelectionDraft | null;
}

export interface SelectionCommandResolution {
  handled: boolean;
  action?: ImageEditorAction;
  clearActiveSelection?: boolean;
  clearSelectionDraft?: boolean;
  selectToolId?: string;
}

export function resolveSelectionCommand(
  id: SelectionCommandId,
  state: SelectionCommandState,
): SelectionCommandResolution {
  const { activeSelection, selectionDraft } = state;
  const hasDraft = Boolean(selectionDraft);
  switch (id) {
    case "clear":
      if (selectionDraft) return { handled: true, clearSelectionDraft: true };
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      return { handled: true, action: { type: "clear" } };
    case "cancel":
      if (selectionDraft) return { handled: true, clearSelectionDraft: true };
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      return { handled: false };
    case "delete":
      if (hasDraft) return { handled: true };
      return { handled: true, action: { type: "op", op: { type: "delete" } } };
    case "invert":
      if (hasDraft) return { handled: true };
      return { handled: true, action: { type: "op", op: { type: "invert" } } };
    case "deselect":
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      return { handled: false };
    case "feather":
      if (hasDraft) return { handled: true };
      // Feather routes to the feather tool's radius/preview flow; the tool
      // applies the op as a revisable step, clipped by the active selection.
      return { handled: true, selectToolId: "feather" };
  }
}
