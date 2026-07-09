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
  /** Source media in-point, seconds. Used by razor splits and trims. */
  sourceStartSec: number;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  clips: TimelineClip[];
}

export interface TimelineModel {
  id: string;
  /** Project timeline timebase. Razor, ruler and playhead snap to this fps. */
  fps: number;
  tracks: TimelineTrack[];
}

/** Default clip lengths until real media durations are probed. */
export const DEFAULT_TIMELINE_FPS = 24;
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

export function secondsToFrame(sec: number, fps: number = DEFAULT_TIMELINE_FPS): number {
  return Math.round(Math.max(0, sec) * Math.max(1, fps));
}

export function frameToSeconds(frame: number, fps: number = DEFAULT_TIMELINE_FPS): number {
  return Math.max(0, frame) / Math.max(1, fps);
}

export function snapTimeToFrame(sec: number, fps: number = DEFAULT_TIMELINE_FPS): number {
  return frameToSeconds(secondsToFrame(sec, fps), fps);
}

/** One video track and one audio track; more can be added on demand. */
export function createTimeline(): TimelineModel {
  return {
    id: freshId("timeline"),
    fps: DEFAULT_TIMELINE_FPS,
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

/** Remove a track (and its clips); the last remaining track stays. */
export function removeTrack(timeline: TimelineModel, trackId: string): TimelineModel {
  if (timeline.tracks.length <= 1) return timeline;
  if (!timeline.tracks.some((t) => t.id === trackId)) return timeline;
  return { ...timeline, tracks: timeline.tracks.filter((t) => t.id !== trackId) };
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
    sourceStartSec: 0,
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

export interface SplitClipResult {
  timeline: TimelineModel;
  trackId: string;
  left: TimelineClip;
  right: TimelineClip;
}

/** Razor split: cut one clip at a timeline time, preserving source continuity. */
export function splitClip(timeline: TimelineModel, clipId: string, atSec: number): SplitClipResult | null {
  const snappedAtSec = snapTimeToFrame(atSec, timeline.fps ?? DEFAULT_TIMELINE_FPS);
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index < 0) continue;
    const clip = track.clips[index];
    const offset = snappedAtSec - clip.start;
    const leftDuration = offset;
    const rightDuration = clip.duration - offset;
    if (leftDuration < MIN_CLIP_SECONDS || rightDuration < MIN_CLIP_SECONDS) return null;
    const left: TimelineClip = {
      ...clip,
      duration: leftDuration,
    };
    const right: TimelineClip = {
      ...clip,
      id: freshId("clip"),
      start: snappedAtSec,
      duration: rightDuration,
      sourceStartSec: (clip.sourceStartSec ?? 0) + offset,
    };
    return {
      trackId: track.id,
      left,
      right,
      timeline: {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.id === track.id
            ? { ...t, clips: [...t.clips.slice(0, index), left, right, ...t.clips.slice(index + 1)] }
            : t,
        ),
      },
    };
  }
  return null;
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

/** Sorted unique snap points: timeline start plus every clip edge. */
export function timelineSnapPoints(timeline: TimelineModel): number[] {
  const points = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      points.add(clip.start);
      points.add(clip.start + clip.duration);
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** Nearest snap point within tolerance, else the original time. */
export function snapTimeToPoints(sec: number, points: number[], toleranceSec: number): number {
  let best = sec;
  let bestDist = toleranceSec;
  for (const point of points) {
    const dist = Math.abs(point - sec);
    if (dist <= bestDist) {
      bestDist = dist;
      best = point;
    }
  }
  return best;
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
