// Pure geometry for the audio edit modal's sample waveform: slice the
// full-source peak buckets down to the trimmed source window and turn them
// into an SVG polygon string. Peak fetching lives in
// `useAudioWaveformPeaks.ts`; this module stays side-effect free so the
// mapping from peaks + trim to drawn shape is unit-testable.

/** How many peak buckets the modal requests for one source file. */
export const AUDIO_WAVEFORM_PEAK_BUCKET_COUNT = 480;

/**
 * Slice full-source waveform peaks down to the `[trimStartSec, trimEndSec]`
 * window so the drawn waveform matches the trimmed span the envelope covers.
 * Returns an empty array when the window or the peaks are empty.
 */
export function sliceWaveformPeaksToTrimmedSourceWindow(
  fullSourcePeaks: readonly number[],
  trimStartSec: number,
  trimEndSec: number,
  sourceDurationSec: number,
): number[] {
  if (fullSourcePeaks.length === 0 || sourceDurationSec <= 0) return [];
  const windowStartSec = Math.max(0, Math.min(trimStartSec, sourceDurationSec));
  const windowEndSec = Math.max(windowStartSec, Math.min(trimEndSec, sourceDurationSec));
  if (windowEndSec <= windowStartSec) return [];
  const firstBucket = Math.floor((windowStartSec / sourceDurationSec) * fullSourcePeaks.length);
  const lastBucketExclusive = Math.ceil(
    (windowEndSec / sourceDurationSec) * fullSourcePeaks.length,
  );
  return fullSourcePeaks.slice(
    Math.min(firstBucket, fullSourcePeaks.length - 1),
    Math.max(Math.min(lastBucketExclusive, fullSourcePeaks.length), firstBucket + 1),
  );
}

/**
 * Build the SVG `points` string of a bottom-anchored waveform polygon: the
 * baseline runs along `y = viewBoxHeight`, and each peak bucket lifts the
 * outline by `peak * viewBoxHeight`. Returns an empty string when there are
 * no peaks (callers then skip rendering the polygon).
 */
export function waveformPolygonPointsFromPeaks(
  peaks: readonly number[],
  viewBoxWidth: number,
  viewBoxHeight: number,
): string {
  if (peaks.length === 0) return "";
  const xForBucket = (bucket: number) =>
    peaks.length === 1 ? viewBoxWidth / 2 : (bucket / (peaks.length - 1)) * viewBoxWidth;
  const outline = peaks.map(
    (peak, bucket) =>
      `${xForBucket(bucket).toFixed(2)},${(viewBoxHeight - Math.max(0, Math.min(1, peak)) * viewBoxHeight).toFixed(2)}`,
  );
  return [`0,${viewBoxHeight}`, ...outline, `${viewBoxWidth},${viewBoxHeight}`].join(" ");
}
