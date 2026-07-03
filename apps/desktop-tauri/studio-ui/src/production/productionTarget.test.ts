import { describe, expect, it } from "vitest";

import {
  assetTarget,
  imageLayerTarget,
  layeredImageTarget,
  nodeOutputTarget,
  sameTarget,
  targetKey,
} from "./productionTarget";

describe("production target identity", () => {
  it("builds asset and node-output targets", () => {
    expect(assetTarget("a1")).toEqual({ kind: "asset", assetId: "a1" });
    expect(nodeOutputTarget("n1")).toEqual({ kind: "node_output", nodeId: "n1" });
    expect(nodeOutputTarget("n1", "image")).toEqual({
      kind: "node_output",
      nodeId: "n1",
      outputPort: "image",
    });
  });

  it("builds layered-image and image-layer targets", () => {
    expect(layeredImageTarget("a1")).toEqual({ kind: "layered_image", assetId: "a1" });
    expect(layeredImageTarget("a1", "n1")).toEqual({
      kind: "layered_image",
      assetId: "a1",
      sourceNodeId: "n1",
    });
    expect(imageLayerTarget("a1", "l1")).toEqual({
      kind: "image_layer",
      assetId: "a1",
      layerId: "l1",
    });
    expect(imageLayerTarget("a1", "l1", "w1")).toEqual({
      kind: "image_layer",
      assetId: "a1",
      layerId: "l1",
      workspaceId: "w1",
    });
  });

  it("keys every target kind distinctly", () => {
    const keys = [
      targetKey(null),
      targetKey({ kind: "asset", assetId: "a" }),
      targetKey({ kind: "image", assetId: "a" }),
      targetKey({ kind: "layered_image", assetId: "a" }),
      targetKey({ kind: "image_layer", assetId: "a", layerId: "l" }),
      targetKey({ kind: "video_clip", timelineId: "t", trackId: "tr", clipId: "c" }),
      targetKey({ kind: "audio_clip", timelineId: "t", trackId: "tr", clipId: "c" }),
      targetKey({ kind: "node_output", nodeId: "n" }),
      targetKey({ kind: "timeline", timelineId: "t" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("compares targets structurally", () => {
    expect(sameTarget(assetTarget("a1"), assetTarget("a1"))).toBe(true);
    expect(sameTarget(assetTarget("a1"), assetTarget("a2"))).toBe(false);
    expect(sameTarget(nodeOutputTarget("n1"), nodeOutputTarget("n1", "image"))).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, assetTarget("a1"))).toBe(false);
    // Layer selection identity does not depend on which workspace is open.
    expect(
      sameTarget(imageLayerTarget("a1", "l1", "w1"), imageLayerTarget("a1", "l1")),
    ).toBe(true);
    expect(sameTarget(layeredImageTarget("a1"), imageLayerTarget("a1", "l1"))).toBe(false);
  });
});
