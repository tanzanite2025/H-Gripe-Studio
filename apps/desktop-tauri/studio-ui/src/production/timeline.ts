// Minimal multi-track timeline model (UNIFIED_PRODUCTION_DRAWER_PLAN.md step
// 4): video tracks hold image still clips and video clips, audio tracks hold
// audio clips. Clips reference media-bin assets — never file copies. Pure
// functions over an immutable model so placement / trim / removal are unit
// testable without React; playhead, snapping, keyframes and the render plan
// come in later steps.

import type { MediaAssetKind } from "./mediaBin";

export type TrackKind = "video" | "audio";
export type ClipKind = "still" | "video" | "audio";

export interface TimelineClip {
  id: string;
  kind: ClipKind;
  /** Media-bin asset this clip references. */
  assetId: string;
  /** Track-local start time, seconds. */
  start: number;
  /** Clip length, seconds (always > 0). */
  duration: number;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  clips: TimelineClip[];
}

export interface TimelineModel {
  id: string;
  tracks: TimelineTrack[];
}

/** Default clip lengths until real media durations are probed. */
export const DEFAULT_STILL_SECONDS = 5;
export const DEFAULT_MEDIA_SECONDS = 10;
export const MIN_CLIP_SECONDS = 0.1;

let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

export function clipKindForAsset(kind: MediaAssetKind): ClipKind {
  return kind === "image" ? "still" : kind === "video" ? "video" : "audio";
}

export function trackKindForClip(kind: ClipKind): TrackKind {
  return kind === "audio" ? "audio" : "video";
}

export function defaultClipDuration(kind: ClipKind): number {
  return kind === "still" ? DEFAULT_STILL_SECONDS : DEFAULT_MEDIA_SECONDS;
}

/** One video track and one audio track; more can be added on demand. */
export function createTimeline(): TimelineModel {
  return {
    id: freshId("timeline"),
    tracks: [
      { id: freshId("track-v"), kind: "video", clips: [] },
      { id: freshId("track-a"), kind: "audio", clips: [] },
    ],
  };
}

export function addTrack(timeline: TimelineModel, kind: TrackKind): TimelineModel {
  return {
    ...timeline,
    tracks: [...timeline.tracks, { id: freshId(kind === "video" ? "track-v" : "track-a"), kind, clips: [] }],
  };
}

export function trackEnd(track: TimelineTrack): number {
  return track.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
}

export function timelineDuration(timeline: TimelineModel): number {
  return timeline.tracks.reduce((end, t) => Math.max(end, trackEnd(t)), 0);
}

export interface AppendClipResult {
  timeline: TimelineModel;
  clip: TimelineClip;
  trackId: string;
}

/**
 * Append an asset as a clip at the end of a compatible track (the given track
 * when provided and compatible, else the first compatible one). Returns the
 * model unchanged when no compatible track exists.
 */
export function appendClip(
  timeline: TimelineModel,
  asset: { id: string; kind: MediaAssetKind },
  opts: { trackId?: string; duration?: number } = {},
): AppendClipResult | null {
  const clipKind = clipKindForAsset(asset.kind);
  const wantTrackKind = trackKindForClip(clipKind);
  const requested = opts.trackId ? timeline.tracks.find((t) => t.id === opts.trackId) : undefined;
  const track =
    requested && requested.kind === wantTrackKind
      ? requested
      : timeline.tracks.find((t) => t.kind === wantTrackKind);
  if (!track) return null;
  const clip: TimelineClip = {
    id: freshId("clip"),
    kind: clipKind,
    assetId: asset.id,
    start: trackEnd(track),
    duration: Math.max(MIN_CLIP_SECONDS, opts.duration ?? defaultClipDuration(clipKind)),
  };
  return {
    timeline: {
      ...timeline,
      tracks: timeline.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t)),
    },
    clip,
    trackId: track.id,
  };
}

export function findClip(
  timeline: TimelineModel,
  clipId: string,
): { track: TimelineTrack; clip: TimelineClip } | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function removeClip(timeline: TimelineModel, clipId: string): TimelineModel {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t,
    ),
  };
}

/** Remove every clip referencing the given asset (asset deleted from the bin). */
export function removeClipsForAsset(timeline: TimelineModel, assetId: string): TimelineModel {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.clips.some((c) => c.assetId === assetId)
        ? { ...t, clips: t.clips.filter((c) => c.assetId !== assetId) }
        : t,
    ),
  };
}

/** Non-ripple trim: clamps start >= 0 and duration >= MIN_CLIP_SECONDS. */
export function trimClip(
  timeline: TimelineModel,
  clipId: string,
  patch: { start?: number; duration?: number },
): TimelineModel {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        c.id === clipId
          ? {
              ...c,
              start: Math.max(0, patch.start ?? c.start),
              duration: Math.max(MIN_CLIP_SECONDS, patch.duration ?? c.duration),
            }
          : c,
      ),
    })),
  };
}
