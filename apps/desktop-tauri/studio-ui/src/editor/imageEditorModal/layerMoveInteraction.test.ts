import { describe, expect, it, vi } from "vitest";
import { beginSelectedLayerMove, commitSelectedLayerMove, updateSelectedLayerMove } from "./layerMoveInteraction";
import { createPointerGestures } from "./pointerMachine";
import { transformDown } from "./pointer/transform";
import { IMAGE_EDITOR_TOOLS } from "../imageEditorTools";
import type { PointerEnv, Pt } from "./pointer/types";

const moveTool = IMAGE_EDITOR_TOOLS.find((tool) => tool.id === "move")!;

function envWith(
  setMoveDraft = vi.fn(),
  completeMoveDraft = vi.fn(),
  beginMovePreview = vi.fn(),
): PointerEnv {
  return {
    tool: moveTool,
    toolId: "move",
    workspace: "image",
    spacePan: false,
    dims: { w: 100, h: 100 },
    doc: { version: 3, layers: [], active: 0, matte_strokes: [], points: [], layerGroups: [] },
    activeLayerKind: "image",
    activeSelection: null,
    editingPath: null,
    anchorDraft: null,
    penAnchors: [],
    cropDraft: null,
    paintTarget: "layer",
    tolerance: 0,
    brushSize: 1,
    brushHardness: 1,
    brushFlow: 1,
    brushSpacing: 1,
    magnetic: { width: 1, contrast: 1, frequency: 1 },
    pathMode: "add",
    shapeKind: "polygon",
    shapeSides: 4,
    cropLock: false,
    toImage: () => [0, 0],
    canStartSelectedLayerMove: () => true,
    resolveSelectedLayerMoveDelta: (delta) => delta,
    beginMovePreview,
    viewBase: () => [100, 100],
    pointerAngle: () => 0,
    viewRotate: () => 0,
    setView: vi.fn(),
    dispatch: vi.fn(),
    commitPath: vi.fn(),
    closePenPath: vi.fn(),
    setPenAnchors: vi.fn(),
    setAnchorDraft: vi.fn(),
    startPathEdit: vi.fn(),
    setCropDraft: vi.fn(),
    setCropAspect: vi.fn(),
    confirmCropDraft: vi.fn(),
    setActiveSelection: vi.fn(),
    setSelectionDraft: vi.fn(),
    setMoveDraft,
    completeMoveDraft,
    setColorSamples: vi.fn(),
    sampleUnderlay: vi.fn(),
    captureEdgeMap: vi.fn(),
    selectOptionsTab: vi.fn(),
    nextId: (prefix: string) => `${prefix}-1`,
    redraw: vi.fn(),
    forceRedraw: vi.fn(),
  };
}

describe("layerMoveInteraction", () => {
  it("begins one preview transaction without publishing a zero delta", () => {
    const setMoveDraft = vi.fn();
    const beginMovePreview = vi.fn();
    const g = createPointerGestures();

    beginSelectedLayerMove(envWith(setMoveDraft, vi.fn(), beginMovePreview), g, [10, 10]);

    expect(g.moveDrag).toEqual({ start: [10, 10], end: [10, 10] });
    expect(beginMovePreview).toHaveBeenCalledOnce();
    expect(setMoveDraft).not.toHaveBeenCalled();
  });

  it("publishes a draft only after the move reaches a visible pixel delta", () => {
    const setMoveDraft = vi.fn();
    const g = createPointerGestures();
    const env = envWith(setMoveDraft);
    beginSelectedLayerMove(env, g, [10, 10]);

    updateSelectedLayerMove({ ...env, toImage: () => [10, 10] as Pt }, g, {} as React.PointerEvent);
    expect(setMoveDraft).toHaveBeenLastCalledWith(null);

    updateSelectedLayerMove({ ...env, toImage: () => [12, 9] as Pt }, g, {} as React.PointerEvent);
    expect(setMoveDraft).toHaveBeenLastCalledWith([2, -1]);
  });

  it("clears the draft after a click without committing a transform", () => {
    const setMoveDraft = vi.fn();
    const completeMoveDraft = vi.fn();
    const dispatch = vi.fn();
    const g = createPointerGestures();
    const env = { ...envWith(setMoveDraft, completeMoveDraft), dispatch };
    beginSelectedLayerMove(env, g, [10, 10]);

    expect(commitSelectedLayerMove(env, g)).toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(setMoveDraft).not.toHaveBeenCalled();
    expect(completeMoveDraft).toHaveBeenCalledWith(null);
  });

  it("commits the synchronous gesture delta and finishes the preview transaction", () => {
    const completeMoveDraft = vi.fn();
    const dispatch = vi.fn();
    const g = createPointerGestures();
    const env = { ...envWith(vi.fn(), completeMoveDraft), dispatch };
    beginSelectedLayerMove(env, g, [10, 10]);
    g.moveDrag!.end = [19, 14];

    expect(commitSelectedLayerMove(env, g)).toBe(true);

    expect(dispatch).toHaveBeenCalledWith({ type: "op", op: { type: "transform", dx: 9, dy: 4 } });
    expect(completeMoveDraft).toHaveBeenCalledWith([9, 4]);
  });

  it("uses the same clamped delta for preview and commit", () => {
    const setMoveDraft = vi.fn();
    const dispatch = vi.fn();
    const g = createPointerGestures();
    const env = {
      ...envWith(setMoveDraft),
      dispatch,
      resolveSelectedLayerMoveDelta: vi.fn(() => [3, -2] as Pt),
      toImage: () => [30, 40] as Pt,
    };
    beginSelectedLayerMove(env, g, [10, 10]);

    updateSelectedLayerMove(env, g, {} as React.PointerEvent);
    commitSelectedLayerMove(env, g);

    expect(setMoveDraft).toHaveBeenLastCalledWith([3, -2]);
    expect(dispatch).toHaveBeenCalledWith({ type: "op", op: { type: "transform", dx: 3, dy: -2 } });
  });

  it("does not begin an image-layer move from a blank hit", () => {
    const g = createPointerGestures();
    const env = { ...envWith(), canStartSelectedLayerMove: () => false };

    transformDown(env, g, [200, 200]);

    expect(g.moveDrag).toBeNull();
  });
});
