// Timeline render plan (UNIFIED_PRODUCTION_DRAWER_PLAN.md step 9): a pure,
// serializable description of what the export encodes, built from the timeline
// plus the media bin. The encode path covers the video track's still and
// video clips (expanded to one frame per output frame at the chosen fps —
// stills repeat their image path, video clips carry a clip-local decode time
// the backend resolves through the media engine) and the audio tracks' clips
// (mixed down with their trim/gain/fade edits and muxed into the output).

import { defaultAudioEdit, type AudioClipEdit } from "./audioEdit";
import type { MediaAsset } from "./mediaBin";
import type { ClipKind, TimelineModel } from "./timeline";

export interface RenderSegment {
  clipId: string;
  kind: ClipKind;
  assetId: string;
  /** Absolute media path the segment plays. */
  path: string;
  /** Timeline start, seconds. */
  start: number;
  /** Playback length, seconds. */
  duration: number;
  /** The clip's stored grade doc (JSON string), applied at encode time. */
  gradeDoc: string | null;
}

/** An audio-track segment plus its non-destructive edit, for the mixdown. */
export interface AudioRenderSegment extends RenderSegment {
  /** Source in-point, seconds into the media file. */
  trimStartSec: number;
  /** Clip gain, decibels. */
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export type RenderWarning =
  | { kind: "missing_asset"; clipId: string; assetId: string }
  | { kind: "gap"; atSec: number; lengthSec: number };

export interface RenderPlan {
  timelineId: string;
  fps: number;
  /** Encodable segments (stills and video clips) of the first video track. */
  video: RenderSegment[];
  /** Audio-track segments, mixed down and muxed into the output. */
  audio: AudioRenderSegment[];
  /** Encoded output length, seconds (sum of encodable segment durations). */
  durationSec: number;
  warnings: RenderWarning[];
}

export const DEFAULT_EXPORT_FPS = 24;
export const MAX_EXPORT_FRAMES = 20000;

/**
 * Build the render plan for a timeline: order the first video track's clips,
 * resolve their bin assets, collect the audio clips with their edits, and
 * report anything the encode path cannot carry (missing assets, gaps
 * between clips).
 */
export function buildRenderPlan(
  timeline: TimelineModel,
  assets: MediaAsset[],
  opts: {
    fps?: number;
    clipGradeDoc?: (clipId: string) => string | null;
    /** A clip's stored audio edit, applied in the mixdown. */
    clipAudioEdit?: (clipId: string) => AudioClipEdit | null;
  } = {},
): RenderPlan {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : DEFAULT_EXPORT_FPS;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const warnings: RenderWarning[] = [];
  const video: RenderSegment[] = [];
  const audio: AudioRenderSegment[] = [];

  const videoTrack = timeline.tracks.find((t) => t.kind === "video");
  const ordered = [...(videoTrack?.clips ?? [])].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const clip of ordered) {
    const asset = byId.get(clip.assetId);
    if (!asset) {
      warnings.push({ kind: "missing_asset", clipId: clip.id, assetId: clip.assetId });
      continue;
    }
    if (clip.start > cursor + 1e-6) {
      warnings.push({ kind: "gap", atSec: cursor, lengthSec: clip.start - cursor });
    }
    cursor = Math.max(cursor, clip.start + clip.duration);
    video.push({
      clipId: clip.id,
      kind: clip.kind,
      assetId: asset.id,
      path: asset.path,
      start: clip.start,
      duration: clip.duration,
      gradeDoc: opts.clipGradeDoc?.(clip.id) ?? null,
    });
  }

  for (const track of timeline.tracks.filter((t) => t.kind === "audio")) {
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const asset = byId.get(clip.assetId);
      if (!asset) {
        warnings.push({ kind: "missing_asset", clipId: clip.id, assetId: clip.assetId });
        continue;
      }
      const edit = opts.clipAudioEdit?.(clip.id) ?? defaultAudioEdit();
      audio.push({
        clipId: clip.id,
        kind: clip.kind,
        assetId: asset.id,
        path: asset.path,
        start: clip.start,
        duration: clip.duration,
        gradeDoc: null,
        trimStartSec: edit.trimStartSec,
        gainDb: edit.gainDb,
        fadeInSec: edit.fadeInSec,
        fadeOutSec: edit.fadeOutSec,
      });
    }
  }

  const durationSec = video.reduce((sum, s) => sum + s.duration, 0);
  return { timelineId: timeline.id, fps, video, audio, durationSec, warnings };
}

export interface ExpandedFrames {
  /** One media path per output frame, in order (image or video file). */
  paths: string[];
  /** Per-frame grade doc (JSON string), aligned with `paths`. */
  gradeDocs: (string | null)[];
  /**
   * Per-frame clip-local decode time, aligned with `paths`: `null` for
   * still frames (the path is the frame image), seconds into the source
   * for video-clip frames (the backend decodes the frame at that time).
   */
  frameTimes: (number | null)[];
  /** True when any frame needs a video decode (`frameTimes` non-null). */
  hasVideoFrames: boolean;
}

/**
 * Expand the plan's segments into one frame per output frame (each carrying
 * its clip's grade doc), gaps dropped (segments encode back-to-back). Still
 * frames repeat the image path; video-clip frames pair the video path with
 * the clip-local time to decode. Returns `null` when the frame count would
 * exceed {@link MAX_EXPORT_FRAMES}.
 */
export function expandPlanFrames(plan: RenderPlan): ExpandedFrames | null {
  const paths: string[] = [];
  const gradeDocs: (string | null)[] = [];
  const frameTimes: (number | null)[] = [];
  let hasVideoFrames = false;
  for (const segment of plan.video) {
    const count = Math.max(1, Math.round(segment.duration * plan.fps));
    if (paths.length + count > MAX_EXPORT_FRAMES) return null;
    for (let i = 0; i < count; i += 1) {
      paths.push(segment.path);
      gradeDocs.push(segment.gradeDoc);
      if (segment.kind === "video") {
        frameTimes.push(Math.min(i / plan.fps, segment.duration));
        hasVideoFrames = true;
      } else {
        frameTimes.push(null);
      }
    }
  }
  return { paths, gradeDocs, frameTimes, hasVideoFrames };
}
