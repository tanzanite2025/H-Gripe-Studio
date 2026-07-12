import { describe, expect, it } from "vitest";

import {
  clearSequencePlaybackInPoint,
  clearSequencePlaybackOutPoint,
  resolveSequencePlaybackBounds,
  sequencePlaybackRangeOf,
  setSequencePlaybackInPointAtTime,
  setSequencePlaybackOutPointAtTime,
} from "./sequencePlaybackRange";
import { createTimeline } from "./timeline";

describe("sequence playback range", () => {
  it("defaults to an unset range on models without one", () => {
    expect(sequencePlaybackRangeOf(createTimeline())).toEqual({
      inPointSec: null,
      outPointSec: null,
    });
  });

  it("frame-snaps the in point to the timeline fps", () => {
    const next = setSequencePlaybackInPointAtTime(createTimeline(), 1.02);
    // 1.02s at 24fps rounds to frame 24 → 1.0s.
    expect(next.playbackRange).toEqual({ inPointSec: 1, outPointSec: null });
  });

  it("drops an out point at or before a newly set in point", () => {
    let timeline = setSequencePlaybackOutPointAtTime(createTimeline(), 2);
    timeline = setSequencePlaybackInPointAtTime(timeline, 3);
    expect(timeline.playbackRange).toEqual({ inPointSec: 3, outPointSec: null });
  });

  it("drops an in point at or after a newly set out point", () => {
    let timeline = setSequencePlaybackInPointAtTime(createTimeline(), 5);
    timeline = setSequencePlaybackOutPointAtTime(timeline, 2);
    expect(timeline.playbackRange).toEqual({ inPointSec: null, outPointSec: 2 });
  });

  it("keeps a forward range when both points are set", () => {
    let timeline = setSequencePlaybackInPointAtTime(createTimeline(), 1);
    timeline = setSequencePlaybackOutPointAtTime(timeline, 4);
    expect(timeline.playbackRange).toEqual({ inPointSec: 1, outPointSec: 4 });
  });

  it("clears each side independently and no-ops when already unset", () => {
    let timeline = setSequencePlaybackInPointAtTime(createTimeline(), 1);
    timeline = setSequencePlaybackOutPointAtTime(timeline, 4);
    const inCleared = clearSequencePlaybackInPoint(timeline);
    expect(inCleared.playbackRange).toEqual({ inPointSec: null, outPointSec: 4 });
    const outCleared = clearSequencePlaybackOutPoint(timeline);
    expect(outCleared.playbackRange).toEqual({ inPointSec: 1, outPointSec: null });
    const untouched = createTimeline();
    expect(clearSequencePlaybackInPoint(untouched)).toBe(untouched);
    expect(clearSequencePlaybackOutPoint(untouched)).toBe(untouched);
  });

  it("resolves valid in/out points as the playback bounds", () => {
    expect(resolveSequencePlaybackBounds(10, { inPointSec: 2, outPointSec: 8 })).toEqual({
      startSec: 2,
      endSec: 8,
    });
  });

  it("falls back to the full timeline for an inverted or empty range", () => {
    expect(resolveSequencePlaybackBounds(10, { inPointSec: 8, outPointSec: 2 })).toEqual({
      startSec: 0,
      endSec: 10,
    });
    expect(resolveSequencePlaybackBounds(10, { inPointSec: null, outPointSec: null })).toEqual({
      startSec: 0,
      endSec: 10,
    });
  });

  it("clamps points beyond the timeline duration", () => {
    expect(resolveSequencePlaybackBounds(10, { inPointSec: 2, outPointSec: 15 })).toEqual({
      startSec: 2,
      endSec: 10,
    });
  });
});
