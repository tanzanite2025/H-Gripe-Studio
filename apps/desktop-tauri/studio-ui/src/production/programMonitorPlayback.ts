// Pure playback-time math for the program monitor: clamping the playhead and
// advancing the playhead wall-clock (with loop wrap-around). No React and no
// viewport bridge, so the monitor's timing behaviour is unit testable on its
// own. The loop range itself comes from `resolveSequencePlaybackBounds`.

/** Clamp a playhead time into the sequence's `[0, duration]` range. */
export function clampTimeToSequenceDuration(sec: number, duration: number): number {
  return Math.max(0, Math.min(duration, sec));
}

/**
 * Advance the playhead by the wall-clock time elapsed since the last tick.
 * Without looping, playback stops at the sequence end; with a valid loop
 * range it wraps back to the loop start, preserving the elapsed overflow.
 */
export function advancePlaybackTime({
  currentSec,
  elapsedSec,
  duration,
  loop,
  loopStartSec,
  loopEndSec,
}: {
  currentSec: number;
  elapsedSec: number;
  duration: number;
  loop: boolean;
  loopStartSec: number;
  loopEndSec: number;
}): { timeSec: number; playing: boolean } {
  if (duration <= 0) return { timeSec: 0, playing: false };
  if (!loop || loopEndSec <= loopStartSec) {
    const next = currentSec + elapsedSec;
    return next >= duration ? { timeSec: duration, playing: false } : { timeSec: next, playing: true };
  }
  const base = currentSec < loopStartSec || currentSec >= loopEndSec ? loopStartSec : currentSec;
  const next = base + elapsedSec;
  if (next < loopEndSec) return { timeSec: next, playing: true };
  const span = loopEndSec - loopStartSec;
  return { timeSec: loopStartSec + ((next - loopEndSec) % span), playing: true };
}
