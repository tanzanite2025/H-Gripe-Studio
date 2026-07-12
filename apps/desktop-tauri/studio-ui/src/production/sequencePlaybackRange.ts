// Sequence playback in/out points (Premiere-style mark in / mark out): a
// persisted, frame-snapped range on the timeline model that scopes loop
// playback and is rendered on the program monitor scrub bar and the timeline
// ruler. Pure functions over the immutable timeline model, mirroring
// `timeline.ts` conventions.

import { snapTimeToFrame, type TimelineModel } from "./timeline";

/** Persisted sequence in/out points, seconds (frame-snapped). Either side may
 * be unset; an inverted pair never persists (setting one side drops a
 * conflicting other side). */
export interface SequencePlaybackRange {
  inPointSec: number | null;
  outPointSec: number | null;
}

export function sequencePlaybackRangeOf(timeline: TimelineModel): SequencePlaybackRange {
  return timeline.playbackRange ?? { inPointSec: null, outPointSec: null };
}

/** Set the sequence in point at the given time (frame-snapped). An out point
 * at or before the new in point is dropped so the range stays forward. */
export function setSequencePlaybackInPointAtTime(
  timeline: TimelineModel,
  sec: number,
): TimelineModel {
  const inPointSec = snapTimeToFrame(Math.max(0, sec), timeline.fps);
  const current = sequencePlaybackRangeOf(timeline);
  const outPointSec =
    current.outPointSec != null && current.outPointSec <= inPointSec
      ? null
      : current.outPointSec;
  return { ...timeline, playbackRange: { inPointSec, outPointSec } };
}

/** Set the sequence out point at the given time (frame-snapped). An in point
 * at or after the new out point is dropped so the range stays forward. */
export function setSequencePlaybackOutPointAtTime(
  timeline: TimelineModel,
  sec: number,
): TimelineModel {
  const outPointSec = snapTimeToFrame(Math.max(0, sec), timeline.fps);
  const current = sequencePlaybackRangeOf(timeline);
  const inPointSec =
    current.inPointSec != null && current.inPointSec >= outPointSec
      ? null
      : current.inPointSec;
  return { ...timeline, playbackRange: { inPointSec, outPointSec } };
}

export function clearSequencePlaybackInPoint(timeline: TimelineModel): TimelineModel {
  const current = sequencePlaybackRangeOf(timeline);
  if (current.inPointSec == null) return timeline;
  return { ...timeline, playbackRange: { ...current, inPointSec: null } };
}

export function clearSequencePlaybackOutPoint(timeline: TimelineModel): TimelineModel {
  const current = sequencePlaybackRangeOf(timeline);
  if (current.outPointSec == null) return timeline;
  return { ...timeline, playbackRange: { ...current, outPointSec: null } };
}

/** The effective playback bounds: the in/out range when it is valid and
 * forward, otherwise the full `[0, durationSec]` timeline. */
export function resolveSequencePlaybackBounds(
  durationSec: number,
  range: SequencePlaybackRange,
): { startSec: number; endSec: number } {
  const clamp = (sec: number) => Math.max(0, Math.min(durationSec, sec));
  const startSec = clamp(range.inPointSec ?? 0);
  const endSec = clamp(range.outPointSec ?? durationSec);
  return startSec < endSec ? { startSec, endSec } : { startSec: 0, endSec: durationSec };
}
