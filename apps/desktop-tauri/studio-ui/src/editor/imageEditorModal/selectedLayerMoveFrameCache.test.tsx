// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import {
  translateSelectedLayerFrame,
  useSelectedLayerMoveFrameCache,
} from "./selectedLayerMoveFrameCache";

const frame: SelectedLayerFrame = {
  owner: "selected-layer-frame",
  shape: "axis-aligned-rect",
  layerId: "layer-a",
  rect: [10, 20, 110, 220],
  sourceRect: [10, 20, 110, 220],
  source: "asset-frame",
};

describe("selectedLayerMoveFrameCache", () => {
  it("translates only the displayed frame rect", () => {
    expect(translateSelectedLayerFrame(frame, [7, -3])).toMatchObject({
      rect: [17, 17, 117, 217],
      sourceRect: [10, 20, 110, 220],
      layerId: "layer-a",
    });
  });

  it("hides the frame during a V move until a move-surface draft is displayed", () => {
    const { result, rerender } = renderHook(
      ({ displayedLayerMoveDraft }) =>
        useSelectedLayerMoveFrameCache({
          selectedLayerId: "layer-a",
          resolvedFrame: frame,
          layerMoveActive: true,
          displayedLayerMoveDraft,
          viewportTargetSettled: true,
        }),
      {
        initialProps: {
          displayedLayerMoveDraft: null as readonly [number, number] | null,
        },
      },
    );

    expect(result.current).toBeNull();

    act(() => {
      rerender({ displayedLayerMoveDraft: [7, -3] });
    });
    expect(result.current?.rect).toEqual([17, 17, 117, 217]);
  });

  it("keeps the translated cached frame through mouseup handoff", () => {
    const { result, rerender } = renderHook(
      ({ layerMoveActive, displayedLayerMoveDraft, viewportTargetSettled }) =>
        useSelectedLayerMoveFrameCache({
          selectedLayerId: "layer-a",
          resolvedFrame: frame,
          layerMoveActive,
          displayedLayerMoveDraft,
          viewportTargetSettled,
        }),
      {
        initialProps: {
          layerMoveActive: true,
          displayedLayerMoveDraft: [7, -3] as readonly [number, number] | null,
          viewportTargetSettled: true,
        },
      },
    );

    expect(result.current?.rect).toEqual([17, 17, 117, 217]);

    act(() => {
      rerender({
        layerMoveActive: false,
        displayedLayerMoveDraft: [7, -3],
        viewportTargetSettled: false,
      });
    });
    expect(result.current?.rect).toEqual([17, 17, 117, 217]);

    act(() => {
      rerender({
        layerMoveActive: false,
        displayedLayerMoveDraft: null,
        viewportTargetSettled: true,
      });
    });
    expect(result.current).toBe(frame);
  });
});
