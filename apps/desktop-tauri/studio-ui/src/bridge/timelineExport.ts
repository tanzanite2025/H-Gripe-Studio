// Bridge for the drawer's timeline export command: send the expanded frame
// sequence (one media path per output frame; video-clip frames pair the
// path with a clip-local decode time) plus the audio segments to the backend
// `timeline_export` command, which encodes the video through the same FFmpeg
// seam as the `videoAssemble` node executor and muxes the audio mixdown in
// as an AAC track.

import { tauriInvoke } from "./core";

// Field names are camelCase to match the Rust `TimelineAudioSegment` deserde.
export interface TimelineAudioSegment {
  /** Absolute media path of the clip's source file. */
  path: string;
  /** Timeline start, seconds. */
  startSec: number;
  /** Played length, seconds. */
  durationSec: number;
  /** Source in-point, seconds into the media file. */
  trimStartSec: number;
  /** Clip gain, decibels. */
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

// Fields are snake_case to match the Rust `TimelineExportResult` serialization.
export interface TimelineExportResult {
  video_path: string;
  frame_count: number;
  duration_sec: number;
  /** Frames graded before the encode (0 when no clip carried a doc). */
  graded_frame_count: number;
  /** Backend that ran the grade kernel (`cpu` / `gpu`), when frames were graded. */
  grade_backend?: "cpu" | "gpu";
  /** Audio clips mixed into the output's AAC track (0 = video only). */
  audio_clip_count: number;
  /** Why the export stayed video-only although audio clips were sent. */
  audio_skipped_reason?: string;
}

/**
 * Encode `frames` at `fps` into a video under the project output dir. Returns
 * `null` outside Tauri (browser preview has no encoder).
 */
export async function timelineExport(
  frames: string[],
  fps: number,
  opts: {
    codec?: string;
    outputName?: string;
    gradeDocs?: (string | null)[];
    /**
     * Per-frame clip-local decode time, aligned with `frames`: `null` for
     * still frames, seconds into the source for video-clip frames.
     */
    frameTimes?: (number | null)[];
    audio?: TimelineAudioSegment[];
  } = {},
): Promise<TimelineExportResult | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("timeline_export", {
    frames,
    fps,
    codec: opts.codec ?? null,
    outputName: opts.outputName ?? null,
    gradeDocs: opts.gradeDocs ?? null,
    frameTimes: opts.frameTimes ?? null,
    audio: opts.audio ?? null,
  })) as TimelineExportResult;
}
