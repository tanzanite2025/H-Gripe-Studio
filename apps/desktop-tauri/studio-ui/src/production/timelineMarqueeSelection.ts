// Marquee (box) selection: pure resolution of which timeline clips fall
// inside a dragged selection rectangle, expressed as a time range plus the
// set of tracks the rectangle vertically crosses.

import type { TimelineModel } from "./timeline";

/** The horizontal extent of a marquee drag, in timeline seconds. The two
 * bounds may arrive in either order (the drag can move leftwards). */
export interface MarqueeSelectionTimeRange {
  startSec: number;
  endSec: number;
}

/**
 * Clip ids on the given tracks whose `[start, start + duration)` interval
 * overlaps the marquee time range. Locked tracks are excluded so a marquee
 * never selects clips that cannot be edited. Results follow track order.
 */
export function clipIdsIntersectingMarqueeSelection(
  timeline: TimelineModel,
  marqueeCrossedTrackIds: readonly string[],
  timeRange: MarqueeSelectionTimeRange,
): string[] {
  const rangeStartSec = Math.min(timeRange.startSec, timeRange.endSec);
  const rangeEndSec = Math.max(timeRange.startSec, timeRange.endSec);
  const crossedTrackIds = new Set(marqueeCrossedTrackIds);
  const clipIds: string[] = [];
  for (const track of timeline.tracks) {
    if (!crossedTrackIds.has(track.id) || track.locked) continue;
    for (const clip of track.clips) {
      if (clip.start < rangeEndSec && clip.start + clip.duration > rangeStartSec) {
        clipIds.push(clip.id);
      }
    }
  }
  return clipIds;
}
