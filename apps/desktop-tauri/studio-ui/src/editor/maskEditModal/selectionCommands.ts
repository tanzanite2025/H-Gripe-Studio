import type { MaskEditAction } from "./actions";
import type { ActiveSelection, SelectionDraft } from "./selection";

export type SelectionCommandId =
  | "clear"
  | "cancel"
  | "delete"
  | "duplicate"
  | "invert"
  | "deselect"
  | "feather";

export interface SelectionCommandState {
  workspace: "image" | "mask";
  activeSelection: ActiveSelection | null;
  selectionDraft: SelectionDraft | null;
}

export interface SelectionCommandResolution {
  handled: boolean;
  action?: MaskEditAction;
  clearActiveSelection?: boolean;
  clearSelectionDraft?: boolean;
  selectToolId?: string;
}

export function resolveSelectionCommand(
  id: SelectionCommandId,
  state: SelectionCommandState,
): SelectionCommandResolution {
  const { workspace, activeSelection, selectionDraft } = state;
  switch (id) {
    case "clear":
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      if (selectionDraft) return { handled: true, clearSelectionDraft: true };
      return { handled: true, action: { type: "clear" } };
    case "cancel":
      if (selectionDraft) return { handled: true, clearSelectionDraft: true };
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      return { handled: false };
    case "delete":
      return { handled: true, action: { type: "op", op: { type: "delete" } } };
    case "duplicate":
      return {
        handled: true,
        action: {
          type: "layer_duplicate",
          ...(activeSelection ? { selection: activeSelection } : null),
          ...(workspace === "image" ? { includeSourceImage: true } : null),
        },
        // Product rule: Layer Via Copy consumes the active marching-ants
        // selection so later edits do not remain accidentally constrained.
        clearActiveSelection: Boolean(activeSelection),
      };
    case "invert":
      return { handled: true, action: { type: "op", op: { type: "invert" } } };
    case "deselect":
      if (activeSelection) return { handled: true, clearActiveSelection: true };
      return { handled: false };
    case "feather":
      // Feather routes to the feather tool's radius/preview flow; the tool
      // applies the op as a revisable step, clipped by the active selection.
      return { handled: true, selectToolId: "feather" };
  }
}
