import { describe, expect, it, vi } from "vitest";
import { beginSelectedLayerMove, commitSelectedLayerMove, updateSelectedLayerMove } from "./layerMoveInteraction";
import { createPointerGestures } from "./pointerMachine";
import { transformDown } from "./pointer/transform";
import { IMAGE_EDITOR_TOOLS } from "../imageEditorTools";
import type { PointerEnv, Pt } from "./pointer/types";

const moveTool = IMAGE_EDITOR_TOOLS.find((tool) => tool.id === "move")!;

function envWith(setMoveDraft = vi.fn()): PointerEnv {
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
  it("does not publish a zero move draft on pointer down", () => {
    const setMoveDraft = vi.fn();
    const g = createPointerGestures();

    beginSelectedLayerMove(envWith(setMoveDraft), g, [10, 10]);

    expect(g.moveDrag).toEqual({ start: [10, 10], end: [10, 10] });
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
    const dispatch = vi.fn();
    const g = createPointerGestures();
    const env = { ...envWith(setMoveDraft), dispatch };
    beginSelectedLayerMove(env, g, [10, 10]);

    expect(commitSelectedLayerMove(env, g)).toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(setMoveDraft).toHaveBeenLastCalledWith(null);
  });

  it("does not begin an image-layer move from a blank hit", () => {
    const g = createPointerGestures();
    const env = { ...envWith(), canStartSelectedLayerMove: () => false };

    transformDown(env, g, [200, 200]);

    expect(g.moveDrag).toBeNull();
  });
});
