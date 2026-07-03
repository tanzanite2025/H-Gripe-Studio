import { describe, expect, it } from "vitest";

import type { MediaAsset } from "./mediaBin";
import { appendClip, createTimeline, trimClip, type TimelineModel } from "./timeline";
import {
  buildRenderPlan,
  DEFAULT_EXPORT_FPS,
  expandStillFrames,
  MAX_EXPORT_FRAMES,
} from "./renderPlan";

function asset(id: string, kind: MediaAsset["kind"], path: string): MediaAsset {
  return { id, kind, path, name: path, addedAt: 0 };
}

function withClips(assets: MediaAsset[]): { timeline: TimelineModel; clipIds: string[] } {
  let timeline = createTimeline();
  const clipIds: string[] = [];
  for (const a of assets) {
    const result = appendClip(timeline, a, { duration: 2 });
    if (!result) throw new Error(`no track for ${a.id}`);
    timeline = result.timeline;
    clipIds.push(result.clip.id);
  }
  return { timeline, clipIds };
}

describe("buildRenderPlan", () => {
  it("orders still segments and sums the encoded duration", () => {
    const assets = [asset("a1", "image", "C:/one.png"), asset("a2", "image", "C:/two.png")];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, assets);
    expect(plan.fps).toBe(DEFAULT_EXPORT_FPS);
    expect(plan.video.map((s) => s.path)).toEqual(["C:/one.png", "C:/two.png"]);
    expect(plan.durationSec).toBeCloseTo(4);
    expect(plan.warnings).toEqual([]);
  });

  it("warns on missing assets instead of dropping them silently", () => {
    const assets = [asset("a1", "image", "C:/one.png")];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, []);
    expect(plan.video).toEqual([]);
    expect(plan.warnings).toEqual([
      { kind: "missing_asset", clipId: expect.any(String), assetId: "a1" },
    ]);
  });

  it("skips video clips with a warning and reports unmixed audio", () => {
    const assets = [
      asset("v1", "video", "C:/clip.mp4"),
      asset("s1", "image", "C:/still.png"),
      asset("m1", "audio", "C:/music.mp3"),
    ];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, assets);
    expect(plan.video).toHaveLength(1);
    expect(plan.audio).toHaveLength(1);
    expect(plan.warnings.map((w) => w.kind)).toEqual(["video_clip_skipped", "audio_not_mixed"]);
  });

  it("reports gaps between still segments", () => {
    const assets = [asset("a1", "image", "C:/one.png"), asset("a2", "image", "C:/two.png")];
    const { timeline, clipIds } = withClips(assets);
    const shifted = trimClip(timeline, clipIds[1], { start: 5 });
    const plan = buildRenderPlan(shifted, assets);
    expect(plan.warnings).toEqual([{ kind: "gap", atSec: 2, lengthSec: 3 }]);
  });
});

describe("expandStillFrames", () => {
  it("emits one frame path per output frame", () => {
    const assets = [asset("a1", "image", "C:/one.png")];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, assets, { fps: 10 });
    const frames = expandStillFrames(plan);
    expect(frames).toHaveLength(20);
    expect(frames?.every((f) => f === "C:/one.png")).toBe(true);
  });

  it("refuses plans that exceed the frame budget", () => {
    const assets = [asset("a1", "image", "C:/one.png")];
    let timeline = createTimeline();
    const result = appendClip(timeline, assets[0], {
      duration: MAX_EXPORT_FRAMES / 10 + 1,
    });
    timeline = result!.timeline;
    const plan = buildRenderPlan(timeline, assets, { fps: 10 });
    expect(expandStillFrames(plan)).toBeNull();
  });
});
