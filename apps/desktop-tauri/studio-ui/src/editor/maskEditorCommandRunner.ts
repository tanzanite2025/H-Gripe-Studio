import type { MaskDocument } from "../types/production";
import type { MaskEditDispatch } from "./maskEditModal/actions";
import type { CommandId } from "./studioCommands";
import type { StudioTarget } from "./studioTarget";

export interface MaskEditorCommandEnv {
  doc: MaskDocument;
  target: StudioTarget;
  dispatch: MaskEditDispatch;
  beforeStructuralChange?: () => void;
  setToolId?: (toolId: string) => void;
  includeSourceImage?: boolean;
}

export function runMaskEditorCommand(id: CommandId, env: MaskEditorCommandEnv): boolean {
  const { doc, target, dispatch, beforeStructuralChange, setToolId, includeSourceImage } = env;
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
      dispatch({ type: "layer_duplicate", ...(includeSourceImage ? { includeSourceImage: true } : null) });
      return true;
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
    case "selection.toMask":
    case "selection.invert":
    case "path.makeSelection":
    case "ai.selectSubject":
    case "ai.removeBackground":
      return false;
  }
}
