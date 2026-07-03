import { describe, expect, it } from "vitest";

import {
  addAsset,
  assetDisplayName,
  assetKindForNodeKind,
  assetKindForPath,
  removeAsset,
  type MediaAsset,
} from "./mediaBin";

describe("media bin model", () => {
  it("maps media source node kinds to asset kinds", () => {
    expect(assetKindForNodeKind("imageSource")).toBe("image");
    expect(assetKindForNodeKind("videoSource")).toBe("video");
    expect(assetKindForNodeKind("audioSource")).toBe("audio");
    expect(assetKindForNodeKind("prompt")).toBeNull();
    expect(assetKindForNodeKind("generate")).toBeNull();
  });

  it("recognises audio files by extension", () => {
    expect(assetKindForPath("C:\\media\\song.MP3")).toBe("audio");
    expect(assetKindForPath("/tmp/voice.wav")).toBe("audio");
    expect(assetKindForPath("/tmp/photo.png")).toBeNull();
    expect(assetKindForPath("noextension")).toBeNull();
  });

  it("derives the display name from the file name on both path styles", () => {
    expect(assetDisplayName("C:\\media\\fox.png")).toBe("fox.png");
    expect(assetDisplayName("/home/u/clips/take1.mp4")).toBe("take1.mp4");
    expect(assetDisplayName("bare.png")).toBe("bare.png");
  });

  it("adds an asset with a generated id and metadata", () => {
    const r = addAsset([], { kind: "image", path: "C:\\media\\fox.png", sourceNodeId: "n1" }, 1000);
    expect(r.added).toBe(true);
    expect(r.assets).toHaveLength(1);
    expect(r.asset.kind).toBe("image");
    expect(r.asset.name).toBe("fox.png");
    expect(r.asset.sourceNodeId).toBe("n1");
    expect(r.asset.addedAt).toBe(1000);
  });

  it("dedupes re-adds of the same kind+path, returning the existing asset", () => {
    const first = addAsset([], { kind: "image", path: "C:\\a.png" });
    const again = addAsset(first.assets, { kind: "image", path: "C:\\a.png", sourceNodeId: "n2" });
    expect(again.added).toBe(false);
    expect(again.assets).toBe(first.assets);
    expect(again.asset.id).toBe(first.asset.id);
    // Same path but a different media kind is a distinct asset.
    const other = addAsset(first.assets, { kind: "video", path: "C:\\a.png" });
    expect(other.added).toBe(true);
    expect(other.assets).toHaveLength(2);
  });

  it("removes assets by id without touching the rest", () => {
    const a = addAsset([], { kind: "image", path: "C:\\a.png" });
    const b = addAsset(a.assets, { kind: "video", path: "C:\\b.mp4" });
    const left: MediaAsset[] = removeAsset(b.assets, a.asset.id);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(b.asset.id);
    expect(removeAsset(left, "missing")).toEqual(left);
  });
});
