// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyImageEditorDocument, type ImageEditorDocument } from "../../contracts/imageEditorDocument";
import {
  viewportUnderlaySourceTargetKey,
  type ViewportUnderlaySource,
} from "../../viewport/viewportTargetIdentity";
import type { PointerGestures } from "./pointer/types";
import type { LayerMovePreviewTransaction } from "./layerMovePreviewStore";
import { useImageEditorViewport } from "./useImageEditorViewport";

const hookMocks = vi.hoisted(() => ({
  stageSize: { w: 1000, h: 800 },
  view: { zoom: 1, panX: 0, panY: 0 },
  targetViewportView: { zoom: 1, panX: 0, panY: 0 },
  viewportView: { zoom: 1, panX: 0, panY: 0 },
  navigationLayouts: [] as unknown[],
  underlayCalls: [] as unknown[][],
}));

vi.mock("./useObservedElementSize", () => ({
  useObservedElementSize: () => hookMocks.stageSize,
}));

vi.mock("./useRegisteredImageResource", () => ({
  useRegisteredImageResource: () => ({
    resourceId: "resource-a",
    dimensions: { w: 800, h: 800 },
  }),
}));

vi.mock("./useCanvasNavigation", () => ({
  useCanvasNavigation: (_canvasRef: unknown, _gestures: unknown, layout: unknown) => {
    hookMocks.navigationLayouts.push(layout);
    return {
      view: hookMocks.view,
      setView: vi.fn(),
      viewRef: { current: hookMocks.view },
      viewBase: () => [1, 1] as [number, number],
      targetViewportView: hookMocks.targetViewportView,
      viewportView: hookMocks.viewportView,
      spacePan: false,
      setSpacePan: vi.fn(),
    };
  },
}));

vi.mock("../../viewport/useViewportUnderlay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../viewport/useViewportUnderlay")>();
  return {
    ...actual,
    useViewportUnderlay: (...args: unknown[]) => {
      hookMocks.underlayCalls.push(args);
      return {
        underlay: "frame-a",
        presented: false,
        dims: { w: 800, h: 800 },
        frameView: args[3],
        backend: null,
        targetSettled: false,
        renderedTargetKey: null,
        host: null,
      };
    },
  };
});

const stageRef = { current: null };
const canvasRef = { current: null };
const gestures = {} as PointerGestures;

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

function viewportArgs(
  document: ImageEditorDocument,
  layerMovePreview: LayerMovePreviewTransaction | null = null,
) {
  return {
    workspace: "image" as const,
    imagePath: "C:/fixtures/image.png",
    document,
    stageRef,
    canvasRef,
    gestures,
    overlayOnly: false,
    entering: false,
    closing: false,
    viewportMaskOverlay: null,
    viewportOverlayScene: null,
    selectedLayerId: document.layers[document.active]?.id ?? null,
    layerMovePreview,
    fallbackDimensions: { w: 1, h: 1 },
    emptyDimensions: { w: 1, h: 1 },
  };
}

beforeEach(() => {
  hookMocks.stageSize = { w: 1000, h: 800 };
  hookMocks.view = { zoom: 1, panX: 0, panY: 0 };
  hookMocks.targetViewportView = { zoom: 1, panX: 0, panY: 0 };
  hookMocks.viewportView = { zoom: 1, panX: 0, panY: 0 };
  hookMocks.navigationLayouts.length = 0;
  hookMocks.underlayCalls.length = 0;
});

afterEach(cleanup);

