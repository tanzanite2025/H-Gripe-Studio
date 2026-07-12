import { describe, expect, it } from "vitest";

import { advancePlaybackTime, clampTimeToSequenceDuration } from "./programMonitorPlayback";

describe("program monitor playback helpers", () => {
  it("clamps the playhead into the sequence duration", () => {
    expect(clampTimeToSequenceDuration(-1, 10)).toBe(0);
    expect(clampTimeToSequenceDuration(4.5, 10)).toBe(4.5);
    expect(clampTimeToSequenceDuration(12, 10)).toBe(10);
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
