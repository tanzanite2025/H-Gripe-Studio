// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PointerGestures } from "./pointer/types";
import { useCanvasNavigation, type CanvasNavigationLayout } from "./useCanvasNavigation";

afterEach(cleanup);

const gestures = {} as PointerGestures;
const canvasRef = { current: null };

describe("useCanvasNavigation layout projection", () => {
  it("recomputes the viewport window after stage and document geometry changes", () => {
    const initialLayout: CanvasNavigationLayout = {
      baseW: 800,
      baseH: 800,
      stageW: 1000,
      stageH: 800,
      revision: "document:800x800",
    };
    const { result, rerender } = renderHook(
      ({ layout }) => useCanvasNavigation(canvasRef, gestures, layout),
      { initialProps: { layout: initialLayout } },
    );

    act(() => result.current.setView({ zoom: 4, panX: 0, panY: 0 }));
    expect(result.current.targetViewportView).toEqual({
      zoom: 3.2,
      panX: 0.34375,
      panY: 0.34375,
    });

    rerender({
      layout: {
        ...initialLayout,
        stageW: 1600,
        revision: "document:800x800:stage:1600x800",
      },
    });
    expect(result.current.targetViewportView).toEqual({ zoom: 2, panX: 0.25, panY: 0.25 });

    rerender({
      layout: {
        baseW: 1000,
        baseH: 500,
        stageW: 1000,
        stageH: 800,
        revision: "document:1600x800",
      },
    });
    expect(result.current.targetViewportView).toEqual({ zoom: 2.5, panX: 0.3, panY: 0.3 });
    expect(result.current.viewBase()).toEqual([1000, 500]);
  });

  it("normalizes the retained viewport window to the pasteboard scene", () => {
    const layout: CanvasNavigationLayout = {
      baseW: 800,
      baseH: 800,
      stageW: 1000,
      stageH: 800,
      viewportWorldFrame: { x: -600, y: -600, w: 2000, h: 2000 },
      viewportFitFrame: { x: 0, y: 0, w: 800, h: 800 },
      revision: "pasteboard:2000:document:800",
    };
    const { result } = renderHook(() => useCanvasNavigation(canvasRef, gestures, layout));

    expect(result.current.targetViewportView).toEqual({ zoom: 2, panX: 0.25, panY: 0.25 });
    act(() => result.current.setView({ zoom: 2, panX: 100, panY: -40 }));
    expect(result.current.targetViewportView).toEqual({ zoom: 4, panX: 0.35, panY: 0.385 });
  });
});
