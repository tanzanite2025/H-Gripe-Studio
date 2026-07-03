import { describe, expect, it } from "vitest";

import { addAsset, type MediaAsset } from "./mediaBin";
import { resolvePreviewFrame } from "./previewFrame";
import { appendClip, createTimeline, type TimelineModel } from "./timeline";

function setup(): { timeline: TimelineModel; assets: MediaAsset[] } {
  let assets: MediaAsset[] = [];
  const still = addAsset(assets, { kind: "image", path: "C:/media/a.png" });
  assets = still.assets;
  const video = addAsset(assets, { kind: "video", path: "C:/media/b.mp4" });
  assets = video.assets;
  let timeline = createTimeline();
  timeline = appendClip(timeline, still.asset)!.timeline; // still: 0..5
  timeline = appendClip(timeline, video.asset)!.timeline; // video: 5..15
  return { timeline, assets };
}

describe("resolvePreviewFrame", () => {
  it("resolves a still clip to its image path", () => {
    const { timeline, assets } = setup();
    const frame = resolvePreviewFrame(timeline, assets, 2);
    expect(frame).toMatchObject({ kind: "still", path: "C:/media/a.png" });
  });

  it("maps the playhead into clip-local source time for video clips", () => {
    const { timeline, assets } = setup();
    const frame = resolvePreviewFrame(timeline, assets, 8.5);
    expect(frame).toMatchObject({
      kind: "video",
      path: "C:/media/b.mp4",
      sourceTimeSec: 3.5,
    });
  });

  it("returns null past the last clip and on missing assets", () => {
    const { timeline, assets } = setup();
    expect(resolvePreviewFrame(timeline, assets, 99)).toBeNull();
    expect(resolvePreviewFrame(timeline, [], 2)).toBeNull();
  });
});
