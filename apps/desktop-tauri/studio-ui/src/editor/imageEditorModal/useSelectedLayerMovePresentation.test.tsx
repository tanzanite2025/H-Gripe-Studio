// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSelectedLayerMovePresentation } from "./selectedLayerMove/useSelectedLayerMovePresentation";
import type { SelectedLayerMoveSurface } from "./selectedLayerMove/selectedLayerMoveTypes";

const surface: SelectedLayerMoveSurface = {
  key: "layer:100:100:0:0:100:100",
  pixels: {
    width: 1,
    height: 1,
    backend: { requested: "cpu", actual: "cpu" },
    pixels: new Uint8Array([255, 255, 255, 255]),
  },
};

interface HookProps {
  layerMoveActive: boolean;
  moveDraft: readonly [number, number] | null;
  viewportTargetSettled: boolean;
}

describe("useSelectedLayerMovePresentation", () => {
  it("keeps the yellow frame still when the move surface is not ready", () => {
    const { result } = renderHook(() =>
      useSelectedLayerMovePresentation({
        layerMoveActive: true,
        moveDraft: [24, 12],
        selectedLayerMoveSurface: null,
        viewportTargetSettled: true,
      }),
    );

    expect(result.current.displayedLayerMoveDraft).toBeNull();
    expect(result.current.suppressPixelLayer).toBe(false);
  });

  it("uses one displayed delta for the move surface and selected-layer frame", () => {
    const { result } = renderHook(() =>
      useSelectedLayerMovePresentation({
        layerMoveActive: true,
        moveDraft: [24, 12],
        selectedLayerMoveSurface: surface,
        viewportTargetSettled: true,
      }),
    );

    expect(result.current.displayedLayerMoveDraft).toEqual([24, 12]);
    expect(result.current.suppressPixelLayer).toBe(true);
  });

  it("hands off the last live delta after mouseup until the viewport settles again", () => {
    const initialProps: HookProps = {
      layerMoveActive: true,
      moveDraft: [24, 12],
      viewportTargetSettled: true,
    };
    const { result, rerender } = renderHook(
      ({ layerMoveActive, moveDraft, viewportTargetSettled }) =>
        useSelectedLayerMovePresentation({
          layerMoveActive,
          moveDraft,
          selectedLayerMoveSurface: surface,
          viewportTargetSettled,
        }),
      {
        initialProps,
      },
    );

    expect(result.current.displayedLayerMoveDraft).toEqual([24, 12]);

    act(() => {
      rerender({ layerMoveActive: false, moveDraft: null, viewportTargetSettled: true });
    });
    expect(result.current.displayedLayerMoveDraft).toEqual([24, 12]);
    expect(result.current.suppressPixelLayer).toBe(true);

    act(() => {
      rerender({ layerMoveActive: false, moveDraft: null, viewportTargetSettled: false });
    });
    expect(result.current.displayedLayerMoveDraft).toEqual([24, 12]);

    act(() => {
      rerender({ layerMoveActive: false, moveDraft: null, viewportTargetSettled: true });
    });
    expect(result.current.displayedLayerMoveDraft).toBeNull();
    expect(result.current.suppressPixelLayer).toBe(false);
  });
});
