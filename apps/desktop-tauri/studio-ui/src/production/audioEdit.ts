// Minimal audio-clip edit model (UNIFIED_PRODUCTION_DRAWER_PLAN.md step 8):
// source trim + gain + fades for a timeline audio clip. Pure functions over an
// immutable document so the on-demand editor is unit testable without React.
// The document describes the edit non-destructively — the source file is never
// touched; export applies it in the FFmpeg render plan.

import { MIN_CLIP_SECONDS } from "./timeline";

export interface AudioClipEdit {
  /** Source in-point, seconds from the start of the media file. */
  trimStartSec: number;
  /** Source out-point, seconds; null plays through to the media end. */
  trimEndSec: number | null;
  /** Clip gain in decibels. */
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export const MIN_GAIN_DB = -24;
export const MAX_GAIN_DB = 24;

export function defaultAudioEdit(): AudioClipEdit {
  return { trimStartSec: 0, trimEndSec: null, gainDb: 0, fadeInSec: 0, fadeOutSec: 0 };
}

/** Played length of the clip under this edit, given the source duration. */
export function editedDuration(edit: AudioClipEdit, sourceDurationSec: number): number {
  const end = Math.min(edit.trimEndSec ?? sourceDurationSec, sourceDurationSec);
  return Math.max(MIN_CLIP_SECONDS, end - edit.trimStartSec);
}

/**
 * Clamp an edit into a consistent document for the given source duration:
 * trim window inside the source and at least MIN_CLIP_SECONDS long, gain in
 * [MIN_GAIN_DB, MAX_GAIN_DB], fades non-negative and together no longer than
 * the trimmed length.
 */
export function clampAudioEdit(edit: AudioClipEdit, sourceDurationSec: number): AudioClipEdit {
  const trimStartSec = Math.min(
    Math.max(0, edit.trimStartSec),
    Math.max(0, sourceDurationSec - MIN_CLIP_SECONDS),
  );
  const rawEnd = edit.trimEndSec ?? sourceDurationSec;
  const trimEnd = Math.min(Math.max(rawEnd, trimStartSec + MIN_CLIP_SECONDS), sourceDurationSec);
  const trimEndSec = edit.trimEndSec === null && trimEnd === sourceDurationSec ? null : trimEnd;
  const length = trimEnd - trimStartSec;
  let fadeInSec = Math.max(0, edit.fadeInSec);
  let fadeOutSec = Math.max(0, edit.fadeOutSec);
  const fadeTotal = fadeInSec + fadeOutSec;
  if (fadeTotal > length && fadeTotal > 0) {
    const scale = length / fadeTotal;
    fadeInSec *= scale;
    fadeOutSec *= scale;
  }
  return {
    trimStartSec,
    trimEndSec,
    gainDb: Math.min(Math.max(edit.gainDb, MIN_GAIN_DB), MAX_GAIN_DB),
    fadeInSec,
    fadeOutSec,
  };
}

export function gainScalar(gainDb: number): number {
  return Math.pow(10, gainDb / 20);
}

/**
 * Fade envelope (0..1, before gain) at `tSec` into the trimmed clip. Linear
 * ramps at both ends; 0 outside the trimmed window.
 */
export function envelopeAt(edit: AudioClipEdit, sourceDurationSec: number, tSec: number): number {
  const length = editedDuration(edit, sourceDurationSec);
  if (tSec < 0 || tSec > length) return 0;
  let level = 1;
  if (edit.fadeInSec > 0) level = Math.min(level, tSec / edit.fadeInSec);
  if (edit.fadeOutSec > 0) level = Math.min(level, (length - tSec) / edit.fadeOutSec);
  return Math.min(Math.max(level, 0), 1);
}
