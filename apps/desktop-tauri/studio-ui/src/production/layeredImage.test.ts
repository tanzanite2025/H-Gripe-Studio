import { describe, expect, it } from "vitest";

import {
  findLayer,
  layeredAssetManifest,
  LAYER_SPLIT_STUB_ENGINE,
  STUB_BACKGROUND_LAYER_ID,
  STUB_ORIGINAL_LAYER_ID,
  STUB_SUBJECT_LAYER_ID,
  stubLayeredImageAsset,
} from "./layeredImage";

describe("stubLayeredImageAsset", () => {
  const asset = stubLayeredImageAsset({
    imagePath: "/a/b.png",
    nodeId: "n1",
    createdAt: "0",
  });

  it("wraps the source image into a deterministic three-layer stub", () => {
    expect(asset.id).toBe("layered-n1");
    expect(asset.source_asset_id).toBe("/a/b.png");
    expect(asset.source_node_id).toBe("n1");
    expect(asset.base_image.path).toBe("/a/b.png");
    expect(asset.preview_composite.path).toBe("/a/b.png");
    expect(asset.canvas).toEqual({ width: 0, height: 0, color_space: "unknown" });
    expect(asset.layers.map((l) => l.id)).toEqual([
      STUB_ORIGINAL_LAYER_ID,
      STUB_BACKGROUND_LAYER_ID,
      STUB_SUBJECT_LAYER_ID,
    ]);
  });

  it("locks the original layer and marks the candidates low-confidence", () => {
    const original = findLayer(asset, STUB_ORIGINAL_LAYER_ID);
    expect(original?.locked).toBe(true);
    expect(original?.confidence).toBe(1);
    const subject = findLayer(asset, STUB_SUBJECT_LAYER_ID);
    expect(subject?.kind).toBe("subject");
    expect(subject?.confidence).toBeLessThan(0.5);
    expect(subject?.source).toBe("algorithm");
  });

  it("reports the stub engine plus a review warning per candidate", () => {
    expect(asset.split_report.engine_version).toBe(LAYER_SPLIT_STUB_ENGINE);
    expect(asset.split_report.created_at).toBe("0");
    expect(asset.split_report.warnings.length).toBeGreaterThan(0);
    expect(asset.split_report.suggested_review.map((r) => r.layer_id)).toEqual([
      STUB_BACKGROUND_LAYER_ID,
      STUB_SUBJECT_LAYER_ID,
    ]);
  });

  it("finds layers by id", () => {
    expect(findLayer(asset, STUB_BACKGROUND_LAYER_ID)?.kind).toBe("background");
    expect(findLayer(asset, "nope")).toBeNull();
  });

  it("flattens into the export manifest with names, bbox and alpha refs", () => {
    const manifest = layeredAssetManifest(asset);
    expect(manifest.asset_id).toBe("layered-n1");
    expect(manifest.engine_version).toBe(LAYER_SPLIT_STUB_ENGINE);
    expect(manifest.composite_preview).toBe("/a/b.png");
    expect(manifest.layers).toHaveLength(3);
    expect(manifest.layers[0]).toEqual({
      id: STUB_ORIGINAL_LAYER_ID,
      name: "original image",
      kind: "unknown",
      bbox: [0, 0, 0, 0],
      alpha: "/a/b.png",
      locked: true,
      confidence: 1,
    });
  });
});
