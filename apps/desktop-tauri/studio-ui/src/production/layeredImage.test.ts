import { describe, expect, it } from "vitest";

import {
  findLayer,
  layeredAssetManifest,
  LAYER_SPLIT_STUB_ENGINE,
  mergeLayersIntoAsset,
  parseLayeredImageAsset,
  splitLayerInAsset,
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

describe("parseLayeredImageAsset", () => {
  const asset = stubLayeredImageAsset({
    imagePath: "/a/b.png",
    nodeId: "n1",
    createdAt: "0",
  });

  it("accepts a well-formed asset round-tripped through JSON", () => {
    const parsed = parseLayeredImageAsset(JSON.parse(JSON.stringify(asset)));
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("layered-n1");
    expect(parsed?.layers).toHaveLength(3);
  });

  it("rejects non-objects and structurally broken assets", () => {
    expect(parseLayeredImageAsset(null)).toBeNull();
    expect(parseLayeredImageAsset("layered")).toBeNull();
    expect(parseLayeredImageAsset({})).toBeNull();
    expect(parseLayeredImageAsset({ ...asset, canvas: { width: "12" } })).toBeNull();
    expect(parseLayeredImageAsset({ ...asset, base_image: { path: 5 } })).toBeNull();
    expect(parseLayeredImageAsset({ ...asset, layers: "not-an-array" })).toBeNull();
    expect(
      parseLayeredImageAsset({ ...asset, layers: [{ id: "x", name: "y", kind: "subject" }] }),
    ).toBeNull();
    expect(parseLayeredImageAsset({ ...asset, split_report: null })).toBeNull();
  });
});

describe("mergeLayersIntoAsset", () => {
  const asset = stubLayeredImageAsset({
    imagePath: "/a/b.png",
    nodeId: "n1",
    createdAt: "0",
  });
  const merged = {
    id: "layer_merged_1",
    name: "merged (background candidate + subject candidate)",
    mask: { path: "/out/merged_mask.png" },
    rgba: { path: "/out/merged.png" },
    bbox: [1, 1, 13, 13] as [number, number, number, number],
  };

  it("replaces the merged layers with one user-sourced layer at the first slot", () => {
    const next = mergeLayersIntoAsset(
      asset,
      [STUB_BACKGROUND_LAYER_ID, STUB_SUBJECT_LAYER_ID],
      merged,
    );
    expect(next.layers.map((l) => l.id)).toEqual([STUB_ORIGINAL_LAYER_ID, "layer_merged_1"]);
    const layer = findLayer(next, "layer_merged_1")!;
    expect(layer.source).toBe("user");
    expect(layer.kind).toBe("object"); // background + subject differ in kind
    expect(layer.bbox).toEqual([1, 1, 13, 13]);
    expect(layer.confidence).toBeLessThanOrEqual(
      Math.min(...asset.layers.filter((l) => !l.locked).map((l) => l.confidence)),
    );
    // the merged members' review issues are replaced by one merged-layer issue
    expect(next.split_report.suggested_review.map((issue) => issue.layer_id)).toEqual([
      "layer_merged_1",
    ]);
    // the input asset is untouched
    expect(asset.layers).toHaveLength(3);
  });

  it("is a no-op when fewer than two unlocked layers match", () => {
    expect(mergeLayersIntoAsset(asset, [STUB_SUBJECT_LAYER_ID], merged)).toBe(asset);
    expect(
      mergeLayersIntoAsset(asset, [STUB_ORIGINAL_LAYER_ID, STUB_SUBJECT_LAYER_ID], merged),
    ).toBe(asset);
    expect(mergeLayersIntoAsset(asset, ["nope", "also-nope"], merged)).toBe(asset);
  });
});

describe("splitLayerInAsset", () => {
  const asset = stubLayeredImageAsset({
    imagePath: "/a/b.png",
    nodeId: "n1",
    createdAt: "0",
  });
  const parts = [1, 2].map((n) => ({
    id: `layer_part_x_${n}`,
    name: `subject candidate part ${n}`,
    mask: { path: `/out/part_${n}_mask.png` },
    rgba: { path: `/out/part_${n}.png` },
    bbox: [n, n, n + 3, n + 3] as [number, number, number, number],
  }));

  it("replaces the split layer with its part layers in place", () => {
    const next = splitLayerInAsset(asset, STUB_SUBJECT_LAYER_ID, parts);
    expect(next.layers.map((l) => l.id)).toEqual([
      STUB_ORIGINAL_LAYER_ID,
      STUB_BACKGROUND_LAYER_ID,
      "layer_part_x_1",
      "layer_part_x_2",
    ]);
    const part = findLayer(next, "layer_part_x_1")!;
    expect(part.source).toBe("user");
    expect(part.kind).toBe("object");
    expect(part.bbox).toEqual([1, 1, 4, 4]);
    const source = findLayer(asset, STUB_SUBJECT_LAYER_ID)!;
    expect(part.confidence).toBeCloseTo(Math.max(source.confidence - 0.15, 0.1));
    // the split layer's review issues are replaced by one per part
    const reviewIds = next.split_report.suggested_review.map((issue) => issue.layer_id);
    expect(reviewIds).not.toContain(STUB_SUBJECT_LAYER_ID);
    expect(reviewIds).toContain("layer_part_x_1");
    expect(reviewIds).toContain("layer_part_x_2");
    // the input asset is untouched
    expect(asset.layers).toHaveLength(3);
  });

  it("is a no-op for locked/unknown layers or fewer than two parts", () => {
    expect(splitLayerInAsset(asset, STUB_ORIGINAL_LAYER_ID, parts)).toBe(asset);
    expect(splitLayerInAsset(asset, "nope", parts)).toBe(asset);
    expect(splitLayerInAsset(asset, STUB_SUBJECT_LAYER_ID, parts.slice(0, 1))).toBe(asset);
  });
});
