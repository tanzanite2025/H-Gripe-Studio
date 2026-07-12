import { type ImageEditorDocument } from "../contracts/imageEditorDocument";
import type { ImageEditorDispatch } from "./imageEditorModal/actions";
import { resolveSelectionCommand, type SelectionCommandId } from "./imageEditorModal/selectionCommands";
import type { ActiveSelection, SelectionDraft } from "./imageEditorModal/selection";
import type { CommandId } from "./studioCommands";
import type { StudioTarget } from "./studioTarget";

export interface ImageEditorCommandEnv {
  doc: ImageEditorDocument;
  target: StudioTarget;
  dispatch: ImageEditorDispatch;
  beforeStructuralChange?: () => void;
  setToolId?: (toolId: string) => void;
  includeSourceImage?: boolean;
  activeSelection?: ActiveSelection | null;
  selectionDraft?: SelectionDraft | null;
  clearActiveSelection?: () => void;
  clearSelectionDraft?: () => void;
}

function runSelectionCommand(id: SelectionCommandId, env: ImageEditorCommandEnv): boolean {
  const resolution = resolveSelectionCommand(id, {
    workspace: env.includeSourceImage ? "image" : "mask",
    activeSelection: env.activeSelection ?? null,
    selectionDraft: env.selectionDraft ?? null,
  });
  if (!resolution.handled) return false;
  if (resolution.selectToolId) {
    if (!env.setToolId) return false;
    env.setToolId(resolution.selectToolId);
  }
  if (resolution.action) env.dispatch(resolution.action);
  if (resolution.clearActiveSelection) env.clearActiveSelection?.();
  if (resolution.clearSelectionDraft) env.clearSelectionDraft?.();
  return true;
}

export function runImageEditorCommand(id: CommandId, env: ImageEditorCommandEnv): boolean {
  const { doc, target, dispatch, beforeStructuralChange, setToolId } = env;
  const active = doc.active;
  switch (id) {
    case "layer.invert":
    case "mask.invert":
      dispatch({ type: "op", op: { type: "invert" } });
      return true;
    case "layer.link":
      if (target.kind !== "pixel_layer" && target.kind !== "layer_mask") return false;
      dispatch({ type: "layer_link", index: active });
      return true;
    case "layer.addMask":
      beforeStructuralChange?.();
      dispatch({ type: "layer_mask_add", index: active });
      return true;
    case "layer.duplicate":
      return runSelectionCommand("duplicate", env);
    case "layer.add":
      dispatch({ type: "layer_add" });
      return true;
    case "target.delete":
    case "mask.delete":
      beforeStructuralChange?.();
      if (target.kind === "layer_mask" || id === "mask.delete") dispatch({ type: "layer_mask_remove", index: active });
      else dispatch({ type: "layer_remove", index: active });
      return true;
    case "mask.disable":
      dispatch({ type: "layer_mask_disable", index: active });
      return true;
    case "target.transform":
      setToolId?.("move");
      return Boolean(setToolId);
    case "selection.invert":
      return runSelectionCommand("invert", env);
    case "selection.deselect":
      return runSelectionCommand("deselect", env);
    case "selection.feather":
      return runSelectionCommand("feather", env);
    case "selection.subject":
      return false;
  }
}
