import { describe, expect, it } from "vitest";
import type { ViewportTarget } from "../bridge/viewport";
import {
  viewportUnderlaySourceHostKey,
  viewportUnderlaySourceImageScene,
  viewportUnderlaySourceSceneKey,
  viewportUnderlaySourceTargetKey,
  type ViewportUnderlaySource,
} from "./viewportTargetIdentity";

describe("viewport target identity", () => {
  it.each<{
    source: ViewportUnderlaySource | undefined;
    targetKey: string;
    hostKey: string;
  }>([
    { source: undefined, targetKey: "none", hostKey: "none" },
    { source: "C:/images/a.png", targetKey: "path:C:/images/a.png", hostKey: "path:C:/images/a.png" },
    {
      source: { kind: "image", resourceId: "image-a" },
      targetKey: "image:image-a",
      hostKey: "image:image-a",
    },
    {
      source: { kind: "image_layer", assetId: "asset-a", layerId: "layer-a" },
      targetKey: "image_layer:asset-a:layer-a",
      hostKey: "image_layer:asset-a:layer-a",
    },
    {
      source: { kind: "video_clip", timelineId: "timeline-a", clipId: "clip-a", timeSec: 1.25 },
      targetKey: "video_clip:timeline-a:clip-a:1.25",
      hostKey: "video_clip:timeline-a:clip-a",
    },
    {
      source: { kind: "video_frame", resourceId: "video-a", timeSec: 2.5 },
      targetKey: "video_frame:video-a:2.5",
      hostKey: "video_frame:video-a",
    },
    {
      source: { kind: "node_output", nodeId: "node-a", outputPort: "image" },
      targetKey: "node_output:node-a:image",
      hostKey: "node_output:node-a:image",
    },
  ])("separates pixel and host identity for $targetKey", ({ source, targetKey, hostKey }) => {
    expect(viewportUnderlaySourceTargetKey(source)).toBe(targetKey);
    expect(viewportUnderlaySourceHostKey(source)).toBe(hostKey);
  });

  it("keeps image-composite host identity stable across target revisions", () => {
    const source: ViewportTarget = {
      kind: "image_composite",
      resourceId: "image-a",
      document: { layers: [] },
      documentKey: "document-a",
      documentWidth: 640,
      documentHeight: 480,
      frameX: -20,
      frameY: -10,
      frameWidth: 680,
      frameHeight: 500,
    };
    const expectedTarget = "image_composite:image-a";
    const expectedHost = "image_composite:image-a";
    const expectedScene = "image_scene:document-a:640x480:-20,-10:680x500";

    expect(viewportUnderlaySourceTargetKey(source)).toBe(expectedTarget);
    expect(viewportUnderlaySourceHostKey(source)).toBe(expectedHost);
    expect(viewportUnderlaySourceSceneKey(source)).toBe(expectedScene);
    expect(viewportUnderlaySourceImageScene(source)).toEqual({
      document: { layers: [] },
      documentKey: "document-a",
      documentWidth: 640,
      documentHeight: 480,
      frameX: -20,
      frameY: -10,
      frameWidth: 680,
      frameHeight: 500,
    });
    expect(viewportUnderlaySourceHostKey({
      ...source,
      documentKey: "document-b",
      frameX: 40,
      frameWidth: 720,
    })).toBe(expectedHost);
    expect(viewportUnderlaySourceHostKey({ ...source, resourceId: "image-b" }))
      .toBe("image_composite:image-b");
    expect(viewportUnderlaySourceTargetKey({ ...source, documentKey: "document-b" }))
      .toBe(expectedTarget);
    expect(viewportUnderlaySourceSceneKey({ ...source, documentKey: "document-b" }))
      .toContain("document-b");
  });
});
