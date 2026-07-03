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
  timelineDuration,
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
    const tl = { id: "t", tracks: [] };
    expect(appendClip(tl, imageAsset)).toBeNull();
  });

  it("adds tracks on demand", () => {
    const tl = addTrack(createTimeline(), "video");
    expect(tl.tracks.filter((t) => t.kind === "video")).toHaveLength(2);
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
});
