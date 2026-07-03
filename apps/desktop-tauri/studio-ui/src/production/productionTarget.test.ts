import { describe, expect, it } from "vitest";

import { assetTarget, nodeOutputTarget, sameTarget, targetKey } from "./productionTarget";

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

  it("keys every target kind distinctly", () => {
    const keys = [
      targetKey(null),
      targetKey({ kind: "asset", assetId: "a" }),
      targetKey({ kind: "image", assetId: "a" }),
      targetKey({ kind: "image_layer", workspaceId: "w", layerId: "l" }),
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
  });
});
