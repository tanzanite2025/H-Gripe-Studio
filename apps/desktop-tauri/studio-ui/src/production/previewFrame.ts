// Program-monitor frame resolution: which media the timeline shows at a
// playhead time. Pure functions over the timeline + media bin (like
// renderPlan) so the mapping is unit testable without React or the viewport
// host. The first video track is the program output — the same rule the
// render plan uses for export — so preview and export agree on what plays.

import type { MediaAsset } from "./mediaBin";
import type { TimelineModel } from "./timeline";

/** What the monitor should present at a playhead time. */
export type PreviewFrameTarget =
  | { kind: "still"; clipId: string; path: string }
  | {
      kind: "video";
      clipId: string;
      path: string;
      sourceTimeSec: number;
      /** Timeline start of the clip, for mapping between timeline and
       * clip-local time (playback frame-grid pacing). */
      clipStartSec: number;
      /** Source media in-point, seconds. */
      sourceStartSec: number;
    };

/**
 * Resolve the clip under `timeSec` on the first video track to its media.
 * Video clips map the playhead to clip-local source time (no in/out trim
 * yet). Gaps, audio-only regions, and missing assets resolve to `null`
 * (black frame).
 */
export function resolvePreviewFrame(
  timeline: TimelineModel,
  assets: MediaAsset[],
  timeSec: number,
): PreviewFrameTarget | null {
  const track = timeline.tracks.find((t) => t.kind === "video");
  if (!track) return null;
  // Later-starting clips win overlaps, matching their stacking in the lane.
  const clip = [...track.clips]
    .sort((a, b) => a.start - b.start)
    .filter((c) => timeSec >= c.start && timeSec < c.start + c.duration)
    .pop();
  if (!clip) return null;
  const asset = assets.find((a) => a.id === clip.assetId);
  if (!asset) return null;
  if (clip.kind === "video") {
    return {
      kind: "video",
      clipId: clip.id,
      path: asset.path,
      sourceTimeSec: Math.max(0, (clip.sourceStartSec ?? 0) + timeSec - clip.start),
      clipStartSec: clip.start,
      sourceStartSec: clip.sourceStartSec ?? 0,
    };
  }
  return { kind: "still", clipId: clip.id, path: asset.path };
}

/**
 * Snap a playhead time onto the source's frame grid for continuous playback
 * pacing: consecutive wall-clock ticks inside the same source frame yield
 * the same time, so the monitor requests (and the persistent hardware
 * session decodes) exactly one frame per source frame — presentation follows
 * the source fps instead of the request clock. Non-video targets and unknown
 * frame rates pass through unchanged.
 */
export function paceToFrameGrid(
  target: PreviewFrameTarget | null,
  timeSec: number,
  fps: number | null,
): number {
  if (!target || target.kind !== "video" || !fps || fps <= 0) return timeSec;
  const sourceTime = Math.max(0, target.sourceStartSec + timeSec - target.clipStartSec);
  const snappedSource = Math.floor(sourceTime * fps) / fps;
  return target.clipStartSec + Math.max(0, snappedSource - target.sourceStartSec);
}
