// Mask-Edit modal state actions: the reducer over `maskEdit.ts`'s pure
// document-editing functions, shared by the modal shell and its panels.

import {
  addAdjustmentLayer,
  addBrushStroke,
  addMatteStroke,
  addOperation,
  addPath,
  addPoint,
  addLayer,
  clearEdits,
  duplicateLayer,
  moveLayer,
  redo,
  renameLayer,
  reselect,
  removeLayer,
  removeOp,
  setActiveLayer,
  setLayerBlend,
  setLayerOpacity,
  toggleLayerLink,
  toggleLayerLock,
  toggleLayerVisible,
  toggleOp,
  undo,
  updateLayerAdjustment,
  updateOpAmount,
  updateOpTransform,
  updatePathAnchors,
  type EditState,
  type TransformParams,
} from "../maskEdit";
import type {
  AdjustmentType,
  BrushStroke,
  EditPath,
  EditPathPoint,
  LayerAdjustment,
  LayerBlend,
  MaskOperation,
  PointPrompt,
} from "../../types/production";

export type MaskEditAction =
  | { type: "stroke"; stroke: BrushStroke }
  | { type: "matte_stroke"; stroke: BrushStroke }
  | { type: "op"; op: MaskOperation }
  | { type: "point"; point: PointPrompt }
  | { type: "path"; path: EditPath }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" }
  | { type: "reselect" }
  | { type: "layer_duplicate" }
  | { type: "remove_op"; index: number }
  | { type: "toggle_op"; index: number }
  | { type: "op_amount"; index: number; amount: number }
  | { type: "op_transform"; index: number; params: TransformParams }
  | { type: "path_anchors"; index: number; points: EditPathPoint[] }
  | { type: "layer_add" }
  | { type: "layer_add_adjustment"; adjType: AdjustmentType }
  | { type: "layer_adjustment"; index: number; adjustment: LayerAdjustment }
  | { type: "layer_remove"; index: number }
  | { type: "layer_rename"; index: number; name: string }
  | { type: "layer_move"; from: number; to: number }
  | { type: "layer_active"; index: number }
  | { type: "layer_visible"; index: number }
  | { type: "layer_lock"; index: number }
  | { type: "layer_link"; index: number }
  | { type: "layer_opacity"; index: number; opacity: number }
  | { type: "layer_blend"; index: number; blend: LayerBlend };

export type MaskEditDispatch = (action: MaskEditAction) => void;

/** Fill-dialog draft (M11, Shift+F5): mode + opacity, applied as a `fill` op. */
export interface FillDraft {
  mode: "add" | "subtract";
  opacity: number;
}

export function maskEditReducer(state: EditState, action: MaskEditAction): EditState {
  switch (action.type) {
    case "stroke":
      return addBrushStroke(state, action.stroke);
    case "matte_stroke":
      return addMatteStroke(state, action.stroke);
    case "op":
      return addOperation(state, action.op);
    case "point":
      return addPoint(state, action.point);
    case "path":
      return addPath(state, action.path);
    case "undo":
      return undo(state);
    case "redo":
      return redo(state);
    case "clear":
      return clearEdits(state);
    case "reselect":
      return reselect(state);
    case "layer_duplicate":
      return duplicateLayer(state);
    case "remove_op":
      return removeOp(state, action.index);
    case "toggle_op":
      return toggleOp(state, action.index);
    case "op_amount":
      return updateOpAmount(state, action.index, action.amount);
    case "op_transform":
      return updateOpTransform(state, action.index, action.params);
    case "path_anchors":
      return updatePathAnchors(state, action.index, action.points);
    case "layer_add":
      return addLayer(state);
    case "layer_add_adjustment":
      return addAdjustmentLayer(state, action.adjType);
    case "layer_adjustment":
      return updateLayerAdjustment(state, action.index, action.adjustment);
    case "layer_remove":
      return removeLayer(state, action.index);
    case "layer_rename":
      return renameLayer(state, action.index, action.name);
    case "layer_move":
      return moveLayer(state, action.from, action.to);
    case "layer_active":
      return setActiveLayer(state, action.index);
    case "layer_visible":
      return toggleLayerVisible(state, action.index);
    case "layer_lock":
      return toggleLayerLock(state, action.index);
    case "layer_link":
      return toggleLayerLink(state, action.index);
    case "layer_opacity":
      return setLayerOpacity(state, action.index, action.opacity);
    case "layer_blend":
      return setLayerBlend(state, action.index, action.blend);
  }
}
