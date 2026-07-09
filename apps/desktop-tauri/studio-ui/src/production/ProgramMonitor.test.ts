import { describe, expect, it } from "vitest";

import { advancePlaybackTime, resolveLoopPlaybackRange } from "./ProgramMonitor";

describe("ProgramMonitor playback helpers", () => {
  it("uses valid in/out points as the loop range", () => {
    expect(resolveLoopPlaybackRange(10, 2, 8)).toEqual({ start: 2, end: 8 });
  });

  it("falls back to the full timeline for an invalid loop range", () => {
    expect(resolveLoopPlaybackRange(10, 8, 2)).toEqual({ start: 0, end: 10 });
  });

  it("stops at the end when looping is disabled", () => {
    expect(
      advancePlaybackTime({
        currentSec: 9.8,
        elapsedSec: 0.5,
        duration: 10,
        loop: false,
        loopStartSec: 0,
        loopEndSec: 10,
      }),
    ).toEqual({ timeSec: 10, playing: false });
  });

  it("wraps to the loop start while preserving elapsed overflow", () => {
    const result = advancePlaybackTime({
      currentSec: 7.8,
      elapsedSec: 0.5,
      duration: 10,
      loop: true,
      loopStartSec: 2,
      loopEndSec: 8,
    });
    expect(result.playing).toBe(true);
    expect(result.timeSec).toBeCloseTo(2.3);
  });
});
