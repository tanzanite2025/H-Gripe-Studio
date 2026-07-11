// Media-asset analysis pipeline: the single place production code goes to
// learn about a media file (real playback duration, audio-stream presence,
// preview thumbnail). It wraps the backend probe/thumbnail bridge commands,
// caches results per file path, and swallows backend failures so callers can
// always fall back to defaults. Nothing outside this module should call
// `videoProbe`/`generateThumbnail` for media-bin assets directly.

import { generateThumbnail, videoProbe, type VideoProbeResult } from "../bridge/files";
import type { MediaAssetKind } from "./mediaBin";

/** Playback facts about a media file needed for timeline placement. */
export interface MediaAssetPlaybackInfo {
  /** Real media duration in seconds; `null` when the backend cannot tell
   * (browser preview, probe failure, or a container without a duration). */
  durationSec: number | null;
  /** Whether the file has a decodable audio stream; `null` while the backend
   * probe does not report it (the current `video_probe` command does not). */
  hasAudio: boolean | null;
}

/** Thumbnail display size for media-bin previews (CSS px, longest edge). */
export const MEDIA_BIN_THUMBNAIL_SIZE_PX = 64;

const MAX_CACHED_ENTRIES = 200;

const videoProbeResultCacheByPath = new Map<string, Promise<VideoProbeResult>>();
const thumbnailDataUrlCacheByKindAndPath = new Map<string, Promise<string | null>>();

function evictOldestEntriesOverCapacity(cache: Map<string, unknown>): void {
  while (cache.size > MAX_CACHED_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** One backend `video_probe` per path: playback info and the poster-frame
 * thumbnail both read from this shared cache. Failed probes are evicted so a
 * later retry can succeed. */
function probeVideoFileWithCache(path: string): Promise<VideoProbeResult> {
  let cached = videoProbeResultCacheByPath.get(path);
  if (!cached) {
    cached = videoProbe(path).catch((error: unknown) => {
      videoProbeResultCacheByPath.delete(path);
      throw error;
    });
    videoProbeResultCacheByPath.set(path, cached);
    evictOldestEntriesOverCapacity(videoProbeResultCacheByPath);
  }
  return cached;
}

/**
 * Probe a video file's playback info (duration, and audio presence once the
 * backend reports it). Results are cached per path; failures resolve to
 * all-`null` info instead of throwing, so callers keep their defaults.
 * Non-video kinds resolve to all-`null` info: the backend currently has no
 * probe command for image or audio durations.
 */
export function probeMediaAssetPlaybackInfo(
  kind: MediaAssetKind,
  path: string,
): Promise<MediaAssetPlaybackInfo> {
  if (kind !== "video") {
    return Promise.resolve({ durationSec: null, hasAudio: null });
  }
  return probeVideoFileWithCache(path)
    .then((probe) => ({ durationSec: probe.duration_sec, hasAudio: null }))
    .catch((): MediaAssetPlaybackInfo => ({ durationSec: null, hasAudio: null }));
}

/**
 * Load a preview thumbnail for a media file as a `data:` URL. Images are
 * thumbnailed directly; videos first probe for the cached poster frame and
 * thumbnail that. Resolves to `null` when no preview is possible (audio
 * files, browser preview without a backend, or probe/decode failure).
 */
export function loadMediaAssetThumbnailDataUrl(
  kind: MediaAssetKind,
  path: string,
): Promise<string | null> {
  if (kind === "audio") return Promise.resolve(null);
  const cacheKey = `${kind}:${path}`;
  let cached = thumbnailDataUrlCacheByKindAndPath.get(cacheKey);
  if (!cached) {
    const imagePathToThumbnail =
      kind === "video"
        ? probeVideoFileWithCache(path).then((probe) => probe.poster_path || null)
        : Promise.resolve(path);
    cached = imagePathToThumbnail
      .then((thumbnailSourcePath) =>
        thumbnailSourcePath
          ? generateThumbnail({ path: thumbnailSourcePath, size: MEDIA_BIN_THUMBNAIL_SIZE_PX }).then(
              (thumbnail) => thumbnail.data_url || null,
            )
          : null,
      )
      .catch(() => {
        thumbnailDataUrlCacheByKindAndPath.delete(cacheKey);
        return null;
      });
    thumbnailDataUrlCacheByKindAndPath.set(cacheKey, cached);
    evictOldestEntriesOverCapacity(thumbnailDataUrlCacheByKindAndPath);
  }
  return cached;
}
