// Timeline render plan (UNIFIED_PRODUCTION_DRAWER_PLAN.md step 9): a pure,
// serializable description of what the export encodes, built from the timeline
// plus the media bin. The first encode path covers the video track's still
// clips (expanded to one image path per output frame at the chosen fps);
// video-clip re-encode and the audio mixdown/mux consume the same plan once
// their backend lanes land, so unsupported segments surface as warnings
// instead of silently disappearing.

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
}

export type RenderWarning =
  | { kind: "missing_asset"; clipId: string; assetId: string }
  | { kind: "video_clip_skipped"; clipId: string }
  | { kind: "audio_not_mixed"; clipCount: number }
  | { kind: "gap"; atSec: number; lengthSec: number };

export interface RenderPlan {
  timelineId: string;
  fps: number;
  /** Encodable still segments of the first video track, in timeline order. */
  video: RenderSegment[];
  /** Audio-track segments (reported, not yet mixed/muxed). */
  audio: RenderSegment[];
  /** Encoded output length, seconds (sum of encodable segment durations). */
  durationSec: number;
  warnings: RenderWarning[];
}

export const DEFAULT_EXPORT_FPS = 24;
export const MAX_EXPORT_FRAMES = 20000;

/**
 * Build the render plan for a timeline: order the first video track's clips,
 * resolve their bin assets, and report anything the first encode path cannot
 * carry (missing assets, video clips, unmixed audio, gaps between clips).
 */
export function buildRenderPlan(
  timeline: TimelineModel,
  assets: MediaAsset[],
  opts: { fps?: number } = {},
): RenderPlan {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : DEFAULT_EXPORT_FPS;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const warnings: RenderWarning[] = [];
  const video: RenderSegment[] = [];
  const audio: RenderSegment[] = [];

  const videoTrack = timeline.tracks.find((t) => t.kind === "video");
  const ordered = [...(videoTrack?.clips ?? [])].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const clip of ordered) {
    const asset = byId.get(clip.assetId);
    if (!asset) {
      warnings.push({ kind: "missing_asset", clipId: clip.id, assetId: clip.assetId });
      continue;
    }
    if (clip.kind === "video") {
      warnings.push({ kind: "video_clip_skipped", clipId: clip.id });
      cursor = Math.max(cursor, clip.start + clip.duration);
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
    });
  }

  let audioClipCount = 0;
  for (const track of timeline.tracks.filter((t) => t.kind === "audio")) {
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const asset = byId.get(clip.assetId);
      if (!asset) {
        warnings.push({ kind: "missing_asset", clipId: clip.id, assetId: clip.assetId });
        continue;
      }
      audioClipCount += 1;
      audio.push({
        clipId: clip.id,
        kind: clip.kind,
        assetId: asset.id,
        path: asset.path,
        start: clip.start,
        duration: clip.duration,
      });
    }
  }
  if (audioClipCount > 0) warnings.push({ kind: "audio_not_mixed", clipCount: audioClipCount });

  const durationSec = video.reduce((sum, s) => sum + s.duration, 0);
  return { timelineId: timeline.id, fps, video, audio, durationSec, warnings };
}

/**
 * Expand the plan's still segments into one image path per output frame,
 * gaps dropped (segments encode back-to-back). Returns `null` when the frame
 * count would exceed {@link MAX_EXPORT_FRAMES}.
 */
export function expandStillFrames(plan: RenderPlan): string[] | null {
  const frames: string[] = [];
  for (const segment of plan.video) {
    const count = Math.max(1, Math.round(segment.duration * plan.fps));
    if (frames.length + count > MAX_EXPORT_FRAMES) return null;
    for (let i = 0; i < count; i += 1) frames.push(segment.path);
  }
  return frames;
}
