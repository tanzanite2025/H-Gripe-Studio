import { describe, expect, it } from "vitest";

import type { MediaAsset } from "./mediaBin";
import { appendClip, createTimeline, splitClip, trimClip, type TimelineModel } from "./timeline";
import {
  buildRenderPlan,
  DEFAULT_EXPORT_FPS,
  expandPlanFrames,
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

  it("collects video clips alongside stills and audio segments", () => {
    const assets = [
      asset("v1", "video", "C:/clip.mp4"),
      asset("s1", "image", "C:/still.png"),
      asset("m1", "audio", "C:/music.mp3"),
    ];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, assets);
    expect(plan.video.map((s) => s.kind)).toEqual(["video", "still"]);
    expect(plan.audio).toHaveLength(1);
    expect(plan.durationSec).toBeCloseTo(4);
    expect(plan.warnings).toEqual([]);
  });

  it("carries each audio clip's edit into its segment, defaulting when absent", () => {
    const assets = [asset("m1", "audio", "C:/music.mp3"), asset("m2", "audio", "C:/voice.wav")];
    const { timeline, clipIds } = withClips(assets);
    const edit = { trimStartSec: 1.5, trimEndSec: null, gainDb: -6, fadeInSec: 0.5, fadeOutSec: 1 };
    const plan = buildRenderPlan(timeline, assets, {
      clipAudioEdit: (clipId) => (clipId === clipIds[0] ? edit : null),
    });
    expect(plan.audio).toHaveLength(2);
    expect(plan.audio[0]).toMatchObject({
      path: "C:/music.mp3",
      trimStartSec: 1.5,
      gainDb: -6,
      fadeInSec: 0.5,
      fadeOutSec: 1,
    });
    expect(plan.audio[1]).toMatchObject({
      path: "C:/voice.wav",
      trimStartSec: 0,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  });

  it("reports gaps between still segments", () => {
    const assets = [asset("a1", "image", "C:/one.png"), asset("a2", "image", "C:/two.png")];
    const { timeline, clipIds } = withClips(assets);
    const shifted = trimClip(timeline, clipIds[1], { start: 5 });
    const plan = buildRenderPlan(shifted, assets);
    expect(plan.warnings).toEqual([{ kind: "gap", atSec: 2, lengthSec: 3 }]);
  });
});

describe("expandPlanFrames", () => {
  it("emits one frame path per output frame, carrying the clip's grade doc", () => {
    const assets = [asset("a1", "image", "C:/one.png")];
    const { timeline, clipIds } = withClips(assets);
    const doc = '{"layers":[]}';
    const plan = buildRenderPlan(timeline, assets, {
      fps: 10,
      clipGradeDoc: (clipId) => (clipId === clipIds[0] ? doc : null),
    });
    const frames = expandPlanFrames(plan);
    expect(frames?.paths).toHaveLength(20);
    expect(frames?.paths.every((f) => f === "C:/one.png")).toBe(true);
    expect(frames?.gradeDocs).toHaveLength(20);
    expect(frames?.gradeDocs.every((d) => d === doc)).toBe(true);
    expect(frames?.frameTimes.every((t) => t === null)).toBe(true);
    expect(frames?.hasVideoFrames).toBe(false);
  });

  it("pairs video-clip frames with clip-local decode times", () => {
    const assets = [asset("v1", "video", "C:/clip.mp4"), asset("s1", "image", "C:/still.png")];
    const { timeline } = withClips(assets);
    const plan = buildRenderPlan(timeline, assets, { fps: 2 });
    const frames = expandPlanFrames(plan);
    expect(frames?.paths).toEqual([
      "C:/clip.mp4",
      "C:/clip.mp4",
      "C:/clip.mp4",
      "C:/clip.mp4",
      "C:/still.png",
      "C:/still.png",
      "C:/still.png",
      "C:/still.png",
    ]);
    expect(frames?.frameTimes).toEqual([0, 0.5, 1, 1.5, null, null, null, null]);
    expect(frames?.hasVideoFrames).toBe(true);
  });

  it("offsets video frame times after a razor split", () => {
    const assets = [asset("v1", "video", "C:/clip.mp4")];
    const { timeline, clipIds } = withClips(assets);
    const split = splitClip(timeline, clipIds[0], 1)!;
    const plan = buildRenderPlan(split.timeline, assets, { fps: 2 });
    const frames = expandPlanFrames(plan);
    expect(frames?.frameTimes).toEqual([0, 0.5, 1, 1.5]);
  });

  it("refuses plans that exceed the frame budget", () => {
    const assets = [asset("a1", "image", "C:/one.png")];
    let timeline = createTimeline();
    const result = appendClip(timeline, assets[0], {
      duration: MAX_EXPORT_FRAMES / 10 + 1,
    });
    timeline = result!.timeline;
    const plan = buildRenderPlan(timeline, assets, { fps: 10 });
    expect(expandPlanFrames(plan)).toBeNull();
  });
});
