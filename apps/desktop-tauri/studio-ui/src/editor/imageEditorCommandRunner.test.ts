import { describe, expect, it, vi } from "vitest";
import {
  emptyLayerMask,
  emptyImageEditorDocument,
  emptyPixelLayer,
  type ImageEditorDocument,
} from "../contracts/imageEditorDocument";
import { runImageEditorCommand } from "./imageEditorCommandRunner";
import type { ImageEditorAction } from "./imageEditorModal/actions";
import type { ActiveSelection } from "./imageEditorModal/selection";
import type { StudioTarget } from "./studioTarget";

function docWithTwoLayers(): ImageEditorDocument {
  const doc = emptyImageEditorDocument();
  doc.layers[0] = { ...doc.layers[0], id: "layer-base" };
  doc.layers.push({ ...emptyPixelLayer("Layer 1"), id: "layer-1" });
  doc.active = 1;
  return doc;
}

function capture() {
  const actions: ImageEditorAction[] = [];
  return {
    actions,
    dispatch: (action: ImageEditorAction) => actions.push(action),
  };
}

describe("runImageEditorCommand", () => {
  it("runs layer commands through one editor command path", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { actions, dispatch } = capture();
    const runLayerDuplicate = vi.fn();

    expect(runImageEditorCommand("layer.addMask", { doc, target, dispatch })).toBe(true);
    expect(runImageEditorCommand("layer.duplicate", { doc, target, dispatch, runLayerDuplicate })).toBe(true);

    expect(actions).toEqual([{ type: "layer_mask_add", index: 1 }]);
    expect(runLayerDuplicate).toHaveBeenCalledOnce();
  });

  it("deletes a mask target without deleting the whole layer", () => {
    const doc = docWithTwoLayers();
    doc.layers[1] = { ...doc.layers[1], mask: { ...emptyLayerMask(), id: "mask-1" } };
    const target: StudioTarget = { kind: "layer_mask", canvasId: "canvas", documentId: "doc", layerId: "layer-1", maskId: "mask-1" };
    const { actions, dispatch } = capture();

    expect(runImageEditorCommand("target.delete", { doc, target, dispatch })).toBe(true);

    expect(actions).toEqual([{ type: "layer_mask_remove", index: 1 }]);
  });

  it("switches to move tool through the injected tool setter", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { dispatch } = capture();
    let toolId = "";

    expect(runImageEditorCommand("target.transform", { doc, target, dispatch, setToolId: (id) => { toolId = id; } })).toBe(true);

    expect(toolId).toBe("move");
  });

  it("delegates layer duplicate to the unified asynchronous controller", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { actions, dispatch } = capture();
    const runLayerDuplicate = vi.fn();

    expect(runImageEditorCommand("layer.duplicate", {
      doc,
      target,
      dispatch,
      runLayerDuplicate,
    })).toBe(true);

    expect(actions).toEqual([]);
    expect(runLayerDuplicate).toHaveBeenCalledOnce();
  });

  it("does not claim duplicate when no duplicate controller is installed", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };
    const { actions, dispatch } = capture();

    expect(runImageEditorCommand("layer.duplicate", { doc, target, dispatch })).toBe(false);

    expect(actions).toEqual([]);
  });

  it("routes selection commands through the shared resolver", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "selection", canvasId: "canvas", documentId: "doc", selectionId: "sel-1" };
    const selection: ActiveSelection = {
      region: [10, 20, 80, 90],
      ellipse: false,
      source: "pen",
      combineMode: "replace",
    };
    const { actions, dispatch } = capture();
    let cleared = false;
    let toolId = "";

    expect(runImageEditorCommand("selection.invert", { doc, target, dispatch, activeSelection: selection })).toBe(true);
    expect(runImageEditorCommand("selection.deselect", {
      doc,
      target,
      dispatch,
      activeSelection: selection,
      clearActiveSelection: () => {
        cleared = true;
      },
    })).toBe(true);
    expect(runImageEditorCommand("selection.feather", { doc, target, dispatch, setToolId: (id) => { toolId = id; } })).toBe(true);

    expect(actions).toEqual([{ type: "op", op: { type: "invert" } }]);
    expect(cleared).toBe(true);
    expect(toolId).toBe("feather");
  });

  it("does not deselect when no active selection exists", () => {
    const doc = docWithTwoLayers();
    const target: StudioTarget = { kind: "selection", canvasId: "canvas", documentId: "doc", selectionId: "sel-1" };
    const { actions, dispatch } = capture();

    expect(runImageEditorCommand("selection.deselect", { doc, target, dispatch })).toBe(false);
    expect(actions).toEqual([]);
  });
});
