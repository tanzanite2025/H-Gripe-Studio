// Layer-mask target contract (MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN):
// masks are attachments on a layer, the document stores the active target
// explicitly, and edits route to the targeted stack.

import { describe, expect, it } from "vitest";
import {
  activeOps,
  addBrushStroke,
  addLayerMask,
  duplicateLayer,
  initEditState,
  normalizeEditPaths,
  removeLayerMask,
  setActiveLayer,
  setActiveTarget,
  toggleLayerMaskDisabled,
  toggleLayerMaskLink,
  layerOpStacks,
  undo,
} from "./maskEdit";
import { fromMaskDocument, toMaskDocument } from "./imageDocument";
import { resolveActiveTarget } from "./studioTarget";
import type { BrushStroke } from "../types/production";
import { activeTargetKind, emptyAdjustmentLayer } from "../types/production";

const stroke = (id: string): BrushStroke => ({
  id,
  mode: "add",
  radius: 12,
  points: [
    [0, 0],
    [4, 4],
  ],
});

describe("layer mask attachments", () => {
  it("addLayerMask attaches a mask and activates the mask target", () => {
    const state = addLayerMask(initEditState(), 0);
    expect(state.current.layers[0].mask).toBeDefined();
    expect(state.current.layers[0].mask!.ops).toEqual([]);
    expect(activeTargetKind(state.current)).toBe("mask");
    // Adding a mask never adds a layer.
    expect(state.current.layers).toHaveLength(1);
  });

  it("addLayerMask is a no-op when a mask exists or the layer cannot own one", () => {
    const withMask = addLayerMask(initEditState(), 0);
    expect(addLayerMask(withMask, 0)).toBe(withMask);
    const adj = initEditState();
    adj.current.layers.push(emptyAdjustmentLayer("levels"));
    expect(addLayerMask(adj, 1)).toBe(adj);
  });

  it("routes new edits to the targeted stack", () => {
    let state = addLayerMask(initEditState(), 0);
    state = addBrushStroke(state, stroke("on-mask"));
    expect(state.current.layers[0].mask!.ops).toHaveLength(1);
    expect(state.current.layers[0].ops).toHaveLength(0);

    state = setActiveTarget(state, "pixel");
    state = addBrushStroke(state, stroke("on-pixels"));
    expect(state.current.layers[0].ops).toHaveLength(1);
    expect(state.current.layers[0].mask!.ops).toHaveLength(1);
  });

  it("activeOps reads the targeted stack (history panel follows the target)", () => {
    let state = addLayerMask(initEditState(), 0);
    state = addBrushStroke(state, stroke("m"));
    expect(activeOps(state.current)).toHaveLength(1);
    state = setActiveTarget(state, "pixel");
    expect(activeOps(state.current)).toHaveLength(0);
  });

  it("switching layers resets the target to pixel content", () => {
    let state = addLayerMask(initEditState(), 0);
    state.current.layers.push(emptyAdjustmentLayer("levels"));
    state = setActiveLayer(state, 1);
    expect(activeTargetKind(state.current)).toBe("pixel");
    expect(state.current.activeTarget).toBeUndefined();
  });

  it("setActiveTarget mask is a no-op without a mask attachment", () => {
    const state = initEditState();
    expect(setActiveTarget(state, "mask")).toBe(state);
  });

  it("removeLayerMask removes only the attachment, undoably", () => {
    let state = addLayerMask(initEditState(), 0);
    state = addBrushStroke(state, stroke("m"));
    state = removeLayerMask(state, 0);
    expect(state.current.layers).toHaveLength(1);
    expect(state.current.layers[0].mask).toBeUndefined();
    expect(activeTargetKind(state.current)).toBe("pixel");
    const undone = undo(state);
    expect(undone.current.layers[0].mask!.ops).toHaveLength(1);
  });

  it("disable keeps the data but drops the mask from replayable stacks", () => {
    let state = addLayerMask(initEditState(), 0);
    state = addBrushStroke(state, stroke("m"));
    expect(layerOpStacks(state.current.layers[0])).toHaveLength(2);
    state = toggleLayerMaskDisabled(state, 0);
    expect(state.current.layers[0].mask!.disabled).toBe(true);
    expect(state.current.layers[0].mask!.ops).toHaveLength(1);
    expect(layerOpStacks(state.current.layers[0])).toHaveLength(1);
  });

  it("toggleLayerMaskLink flips the pixel↔mask link", () => {
    let state = addLayerMask(initEditState(), 0);
    state = toggleLayerMaskLink(state, 0);
    expect(state.current.layers[0].mask!.unlinked).toBe(true);
    state = toggleLayerMaskLink(state, 0);
    expect(state.current.layers[0].mask!.unlinked).toBeUndefined();
  });

  it("duplicateLayer copies the mask with a fresh id", () => {
    let state = addLayerMask(initEditState(), 0);
    state = addBrushStroke(state, stroke("m"));
    state = duplicateLayer(state);
    const [source, copy] = state.current.layers;
    expect(copy.mask!.ops).toEqual(source.mask!.ops);
    expect(copy.mask!.id).not.toBe(source.mask!.id);
  });
});

describe("normalization round-trips the mask contract", () => {
  it("keeps mask attachments and the active target", () => {
    const state = addBrushStroke(addLayerMask(initEditState(), 0), stroke("m"));
    const parsed = normalizeEditPaths(JSON.parse(JSON.stringify(state.current)));
    expect(parsed.layers[0].mask!.ops).toHaveLength(1);
    expect(parsed.activeTarget).toBe("mask");
  });

  it("drops a mask target when the active layer has no mask", () => {
    const doc = normalizeEditPaths({ version: 3, layers: [{ ops: [] }], active: 0, activeTarget: "mask" });
    expect(doc.activeTarget).toBeUndefined();
  });
});

describe("image-document bridge carries the mask contract", () => {
  it("round-trips mask attachments and the active target", () => {
    const state = addBrushStroke(addLayerMask(initEditState(), 0), stroke("m"));
    const bridged = toMaskDocument(fromMaskDocument(state.current));
    expect(bridged).toEqual(state.current);
  });
});

describe("studio target resolver", () => {
  const ref = { canvasId: "canvas-1", documentId: "node-1/edit_paths" };

  it("resolves the layer mask when the mask thumbnail is active", () => {
    const state = addLayerMask(initEditState(), 0);
    const layer = state.current.layers[0];
    expect(resolveActiveTarget(state.current, ref)).toEqual({
      kind: "layer_mask",
      ...ref,
      layerId: layer.id,
      maskId: layer.mask!.id,
    });
  });

  it("resolves the pixel layer otherwise", () => {
    const state = initEditState();
    expect(resolveActiveTarget(state.current, ref)).toEqual({
      kind: "pixel_layer",
      ...ref,
      layerId: state.current.layers[0].id,
    });
  });
});
