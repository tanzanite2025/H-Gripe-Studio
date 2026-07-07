import { describe, expect, it } from "vitest";

import { addAsset, type MediaAsset } from "./mediaBin";
import { paceToFrameGrid, resolvePreviewFrame } from "./previewFrame";
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

describe("paceToFrameGrid", () => {
  it("snaps a playing video request onto the source frame grid", () => {
    const { timeline, assets } = setup();
    const target = resolvePreviewFrame(timeline, assets, 8.5); // video: 5..15
    // 3.5s clip-local at 24fps -> frame 84 -> 3.5s; 3.51s stays on frame 84.
    expect(paceToFrameGrid(target, 8.5, 24)).toBeCloseTo(5 + 84 / 24, 10);
    expect(paceToFrameGrid(target, 8.51, 24)).toBeCloseTo(5 + 84 / 24, 10);
    // The next frame boundary advances exactly one frame.
    expect(paceToFrameGrid(target, 8.55, 24)).toBeCloseTo(5 + 85 / 24, 10);
  });

  it("passes through non-video targets and unknown frame rates", () => {
    const { timeline, assets } = setup();
    const still = resolvePreviewFrame(timeline, assets, 2);
    const video = resolvePreviewFrame(timeline, assets, 8.5);
    expect(paceToFrameGrid(still, 2.37, 24)).toBe(2.37);
    expect(paceToFrameGrid(video, 8.5, null)).toBe(8.5);
    expect(paceToFrameGrid(video, 8.5, 0)).toBe(8.5);
    expect(paceToFrameGrid(null, 1.5, 24)).toBe(1.5);
  });
});
