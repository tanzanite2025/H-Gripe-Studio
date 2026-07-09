// Minimal multi-track timeline model (UNIFIED_PRODUCTION_DRAWER_PLAN.md step
// 4): video tracks hold image still clips and video clips, audio tracks hold
// audio clips. Clips reference media-bin assets — never file copies. Pure
// functions over an immutable model so placement / trim / removal are unit
// testable without React; playhead, snapping, keyframes and the render plan
// come in later steps.

import type { MediaAssetKind } from "./mediaBin";

export type TrackKind = "video" | "audio" | "image";
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
  /** Locked tracks reject drops, razor cuts and clip edits. */
  locked?: boolean;
  /** Hidden (video) / muted (audio) tracks are dimmed and excluded from output. */
  hidden?: boolean;
}

/** Sequence marker: a named point on the timeline ruler. */
export interface TimelineMarker {
  id: string;
  /** Marker position, seconds (frame-snapped). */
  sec: number;
}

export interface TimelineModel {
  id: string;
  /** Project timeline timebase. Razor, ruler and playhead snap to this fps. */
  fps: number;
  tracks: TimelineTrack[];
  /** Sequence markers, kept sorted by time. Absent on older models. */
  markers?: TimelineMarker[];
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

/** Strict routing: stills only on image tracks, video only on video tracks. */
export function trackKindForClip(kind: ClipKind): TrackKind {
  return kind === "audio" ? "audio" : kind === "still" ? "image" : "video";
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
    tracks: [
      ...timeline.tracks,
      { id: freshId(kind === "video" ? "track-v" : kind === "audio" ? "track-a" : "track-i"), kind, clips: [] },
    ],
  };
}

/** Remove a track (and its clips); the last remaining track stays. */
export function removeTrack(timeline: TimelineModel, trackId: string): TimelineModel {
  if (timeline.tracks.length <= 1) return timeline;
  if (!timeline.tracks.some((t) => t.id === trackId)) return timeline;
  return { ...timeline, tracks: timeline.tracks.filter((t) => t.id !== trackId) };
}

export function toggleTrackLock(timeline: TimelineModel, trackId: string): TimelineModel {
  if (!timeline.tracks.some((t) => t.id === trackId)) return timeline;
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, locked: !t.locked } : t)),
  };
}

export function toggleTrackHidden(timeline: TimelineModel, trackId: string): TimelineModel {
  if (!timeline.tracks.some((t) => t.id === trackId)) return timeline;
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, hidden: !t.hidden } : t)),
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
 * when provided and compatible, else the first compatible unlocked one).
 * Premiere-style auto-routing: when no unlocked compatible track exists (none
 * of the kind, or all locked), a new track of the right kind is created.
 */
export function appendClip(
  timeline: TimelineModel,
  asset: { id: string; kind: MediaAssetKind },
  opts: { trackId?: string; duration?: number } = {},
): AppendClipResult {
  const clipKind = clipKindForAsset(asset.kind);
  const wantTrackKind = trackKindForClip(clipKind);
  const requested = opts.trackId ? timeline.tracks.find((t) => t.id === opts.trackId) : undefined;
  let base = timeline;
  let track =
    requested && requested.kind === wantTrackKind && !requested.locked
      ? requested
      : timeline.tracks.find((t) => t.kind === wantTrackKind && !t.locked);
  if (!track) {
    base = addTrack(timeline, wantTrackKind);
    track = base.tracks[base.tracks.length - 1];
  }
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
      ...base,
      tracks: base.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t)),
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

export function timelineMarkers(timeline: TimelineModel): TimelineMarker[] {
  return timeline.markers ?? [];
}

/** Add a marker at the frame-snapped time; a second toggle at the same frame
 * removes it (Premiere's M-key add / clear pattern). */
export function toggleMarker(timeline: TimelineModel, sec: number): TimelineModel {
  const fps = timeline.fps ?? DEFAULT_TIMELINE_FPS;
  const frame = secondsToFrame(sec, fps);
  const markers = timelineMarkers(timeline);
  const existing = markers.find((m) => secondsToFrame(m.sec, fps) === frame);
  if (existing) return { ...timeline, markers: markers.filter((m) => m.id !== existing.id) };
  const marker: TimelineMarker = { id: freshId("marker"), sec: frameToSeconds(frame, fps) };
  return { ...timeline, markers: [...markers, marker].sort((a, b) => a.sec - b.sec) };
}

export function removeMarker(timeline: TimelineModel, markerId: string): TimelineModel {
  const markers = timelineMarkers(timeline);
  if (!markers.some((m) => m.id === markerId)) return timeline;
  return { ...timeline, markers: markers.filter((m) => m.id !== markerId) };
}

/** Sorted unique snap points: timeline start, every clip edge, every marker. */
export function timelineSnapPoints(timeline: TimelineModel): number[] {
  const points = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      points.add(clip.start);
      points.add(clip.start + clip.duration);
    }
  }
  for (const marker of timelineMarkers(timeline)) points.add(marker.sec);
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
