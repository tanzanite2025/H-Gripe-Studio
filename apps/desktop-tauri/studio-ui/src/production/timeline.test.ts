import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_SECONDS,
  DEFAULT_STILL_SECONDS,
  MIN_CLIP_SECONDS,
  addTrack,
  appendClip,
  clipKindForAsset,
  createTimeline,
  findClip,
  removeClip,
  removeClipsForAsset,
  removeMarker,
  removeTrack,
  snapTimeToPoints,
  splitClip,
  timelineMarkers,
  toggleMarker,
  timelineDuration,
  timelineSnapPoints,
  trackKindForClip,
  trimClip,
} from "./timeline";

const imageAsset = { id: "a-img", kind: "image" as const };
const videoAsset = { id: "a-vid", kind: "video" as const };
const audioAsset = { id: "a-aud", kind: "audio" as const };

describe("timeline model", () => {
  it("maps asset kinds to clip kinds and clip kinds to track kinds", () => {
    expect(clipKindForAsset("image")).toBe("still");
    expect(clipKindForAsset("video")).toBe("video");
    expect(clipKindForAsset("audio")).toBe("audio");
    expect(trackKindForClip("still")).toBe("video");
    expect(trackKindForClip("video")).toBe("video");
    expect(trackKindForClip("audio")).toBe("audio");
  });

  it("creates one video and one audio track", () => {
    const tl = createTimeline();
    expect(tl.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(timelineDuration(tl)).toBe(0);
  });

  it("appends clips end-to-end on the first compatible track", () => {
    const tl = createTimeline();
    const first = appendClip(tl, imageAsset);
    expect(first).not.toBeNull();
    expect(first!.clip.kind).toBe("still");
    expect(first!.clip.start).toBe(0);
    expect(first!.clip.duration).toBe(DEFAULT_STILL_SECONDS);
    expect(first!.clip.sourceStartSec).toBe(0);
    const second = appendClip(first!.timeline, videoAsset);
    expect(second!.trackId).toBe(first!.trackId);
    expect(second!.clip.start).toBe(DEFAULT_STILL_SECONDS);
    expect(second!.clip.duration).toBe(DEFAULT_MEDIA_SECONDS);
    const audio = appendClip(second!.timeline, audioAsset);
    expect(audio!.trackId).not.toBe(second!.trackId);
    expect(audio!.clip.start).toBe(0);
    expect(timelineDuration(audio!.timeline)).toBe(DEFAULT_STILL_SECONDS + DEFAULT_MEDIA_SECONDS);
  });

  it("routes an incompatible requested track to a compatible one", () => {
    const tl = createTimeline();
    const audioTrack = tl.tracks.find((t) => t.kind === "audio")!;
    const r = appendClip(tl, imageAsset, { trackId: audioTrack.id });
    expect(r!.trackId).not.toBe(audioTrack.id);
    expect(findClip(r!.timeline, r!.clip.id)!.track.kind).toBe("video");
  });

  it("returns null when no compatible track exists", () => {
    const tl = { id: "t", fps: 24, tracks: [] };
    expect(appendClip(tl, imageAsset)).toBeNull();
  });

  it("adds tracks on demand", () => {
    const tl = addTrack(createTimeline(), "video");
    expect(tl.tracks.filter((t) => t.kind === "video")).toHaveLength(2);
  });

  it("removes a track with its clips but keeps the last track", () => {
    const withClip = appendClip(createTimeline(), imageAsset)!;
    const removed = removeTrack(withClip.timeline, withClip.trackId);
    expect(removed.tracks.map((t) => t.kind)).toEqual(["audio"]);
    expect(findClip(removed, withClip.clip.id)).toBeNull();
    const last = removeTrack(removed, removed.tracks[0].id);
    expect(last).toBe(removed);
    expect(removeTrack(withClip.timeline, "missing")).toBe(withClip.timeline);
  });

  it("removes clips by id and by asset reference", () => {
    const a = appendClip(createTimeline(), imageAsset)!;
    const b = appendClip(a.timeline, videoAsset)!;
    const without = removeClip(b.timeline, a.clip.id);
    expect(findClip(without, a.clip.id)).toBeNull();
    expect(findClip(without, b.clip.id)).not.toBeNull();
    const cleared = removeClipsForAsset(b.timeline, videoAsset.id);
    expect(findClip(cleared, b.clip.id)).toBeNull();
    expect(findClip(cleared, a.clip.id)).not.toBeNull();
  });

  it("trims non-ripple with clamped start and duration", () => {
    const r = appendClip(createTimeline(), videoAsset)!;
    const trimmed = trimClip(r.timeline, r.clip.id, { start: -3, duration: 0 });
    const clip = findClip(trimmed, r.clip.id)!.clip;
    expect(clip.start).toBe(0);
    expect(clip.duration).toBe(MIN_CLIP_SECONDS);
    const later = findClip(trimClip(trimmed, r.clip.id, { start: 2.5 }), r.clip.id)!.clip;
    expect(later.start).toBe(2.5);
    expect(later.duration).toBe(MIN_CLIP_SECONDS);
  });

  it("collects sorted unique clip-edge snap points", () => {
    expect(timelineSnapPoints(createTimeline())).toEqual([0]);
    const a = appendClip(createTimeline(), imageAsset)!;
    const b = appendClip(a.timeline, videoAsset)!;
    const c = appendClip(b.timeline, audioAsset, { duration: 5 })!;
    expect(timelineSnapPoints(c.timeline)).toEqual([
      0,
      DEFAULT_STILL_SECONDS,
      DEFAULT_STILL_SECONDS + DEFAULT_MEDIA_SECONDS,
    ]);
  });

  it("toggles frame-snapped markers and removes them by id", () => {
    const one = toggleMarker(createTimeline(), 2.501);
    expect(timelineMarkers(one).map((m) => m.sec)).toEqual([2.5]);
    // Same frame toggles the marker off.
    expect(timelineMarkers(toggleMarker(one, 2.5))).toEqual([]);
    const two = toggleMarker(one, 1);
    expect(timelineMarkers(two).map((m) => m.sec)).toEqual([1, 2.5]);
    const removed = removeMarker(two, timelineMarkers(two)[0].id);
    expect(timelineMarkers(removed).map((m) => m.sec)).toEqual([2.5]);
    expect(removeMarker(two, "missing")).toBe(two);
  });

  it("includes markers in the snap points", () => {
    const tl = toggleMarker(appendClip(createTimeline(), imageAsset)!.timeline, 2);
    expect(timelineSnapPoints(tl)).toEqual([0, 2, DEFAULT_STILL_SECONDS]);
  });

  it("snaps to the nearest point only within tolerance", () => {
    const points = [0, 5, 15];
    expect(snapTimeToPoints(4.8, points, 0.5)).toBe(5);
    expect(snapTimeToPoints(5.4, points, 0.5)).toBe(5);
    expect(snapTimeToPoints(7, points, 0.5)).toBe(7);
    expect(snapTimeToPoints(14.6, points, 0.5)).toBe(15);
  });

  it("splits a clip while preserving source continuity", () => {
    const r = appendClip(createTimeline(), videoAsset, { duration: 10 })!;
    const split = splitClip(r.timeline, r.clip.id, 4);
    expect(split).not.toBeNull();
    const clips = split!.timeline.tracks.find((t) => t.id === split!.trackId)!.clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ id: r.clip.id, start: 0, duration: 4, sourceStartSec: 0 });
    expect(clips[1]).toMatchObject({ start: 4, duration: 6, sourceStartSec: 4 });
    expect(splitClip(split!.timeline, clips[0].id, 0.01)).toBeNull();
  });
});
