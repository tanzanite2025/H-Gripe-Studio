// Studio Action runtime: action registry stages (dry_run -> preview -> commit
// -> undo), and the first
// non-agent actions. Every commit must land as an ordinary undo step and
// must refuse to touch anything but its resolved target.

import { describe, expect, it } from "vitest";
import {
  builtinStudioActions,
  type ActionContext,
} from "./studioAction";
import { addLayerMask, initEditState, undo, type EditState } from "./imageEditorState";
import { resolveActiveTarget, type StudioDocumentRef, type StudioTarget } from "./studioTarget";
import { activeTargetKind } from "../contracts/imageEditorDocument";

const ref: StudioDocumentRef = { canvasId: "canvas-1", documentId: "node-1/edit_paths" };

const pixelCtx = (state: EditState): ActionContext => ({
  state,
  target: { kind: "pixel_layer", ...ref, layerId: state.current.layers[0].id },
});

const maskCtx = (state: EditState): ActionContext => {
  const layer = state.current.layers[state.current.active];
  return {
    state,
    target: { kind: "layer_mask", ...ref, layerId: layer.id, maskId: layer.mask!.id },
  };
};

describe("studio action registry stages", () => {
  it("refuses a target kind the action does not accept", () => {
    const registry = builtinStudioActions();
    const state = initEditState();
    const plan = registry.dryRun("feather_layer_mask", pixelCtx(state), { radiusPx: 2 });
    expect(plan.ok).toBe(false);
    expect(plan.summary).toMatch(/target kind pixel_layer not accepted/);
    const result = registry.commit("feather_layer_mask", pixelCtx(state), { radiusPx: 2 });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
  });

  it("commit refuses when its own dry run fails", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const result = registry.commit("feather_layer_mask", maskCtx(state), { radiusPx: 0 });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
  });

  it("unknown actions fail closed", () => {
    const registry = builtinStudioActions();
    const plan = registry.dryRun("nuke_document", pixelCtx(initEditState()));
    expect(plan.ok).toBe(false);
    expect(plan.summary).toMatch(/unknown action/);
  });
});

describe("create_layer_mask", () => {
  it("dry-runs, previews without mutating, commits undoably", () => {
    const registry = builtinStudioActions();
    const state = initEditState();
    const ctx = pixelCtx(state);

    const plan = registry.dryRun("create_layer_mask", ctx);
    expect(plan.ok).toBe(true);
    expect(plan.creates).toBe("layer_mask");
    expect(plan.target).toMatch(/^pixel_layer\(/);

    const preview = registry.preview("create_layer_mask", ctx);
    expect(preview.doc.layers[0].mask).toBeDefined();
    expect(state.current.layers[0].mask).toBeUndefined(); // preview did not commit

    const result = registry.commit("create_layer_mask", ctx);
    expect(result.ok).toBe(true);
    expect(result.state.current.layers[0].mask).toBeDefined();
    expect(result.state.current.layers).toHaveLength(1); // never a new layer
    expect(undo(result.state).current.layers[0].mask).toBeUndefined();
  });

  it("refuses when the layer already owns a mask", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const plan = registry.dryRun("create_layer_mask", pixelCtx(state));
    expect(plan.ok).toBe(false);
    expect(plan.summary).toMatch(/already owns/);
  });
});

describe("commit_selection_to_layer_mask", () => {
  it("records the selection region onto the targeted mask stack", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const result = registry.commit("commit_selection_to_layer_mask", maskCtx(state), {
      selection: { id: "sel-1", source: "marquee", bounds: [10, 10, 60, 40] },
    });
    expect(result.ok).toBe(true);
    const layer = result.state.current.layers[0];
    expect(layer.mask!.ops).toEqual([{ type: "rect", region: [10, 10, 60, 40] }]);
    expect(layer.ops).toHaveLength(0); // pixel stack untouched
  });

  it("refuses a stale mask id", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const layer = state.current.layers[0];
    const stale: StudioTarget = { kind: "layer_mask", ...ref, layerId: layer.id, maskId: "mask-gone" };
    const plan = registry.dryRun("commit_selection_to_layer_mask", { state, target: stale }, {
      selection: { id: "sel-1", source: "marquee", bounds: [0, 0, 1, 1] },
    });
    expect(plan.ok).toBe(false);
    expect(plan.summary).toMatch(/mask target not found/);
  });
});

describe("record_point_selection", () => {
  it("needs at least one positive point", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const plan = registry.dryRun("record_point_selection", maskCtx(state), {
      points: [{ x: 1, y: 1, label: 0 }],
    });
    expect(plan.ok).toBe(false);
    expect(plan.summary).toMatch(/positive point/);
  });

  it("records the prompts undoably without a backend capability", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const params = { points: [{ x: 5, y: 6, label: 1 as const }] };

    const plan = registry.dryRun("record_point_selection", maskCtx(state), params);
    expect(plan.ok).toBe(true);
    expect(plan.capability).toBeUndefined();
    expect(plan.costClass).toBe("free");

    const result = registry.commit("record_point_selection", maskCtx(state), params);
    expect(result.ok).toBe(true);
    expect(result.state.current.points).toEqual([{ x: 5, y: 6, label: 1 }]);
    expect(activeTargetKind(result.state.current)).toBe("mask");
    expect(undo(result.state).current.points).toEqual([]);
  });
});

describe("feather_layer_mask", () => {
  it("appends a feather op to the mask stack, undoably", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const result = registry.commit("feather_layer_mask", maskCtx(state), { radiusPx: 3 });
    expect(result.ok).toBe(true);
    expect(result.state.current.layers[0].mask!.ops).toEqual([{ type: "feather", amount: 3 }]);
    expect(undo(result.state).current.layers[0].mask!.ops).toEqual([]);
  });

  it("chains with the resolver: the resolved active target is the mask", () => {
    const registry = builtinStudioActions();
    const state = addLayerMask(initEditState(), 0);
    const target = resolveActiveTarget(state.current, ref);
    expect(target.kind).toBe("layer_mask");
    const result = registry.commit("feather_layer_mask", { state, target }, { radiusPx: 2 });
    expect(result.ok).toBe(true);
  });
});