describe("useImageEditorViewport coordinate integration", () => {
  it("keeps one pasteboard scene target across stage resize, pan, and zoom", () => {
    const document: ImageEditorDocument = {
      ...emptyImageEditorDocument(),
      canvas: { w: 800, h: 800, resample: "bicubic" },
    };
    const { result, rerender } = renderHook(
      ({ value }) => useImageEditorViewport(viewportArgs(value)),
      { initialProps: { value: document } },
    );
    const firstSource = last(hookMocks.underlayCalls)?.[1];

    expect(result.current.logicalPasteboard).toEqual({ x: -600, y: -600, w: 2000, h: 2000 });
    expect(firstSource).toMatchObject({
      kind: "image_composite",
      documentWidth: 800,
      documentHeight: 800,
      frameX: -600,
      frameY: -600,
      frameWidth: 2000,
      frameHeight: 2000,
    });

    hookMocks.stageSize = { w: 1400, h: 900 };
    hookMocks.view = { zoom: 2, panX: 120, panY: -40 };
    hookMocks.targetViewportView = { zoom: 2, panX: 0.2, panY: 0.1 };
    hookMocks.viewportView = hookMocks.targetViewportView;
    rerender({ value: document });

    const afterNavigationSource = last(hookMocks.underlayCalls)?.[1];
    expect(viewportUnderlaySourceTargetKey(afterNavigationSource as ViewportUnderlaySource)).toBe(
      viewportUnderlaySourceTargetKey(firstSource as ViewportUnderlaySource),
    );
    expect(last(hookMocks.navigationLayouts)).toMatchObject({
      baseW: 900,
      baseH: 900,
      stageW: 1400,
      stageH: 900,
      viewportWorldFrame: { x: -600, y: -600, w: 2000, h: 2000 },
      viewportFitFrame: { x: 0, y: 0, w: 800, h: 800 },
    });
  });

  it("uses the full document child as the navigation base inside a crop fit", () => {
    const base = emptyImageEditorDocument();
    const document: ImageEditorDocument = {
      ...base,
      canvas: { w: 800, h: 800, resample: "bicubic" },
      layers: [{ ...base.layers[0], ops: [{ type: "crop", region: [200, 200, 600, 600] }] }],
    };
    renderHook(() => useImageEditorViewport(viewportArgs(document)));

    expect(last(hookMocks.navigationLayouts)).toMatchObject({
      baseW: 1600,
      baseH: 1600,
      stageW: 1000,
      stageH: 800,
    });
    const source = last(hookMocks.underlayCalls)?.[1];
    expect(source).toMatchObject({
      frameX: -600,
      frameY: -600,
      frameWidth: 2000,
      frameHeight: 2000,
    });
  });

  it("sends drag deltas as scene presentation state without hiding or retargeting the layer", () => {
    const base = emptyImageEditorDocument();
    const document: ImageEditorDocument = {
      ...base,
      canvas: { w: 800, h: 800, resample: "bicubic" },
    };
    const { rerender } = renderHook(
      ({ preview }) => useImageEditorViewport(viewportArgs(document, preview)),
      { initialProps: { preview: null as LayerMovePreviewTransaction | null } },
    );
    const firstSource = last(hookMocks.underlayCalls)?.[1] as Extract<ViewportUnderlaySource, { kind: "image_composite" }>;
    const preview: LayerMovePreviewTransaction = {
      transactionId: "layer-move-1",
      baseDocumentKey: firstSource.documentKey,
      selectedLayerId: document.layers[document.active].id,
      sequence: 3,
      delta: [900, 12],
      phase: "dragging",
    };

    rerender({ preview });

    const call = last(hookMocks.underlayCalls)!;
    const source = call[1] as Extract<ViewportUnderlaySource, { kind: "image_composite" }>;
    expect(viewportUnderlaySourceTargetKey(source)).toBe(viewportUnderlaySourceTargetKey(firstSource));
    expect(source.document).toBe(document);
    expect((source.document as ImageEditorDocument).layers[document.active].visible).not.toBe(false);
    expect(call[10]).toEqual({
      selectedLayerId: preview.selectedLayerId,
      transactionId: preview.transactionId,
      baseDocumentKey: preview.baseDocumentKey,
      sequence: 3,
      moveDraft: { dx: 900, dy: 12 },
    });
  });

  it("switches a committing move to the new document baseline", () => {
    const base = emptyImageEditorDocument();
    const document: ImageEditorDocument = {
      ...base,
      canvas: { w: 800, h: 800, resample: "bicubic" },
    };
    const { result, rerender } = renderHook(
      ({ value, preview }) => useImageEditorViewport(viewportArgs(value, preview)),
      {
        initialProps: {
          value: document,
          preview: null as LayerMovePreviewTransaction | null,
        },
      },
    );
    const preview: LayerMovePreviewTransaction = {
      transactionId: "layer-move-1",
      baseDocumentKey: result.current.documentKey,
      selectedLayerId: document.layers[document.active].id,
      sequence: 2,
      delta: [24, 12],
      phase: "committing",
    };
    const committed: ImageEditorDocument = {
      ...document,
      layers: document.layers.map((layer, index) => index === document.active
        ? { ...layer, ops: [...layer.ops, { type: "transform", dx: 24, dy: 12 }] }
        : layer),
    };

    rerender({ value: committed, preview });

    const call = last(hookMocks.underlayCalls)!;
    const source = call[1] as Extract<ViewportUnderlaySource, { kind: "image_composite" }>;
    expect(source.document).toBe(committed);
    expect(source.documentKey).not.toBe(preview.baseDocumentKey);
    expect(call[10]).toEqual({
      selectedLayerId: preview.selectedLayerId,
      transactionId: `selection:${preview.selectedLayerId}`,
      baseDocumentKey: source.documentKey,
      sequence: 0,
      moveDraft: null,
    });
  });
});
