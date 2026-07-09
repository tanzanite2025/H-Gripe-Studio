// Lightweight media workspace / bin model for the Edit / Timeline tab.
//
// The bin holds references to media produced or sourced on the node canvas
// (never copies): dropping into the bin only registers the asset; placing on a
// timeline track is a separate, later step. Pure functions over immutable
// arrays so the model is unit testable without React.

export type MediaAssetKind = "image" | "video" | "audio";

export interface MediaAsset {
  id: string;
  kind: MediaAssetKind;
  /** Absolute path of the media file this asset references. */
  path: string;
  /** Display name (defaults to the file name). */
  name: string;
  /** Canvas node this asset came from, when added from a node. */
  sourceNodeId?: string;
  addedAt: number;
}

export const IMAGE_MEDIA_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
] as const;

export const VIDEO_MEDIA_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"] as const;

export const AUDIO_MEDIA_EXTS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"] as const;

export const MEDIA_IMPORT_EXTS = [
  ...IMAGE_MEDIA_EXTS,
  ...VIDEO_MEDIA_EXTS,
  ...AUDIO_MEDIA_EXTS,
] as const;

const IMAGE_EXTS = new Set<string>(IMAGE_MEDIA_EXTS);
const VIDEO_EXTS = new Set<string>(VIDEO_MEDIA_EXTS);
const AUDIO_EXTS = new Set<string>(AUDIO_MEDIA_EXTS);

/** Map a canvas node kind to the bin asset kind it can register as. */
export function assetKindForNodeKind(nodeKind: string): MediaAssetKind | null {
  if (nodeKind === "imageSource") return "image";
  if (nodeKind === "videoSource") return "video";
  if (nodeKind === "audioSource") return "audio";
  return null;
}

export function assetKindForPath(path: string): MediaAssetKind | null {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

/** File name (without directories) used as the default display name. */
export function assetDisplayName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name || path;
}

export interface AddAssetResult {
  assets: MediaAsset[];
  asset: MediaAsset;
  /** False when an equivalent asset was already in the bin (returned instead). */
  added: boolean;
}

/**
 * Register a media reference in the bin. Re-adding the same path with the same
 * kind is a no-op that returns the existing asset, so repeated "add to
 * workspace" clicks don't fill the bin with duplicates.
 */
export function addAsset(
  assets: MediaAsset[],
  draft: { kind: MediaAssetKind; path: string; name?: string; sourceNodeId?: string },
  now: number = Date.now(),
): AddAssetResult {
  const existing = assets.find((a) => a.kind === draft.kind && a.path === draft.path);
  if (existing) return { assets, asset: existing, added: false };
  const asset: MediaAsset = {
    id: `asset-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: draft.kind,
    path: draft.path,
    name: draft.name || assetDisplayName(draft.path),
    sourceNodeId: draft.sourceNodeId,
    addedAt: now,
  };
  return { assets: [...assets, asset], asset, added: true };
}

export function removeAsset(assets: MediaAsset[], id: string): MediaAsset[] {
  return assets.filter((a) => a.id !== id);
}
