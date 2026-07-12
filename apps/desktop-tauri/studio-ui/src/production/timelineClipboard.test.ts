import { describe, expect, it } from "vitest";

import {
  addTrack,
  appendClip,
  appendVideoWithAudio,
  createTimeline,
  findClip,
  removeClips,
  toggleTrackLock,
} from "./timeline";
import {
  copyTimelineClipsToClipboard,
  pasteCopiedTimelineClipsAtTime,
} from "./timelineClipboard";

const videoAsset = { id: "a-vid", kind: "video" as const };
const audioAsset = { id: "a-aud", kind: "audio" as const };

describe("timeline clipboard", () => {
  it("copies placement relative to the earliest clip and skips unknown ids", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 4, duration: 5 });
    const second = appendClip(first.timeline, videoAsset, { atSec: 12, duration: 3 });
    const copied = copyTimelineClipsToClipboard(second.timeline, [
      second.clip.id,
      first.clip.id,
      "missing",
    ]);
    expect(copied).toHaveLength(2);
    expect(copied.map((c) => c.offsetSecFromEarliestCopiedClip)).toEqual([8, 0]);
    expect(copyTimelineClipsToClipboard(second.timeline, ["missing"])).toEqual([]);
  });

  it("pastes at a frame-snapped time onto the source track with fresh ids", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const copied = copyTimelineClipsToClipboard(first.timeline, [first.clip.id]);
    const pasted = pasteCopiedTimelineClipsAtTime(first.timeline, copied, 10.017)!;
    expect(pasted.pastedClipIds).toHaveLength(1);
    const location = findClip(pasted.timeline, pasted.pastedClipIds[0])!;
    expect(location.track.id).toBe(first.trackId);
    expect(location.clip.start).toBe(10);
    expect(location.clip.id).not.toBe(first.clip.id);
    expect(location.clip.assetId).toBe(videoAsset.id);
    // The original clip is untouched.
    expect(findClip(pasted.timeline, first.clip.id)!.clip.start).toBe(0);
  });

  it("a paste survives deletion of the original clips", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const copied = copyTimelineClipsToClipboard(first.timeline, [first.clip.id]);
    const emptied = removeClips(first.timeline, [first.clip.id]);
    const pasted = pasteCopiedTimelineClipsAtTime(emptied, copied, 0)!;
    expect(findClip(pasted.timeline, pasted.pastedClipIds[0])!.clip.start).toBe(0);
  });

  it("keeps a linked A/V pair paired under a fresh link id", () => {
    const pair = appendVideoWithAudio(createTimeline(), videoAsset, { duration: 10 });
    const copied = copyTimelineClipsToClipboard(pair.timeline, [pair.video.id, pair.audio.id]);
    const pasted = pasteCopiedTimelineClipsAtTime(pair.timeline, copied, 20)!;
    const [pastedVideo, pastedAudio] = pasted.pastedClipIds.map(
      (id) => findClip(pasted.timeline, id)!.clip,
    );
    expect(pastedVideo.linkId).toBeDefined();
    expect(pastedVideo.linkId).toBe(pastedAudio.linkId);
    expect(pastedVideo.linkId).not.toBe(pair.video.linkId);
    expect(pastedVideo.start).toBe(20);
    expect(pastedAudio.start).toBe(20);
  });

  it("falls back to another compatible unlocked track when the source track is occupied", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const withSecondVideoTrack = addTrack(first.timeline, "video");
    const fallbackTrackId =
      withSecondVideoTrack.tracks[withSecondVideoTrack.tracks.length - 1].id;
    const copied = copyTimelineClipsToClipboard(withSecondVideoTrack, [first.clip.id]);
    // Pasting over the original's own position lands on the free second track.
    const pasted = pasteCopiedTimelineClipsAtTime(withSecondVideoTrack, copied, 2)!;
    expect(findClip(pasted.timeline, pasted.pastedClipIds[0])!.track.id).toBe(fallbackTrackId);
  });

  it("is atomic: returns null when any copied clip cannot fit anywhere", () => {
    const video = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const audio = appendClip(video.timeline, audioAsset, { atSec: 0, duration: 5 });
    const copied = copyTimelineClipsToClipboard(audio.timeline, [
      video.clip.id,
      audio.clip.id,
    ]);
    // Only one video and one audio track exist and both are occupied at 0.
    expect(pasteCopiedTimelineClipsAtTime(audio.timeline, copied, 0)).toBeNull();
    // An empty clipboard pastes nothing.
    expect(pasteCopiedTimelineClipsAtTime(audio.timeline, [], 10)).toBeNull();
  });

  it("skips locked tracks when choosing a paste target", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const copied = copyTimelineClipsToClipboard(first.timeline, [first.clip.id]);
    const locked = toggleTrackLock(first.timeline, first.trackId);
    expect(pasteCopiedTimelineClipsAtTime(locked, copied, 10)).toBeNull();
  });

  it("co-pasted clips on the same track cannot overlap each other", () => {
    const first = appendClip(createTimeline(), videoAsset, { atSec: 0, duration: 5 });
    const second = appendClip(first.timeline, videoAsset, { atSec: 5, duration: 5 });
    const copied = copyTimelineClipsToClipboard(second.timeline, [
      first.clip.id,
      second.clip.id,
    ]);
    const pasted = pasteCopiedTimelineClipsAtTime(second.timeline, copied, 20)!;
    const starts = pasted.pastedClipIds
      .map((id) => findClip(pasted.timeline, id)!.clip.start)
      .sort((a, b) => a - b);
    expect(starts).toEqual([20, 25]);
  });
});
