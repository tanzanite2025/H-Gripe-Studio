import type { MaskEditAction } from "./actions";
import { selectionClipFromActive, type ActiveSelection } from "./selection";

// Ops an active selection does NOT confine: whole-mask reshapes keep their
// global meaning even while a selection is up.
export const UNCLIPPED_SELECTION_OPS = new Set(["transform", "crop", "perspective_crop", "select_all"]);

export function applyActiveSelectionClip(
  action: MaskEditAction,
  activeSelection: ActiveSelection | null,
): MaskEditAction {
  if (!activeSelection) return action;
  const clip = selectionClipFromActive(activeSelection);
  if (action.type === "stroke") {
    return { ...action, stroke: { ...action.stroke, clip } };
  }
  if (action.type === "path") {
    return { ...action, path: { ...action.path, clip } };
  }
  if (action.type === "op" && !UNCLIPPED_SELECTION_OPS.has(action.op.type)) {
    return { ...action, op: { ...action.op, clip } };
  }
  return action;
}
