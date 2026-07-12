import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_SECONDS,
  DEFAULT_STILL_SECONDS,
  MIN_CLIP_SECONDS,
  addTrack,
  appendClip,
  appendVideoWithAudio,
  clipKindForAsset,
  createTimeline,
  findClip,
  moveClipWithLinkedPartner,
  removeClip,
  removeClipsForAsset,
  removeMarker,
  removeTrack,
  snapTimeToPoints,
  splitClip,
  timelineMarkers,
  toggleMarker,
  toggleTrackHidden,
  toggleTrackLock,
  timelineDuration,
  timelineSnapPoints,
  trackKindForClip,
  trimClip,
  trimClipEdgeWithLinkedPartner,
} from "./timeline";

const imageAsset = { id: "a-img", kind: "image" as const };
const videoAsset = { id: "a-vid", kind: "video" as const };
const audioAsset = { id: "a-aud", kind: "audio" as const };

describe("timeline model", () => {
  it("maps asset kinds to clip kinds and clip kinds to track kinds", () => {
    expect(clipKindForAsset("image")).toBe("still");
    expect(clipKindForAsset("video")).toBe("video");
    expect(clipKindForAsset("audio")).toBe("audio");
    expect(trackKindForClip("still")).toBe("image");
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
    // Stills route to an image track, auto-created on first drop.
    const first = appendClip(tl, imageAsset);
    expect(first.clip.kind).toBe("still");
    expect(first.clip.start).toBe(0);
    expect(first.clip.duration).toBe(DEFAULT_STILL_SECONDS);
    expect(first.clip.sourceStartSec).toBe(0);
    expect(findClip(first.timeline, first.clip.id)!.track.kind).toBe("image");
    const second = appendClip(first.timeline, videoAsset);
    expect(second.trackId).not.toBe(first.trackId);
    expect(findClip(second.timeline, second.clip.id)!.track.kind).toBe("video");
    expect(second.clip.start).toBe(0);
    expect(second.clip.duration).toBe(DEFAULT_MEDIA_SECONDS);
    const nextVideo = appendClip(second.timeline, videoAsset);
    expect(nextVideo.trackId).toBe(second.trackId);
    expect(nextVideo.clip.start).toBe(DEFAULT_MEDIA_SECONDS);
    const audio = appendClip(nextVideo.timeline, audioAsset);
    expect(audio.trackId).not.toBe(nextVideo.trackId);
    expect(audio.clip.start).toBe(0);
    expect(timelineDuration(audio.timeline)).toBe(2 * DEFAULT_MEDIA_SECONDS);
  });

  it("places a video asset as linked video + audio clips at the same start", () => {
    const tl = createTimeline();
    const first = appendVideoWithAudio(tl, videoAsset);
    expect(findClip(first.timeline, first.video.id)!.track.kind).toBe("video");
    expect(findClip(first.timeline, first.audio.id)!.track.kind).toBe("audio");
    expect(first.video.start).toBe(0);
    expect(first.audio.start).toBe(0);
    expect(first.audio.duration).toBe(first.video.duration);
    expect(first.audio.assetId).toBe(videoAsset.id);
    // A second drop lands past the end of both tracks, keeping A/V in sync.
    const second = appendVideoWithAudio(first.timeline, videoAsset);
    expect(second.video.start).toBe(DEFAULT_MEDIA_SECONDS);
    expect(second.audio.start).toBe(DEFAULT_MEDIA_SECONDS);
  });

  it("auto-creates the audio track for a video drop when none is available", () => {
    const tl = { id: "t", fps: 24, tracks: [] };
    const r = appendVideoWithAudio(tl, videoAsset);
    expect(r.timeline.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(findClip(r.timeline, r.video.id)!.track.id).toBe(r.videoTrackId);
    expect(findClip(r.timeline, r.audio.id)!.track.id).toBe(r.audioTrackId);
  });

  it("routes an incompatible requested track to a compatible one", () => {
    const tl = createTimeline();
    const audioTrack = tl.tracks.find((t) => t.kind === "audio")!;
    const r = appendClip(tl, videoAsset, { trackId: audioTrack.id });
    expect(r.trackId).not.toBe(audioTrack.id);
    expect(findClip(r.timeline, r.clip.id)!.track.kind).toBe("video");
  });

  it("auto-creates a track of the right kind when none exists", () => {
    const tl = { id: "t", fps: 24, tracks: [] };
    const r = appendClip(tl, imageAsset);
    expect(r.timeline.tracks).toHaveLength(1);
    expect(r.timeline.tracks[0].kind).toBe("image");
    expect(findClip(r.timeline, r.clip.id)!.track.id).toBe(r.trackId);
  });

  it("adds tracks on demand", () => {
    const tl = addTrack(createTimeline(), "video");
    expect(tl.tracks.filter((t) => t.kind === "video")).toHaveLength(2);
  });

  it("removes a track with its clips but keeps the last track", () => {
    const withClip = appendClip(createTimeline(), imageAsset);
    const removed = removeTrack(withClip.timeline, withClip.trackId);
    expect(removed.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(findClip(removed, withClip.clip.id)).toBeNull();
    const one = removeTrack(removed, removed.tracks[0].id);
    const last = removeTrack(one, one.tracks[0].id);
    expect(last).toBe(one);
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
    const a = appendClip(createTimeline(), imageAsset);
    const b = appendClip(a.timeline, videoAsset);
    const c = appendClip(b.timeline, audioAsset, { duration: 5 })!;
    expect(timelineSnapPoints(c.timeline)).toEqual([0, DEFAULT_STILL_SECONDS, DEFAULT_MEDIA_SECONDS]);
  });

  it("toggles track lock / hidden flags", () => {
    const tl = createTimeline();
    const video = tl.tracks[0];
    const locked = toggleTrackLock(tl, video.id);
    expect(locked.tracks[0].locked).toBe(true);
    expect(toggleTrackLock(locked, video.id).tracks[0].locked).toBe(false);
    const hidden = toggleTrackHidden(tl, video.id);
    expect(hidden.tracks[0].hidden).toBe(true);
    expect(toggleTrackLock(tl, "missing")).toBe(tl);
    expect(toggleTrackHidden(tl, "missing")).toBe(tl);
  });

  it("never appends clips onto a locked track", () => {
    const tl = createTimeline();
    const video = tl.tracks.find((t) => t.kind === "video")!;
    const locked = toggleTrackLock(tl, video.id);
    // The only video track is locked: a new video track is auto-created.
    const autod = appendClip(locked, videoAsset);
    expect(autod.trackId).not.toBe(video.id);
    expect(findClip(autod.timeline, autod.clip.id)!.track.kind).toBe("video");
    // A second unlocked video track picks up the clip instead.
    const twoTracks = addTrack(locked, "video");
    const r = appendClip(twoTracks, videoAsset, { trackId: video.id });
    expect(r.trackId).not.toBe(video.id);
    expect(r.timeline.tracks).toHaveLength(twoTracks.tracks.length);
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

  it("places a clip at the requested drop time, pushing past overlaps", () => {
    const tl = createTimeline();
    const first = appendClip(tl, videoAsset, { atSec: 3, duration: 10 });
    expect(first.clip.start).toBe(3);
    // Dropping into the occupied span lands just past the blocking clip.
    const second = appendClip(first.timeline, videoAsset, { atSec: 5, duration: 10 });
    expect(second.clip.start).toBe(13);
    // A free gap before the first clip is used as-is.
    const third = appendClip(second.timeline, videoAsset, { atSec: 0, duration: 2 });
    expect(third.clip.start).toBe(0);
  });

  it("places a video pair at the drop time, keeping both starts aligned", () => {
    const tl = createTimeline();
    const first = appendVideoWithAudio(tl, videoAsset, { atSec: 2, duration: 5 });
    expect(first.video.start).toBe(2);
    expect(first.audio.start).toBe(2);
    // Occupancy on either track pushes both clips to a shared free spot.
    const blockedAudio = appendClip(first.timeline, audioAsset, { atSec: 7, duration: 4 });
    const second = appendVideoWithAudio(blockedAudio.timeline, videoAsset, { atSec: 7, duration: 5 });
    expect(second.video.start).toBe(11);
    expect(second.audio.start).toBe(11);
  });

  it("links the A/V pair: deleting one clip removes the other", () => {
    const r = appendVideoWithAudio(createTimeline(), videoAsset);
    expect(r.video.linkId).toBeDefined();
    expect(r.audio.linkId).toBe(r.video.linkId);
    const withoutVideo = removeClip(r.timeline, r.video.id);
    expect(findClip(withoutVideo, r.audio.id)).toBeNull();
    const withoutAudio = removeClip(r.timeline, r.audio.id);
    expect(findClip(withoutAudio, r.video.id)).toBeNull();
  });

  it("unlinked clips delete alone", () => {
    const r = appendClip(createTimeline(), videoAsset);
    expect(r.clip.linkId).toBeUndefined();
    expect(findClip(removeClip(r.timeline, r.clip.id), r.clip.id)).toBeNull();
  });

  it("razor-splitting one half of an A/V pair splits the other too", () => {
    const r = appendVideoWithAudio(createTimeline(), videoAsset, { duration: 10 });
    const split = splitClip(r.timeline, r.video.id, 4)!;
    const videoClips = split.timeline.tracks.find((t) => t.kind === "video")!.clips;
    const audioClips = split.timeline.tracks.find((t) => t.kind === "audio")!.clips;
    expect(videoClips).toHaveLength(2);
    expect(audioClips).toHaveLength(2);
    expect(audioClips[0]).toMatchObject({ start: 0, duration: 4, sourceStartSec: 0 });
    expect(audioClips[1]).toMatchObject({ start: 4, duration: 6, sourceStartSec: 4 });
    // Left halves keep the original link; right halves share a fresh one.
    expect(videoClips[0].linkId).toBe(audioClips[0].linkId);
    expect(videoClips[1].linkId).toBe(audioClips[1].linkId);
    expect(videoClips[1].linkId).not.toBe(videoClips[0].linkId);
    // Deleting a right half takes its partner with it, leaving the left pair.
    const cleaned = removeClip(split.timeline, videoClips[1].id);
    expect(findClip(cleaned, audioClips[1].id)).toBeNull();
    expect(findClip(cleaned, videoClips[0].id)).not.toBeNull();
    expect(findClip(cleaned, audioClips[0].id)).not.toBeNull();
  });

  it("uses the provided duration for the A/V pair", () => {
    const r = appendVideoWithAudio(createTimeline(), videoAsset, { duration: 42.5 });
    expect(r.video.duration).toBe(42.5);
    expect(r.audio.duration).toBe(42.5);
  });

  it("moves a clip to a frame-snapped start within its track", () => {
    const r = appendClip(createTimeline(), videoAsset, { duration: 10 });
    const moved = moveClipWithLinkedPartner(r.timeline, r.clip.id, 3.017)!;
    expect(moved.movedToStartSec).toBe(3);
    expect(findClip(moved.timeline, r.clip.id)!.clip.start).toBe(3);
    expect(moveClipWithLinkedPartner(r.timeline, "missing", 1)).toBeNull();
  });

  it("clamps a move so the clip never overlaps neighbors or starts before 0", () => {
    const first = appendClip(createTimeline(), videoAsset, { duration: 10 });
    const second = appendClip(first.timeline, videoAsset, { atSec: 20, duration: 5 });
    // Dragging the second clip into the first stops flush against its end.
    const intoFirst = moveClipWithLinkedPartner(second.timeline, second.clip.id, 7)!;
    expect(intoFirst.movedToStartSec).toBe(10);
    // Dragging the first clip left of 0 clamps to 0.
    const beforeZero = moveClipWithLinkedPartner(second.timeline, first.clip.id, -4)!;
    expect(beforeZero.movedToStartSec).toBe(0);
  });

  it("moves a linked A/V pair together, constrained by both tracks", () => {
    const pair = appendVideoWithAudio(createTimeline(), videoAsset, { duration: 10 });
    const blocked = appendClip(pair.timeline, audioAsset, { atSec: 15, duration: 5 });
    // The audio-track blocker at 15..20 stops the pair at 5 even though the
    // video track is free.
    const moved = moveClipWithLinkedPartner(blocked.timeline, pair.video.id, 8)!;
    expect(moved.movedToStartSec).toBe(5);
    expect(findClip(moved.timeline, pair.video.id)!.clip.start).toBe(5);
    expect(findClip(moved.timeline, pair.audio.id)!.clip.start).toBe(5);
    // Past the blocker both clips land at the requested start.
    const past = moveClipWithLinkedPartner(blocked.timeline, pair.audio.id, 25)!;
    expect(past.movedToStartSec).toBe(25);
    expect(findClip(past.timeline, pair.video.id)!.clip.start).toBe(25);
    expect(findClip(past.timeline, pair.audio.id)!.clip.start).toBe(25);
  });

  it("trims the end edge, clamped to MIN_CLIP_SECONDS and the next neighbor", () => {
    const first = appendClip(createTimeline(), videoAsset, { duration: 10 });
    const second = appendClip(first.timeline, videoAsset, { atSec: 12, duration: 5 });
    const shortened = trimClipEdgeWithLinkedPartner(second.timeline, first.clip.id, "end", 6)!;
    expect(findClip(shortened.timeline, first.clip.id)!.clip).toMatchObject({
      start: 0,
      duration: 6,
      sourceStartSec: 0,
    });
    // Extending right stops at the next clip's start.
    const extended = trimClipEdgeWithLinkedPartner(second.timeline, first.clip.id, "end", 30)!;
    expect(extended.trimmedToSec).toBe(12);
    // Collapsing left stops at MIN_CLIP_SECONDS.
    const collapsed = trimClipEdgeWithLinkedPartner(second.timeline, first.clip.id, "end", 0)!;
    expect(findClip(collapsed.timeline, first.clip.id)!.clip.duration).toBeCloseTo(
      MIN_CLIP_SECONDS,
      5,
    );
    expect(trimClipEdgeWithLinkedPartner(second.timeline, "missing", "end", 3)).toBeNull();
  });

  it("trims the start edge while preserving source continuity", () => {
    const r = appendClip(createTimeline(), videoAsset, { atSec: 2, duration: 10 });
    const trimmed = trimClipEdgeWithLinkedPartner(r.timeline, r.clip.id, "start", 5)!;
    expect(findClip(trimmed.timeline, r.clip.id)!.clip).toMatchObject({
      start: 5,
      duration: 7,
      sourceStartSec: 3,
    });
    // Dragging the start back left restores the hidden head, but a media clip
    // never extends before its source in-point (sourceStartSec 0 => start 2).
    const restored = trimClipEdgeWithLinkedPartner(trimmed.timeline, r.clip.id, "start", 0)!;
    expect(restored.trimmedToSec).toBe(2);
    expect(findClip(restored.timeline, r.clip.id)!.clip).toMatchObject({
      start: 2,
      duration: 10,
      sourceStartSec: 0,
    });
  });

  it("lets a still clip extend freely left and right", () => {
    const r = appendClip(createTimeline(), imageAsset, { atSec: 5, duration: 5 });
    const widened = trimClipEdgeWithLinkedPartner(r.timeline, r.clip.id, "start", 1)!;
    expect(findClip(widened.timeline, r.clip.id)!.clip).toMatchObject({
      start: 1,
      duration: 9,
      sourceStartSec: 0,
    });
    const extended = trimClipEdgeWithLinkedPartner(widened.timeline, r.clip.id, "end", 20)!;
    expect(findClip(extended.timeline, r.clip.id)!.clip.duration).toBe(19);
  });

  it("trims a linked A/V pair's matching edges together", () => {
    const pair = appendVideoWithAudio(createTimeline(), videoAsset, { duration: 10 });
    const trimmed = trimClipEdgeWithLinkedPartner(pair.timeline, pair.video.id, "start", 4)!;
    expect(findClip(trimmed.timeline, pair.video.id)!.clip).toMatchObject({
      start: 4,
      duration: 6,
      sourceStartSec: 4,
    });
    expect(findClip(trimmed.timeline, pair.audio.id)!.clip).toMatchObject({
      start: 4,
      duration: 6,
      sourceStartSec: 4,
    });
    // A blocker behind the audio partner constrains the shared end trim.
    const blocked = appendClip(trimmed.timeline, audioAsset, { atSec: 12, duration: 3 });
    const extended = trimClipEdgeWithLinkedPartner(blocked.timeline, pair.video.id, "end", 20)!;
    expect(extended.trimmedToSec).toBe(12);
    expect(findClip(extended.timeline, pair.audio.id)!.clip.duration).toBe(8);
  });
});
