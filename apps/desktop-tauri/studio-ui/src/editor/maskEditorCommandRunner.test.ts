import { describe, expect, it } from "vitest";
import {
  emptyLayerMask,
  emptyMaskDocument,
  emptyMaskLayer,
  type MaskDocument,
} from "../contracts/maskDocument";
import { runMaskEditorCommand } from "./maskEditorCommandRunner";
import type { MaskEditAction } from "./maskEditModal/actions";
import type { StudioTarget } from "./studioTarget";

function docWithTwoLayers(): MaskDocument {
  const doc = emptyMaskDocument();
  doc.layers[0] = { ...doc.layers[0], id: "layer-base" };
  doc.layers.push({ ...emptyMaskLayer("Layer 1"), id: "layer-1" });
  doc.active = 1;
  return doc;
}

function capture() {
  const actions: MaskEditAction[] = [];
  return {
    actions,
    dispatch: (action: MaskEditAction) => actions.push(action),
  };
}

describe("runMaskEditorCommand", () => {
  it("runs layer commands through one editor command path", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { actions, dispatch } = capture();

    expect(runMaskEditorCommand("layer.addMask", { doc, target, dispatch })).toBe(true);
    expect(runMaskEditorCommand("layer.duplicate", { doc, target, dispatch })).toBe(true);

    expect(actions).toEqual([
      { type: "layer_mask_add", index: 1 },
      { type: "layer_duplicate" },
    ]);
  });

  it("deletes a mask target without deleting the whole layer", () => {
    const doc = docWithTwoLayers();
    doc.layers[1] = { ...doc.layers[1], mask: { ...emptyLayerMask(), id: "mask-1" } };
    const target: StudioTarget = { kind: "layer_mask", canvasId: "canvas", documentId: "doc", layerId: "layer-1", maskId: "mask-1" };
    const { actions, dispatch } = capture();

    expect(runMaskEditorCommand("target.delete", { doc, target, dispatch })).toBe(true);

    expect(actions).toEqual([{ type: "layer_mask_remove", index: 1 }]);
  });

  it("switches to move tool through the injected tool setter", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { dispatch } = capture();
    let toolId = "";

    expect(runMaskEditorCommand("target.transform", { doc, target, dispatch, setToolId: (id) => { toolId = id; } })).toBe(true);

    expect(toolId).toBe("move");
  });
});
