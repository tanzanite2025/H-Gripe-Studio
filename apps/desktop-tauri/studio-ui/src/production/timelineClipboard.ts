// Pure clip clipboard operations (copy / paste) over the immutable timeline
// model. Copies are asset references plus placement, detached from the source
// timeline, so they survive later edits and even deletion of the originals.
// Paste never overwrites: clips that have no room on any existing compatible
// track land on freshly created tracks.

import {
  DEFAULT_TIMELINE_FPS,
  findClip,
  freshId,
  snapTimeToFrame,
  trackKindForClip,
  type ClipKind,
  type TimelineClip,
  type TimelineModel,
  type TimelineTrack,
} from "./timeline";

/** One copied clip: everything needed to re-create it, positioned relative to
 * the earliest clip of the copied set. */
export interface CopiedTimelineClip {
  kind: ClipKind;
  assetId: string;
  duration: number;
  sourceStartSec: number;
  /** Start offset from the earliest copied clip, seconds (>= 0). */
  offsetSecFromEarliestCopiedClip: number;
  /** Track the clip was copied from; paste prefers it when still compatible. */
  sourceTrackId: string;
  /** Original linkId; paste remaps each distinct value to a fresh one. */
  sourceLinkId?: string;
}

/** Snapshot the given clips for a later paste. Order-independent; unknown ids
 * are skipped. Returns [] when nothing was copyable. */
export function copyTimelineClipsToClipboard(
  timeline: TimelineModel,
  clipIds: readonly string[],
): CopiedTimelineClip[] {
  const located = clipIds
    .map((clipId) => findClip(timeline, clipId))
    .filter((found): found is NonNullable<typeof found> => found != null);
  if (located.length === 0) return [];
  const earliestStartSec = Math.min(...located.map(({ clip }) => clip.start));
  return located.map(({ track, clip }) => ({
    kind: clip.kind,
    assetId: clip.assetId,
    duration: clip.duration,
    sourceStartSec: clip.sourceStartSec,
    offsetSecFromEarliestCopiedClip: clip.start - earliestStartSec,
    sourceTrackId: track.id,
    sourceLinkId: clip.linkId,
  }));
}

export interface PasteCopiedClipsResult {
  timeline: TimelineModel;
  /** Ids of the newly created clips, for selecting them after the paste. */
  pastedClipIds: string[];
}

function trackAcceptsClipKind(track: TimelineTrack, kind: ClipKind): boolean {
  return kind === "audio"
    ? track.kind === "audio"
    : kind === "still"
      ? track.kind === "image"
      : track.kind === "video";
}

function intervalOverlapsAnyClip(
  clips: readonly TimelineClip[],
  startSec: number,
  durationSec: number,
): boolean {
  return clips.some(
    (clip) => clip.start < startSec + durationSec && clip.start + clip.duration > startSec,
  );
}

function freshTrackForClipKind(kind: ClipKind): TimelineTrack {
  const trackKind = trackKindForClip(kind);
  const prefix =
    trackKind === "video" ? "track-v" : trackKind === "audio" ? "track-a" : "track-i";
  return { id: freshId(prefix), kind: trackKind, clips: [] };
}

/**
 * Paste previously copied clips with their earliest clip at the (frame
 * snapped) given time — the playhead in the UI. Each clip goes back onto its
 * source track when that track still exists, is unlocked, kind-compatible and
 * free at the paste position; otherwise onto the first unlocked compatible
 * track with room; otherwise onto a freshly created track of the right kind,
 * so a paste never overwrites existing clips and never fails for lack of
 * room. Linked A/V pairs stay paired under fresh link ids. Null only when the
 * clipboard is empty.
 */
export function pasteCopiedTimelineClipsAtTime(
  timeline: TimelineModel,
  copiedClips: readonly CopiedTimelineClip[],
  pasteEarliestAtSec: number,
): PasteCopiedClipsResult | null {
  if (copiedClips.length === 0) return null;
  const fps = timeline.fps ?? DEFAULT_TIMELINE_FPS;
  const baseStartSec = snapTimeToFrame(Math.max(0, pasteEarliestAtSec), fps);

  const clipsToInsertByTrackId = new Map<string, TimelineClip[]>();
  const createdTracks: TimelineTrack[] = [];
  const freshLinkIdBySourceLinkId = new Map<string, string>();
  const pastedClipIds: string[] = [];

  for (const copied of copiedClips) {
    const startSec = snapTimeToFrame(baseStartSec + copied.offsetSecFromEarliestCopiedClip, fps);
    const eligibleTracks = [...timeline.tracks, ...createdTracks].filter(
      (track) => trackAcceptsClipKind(track, copied.kind) && !track.locked,
    );
    const candidateTracks = [...eligibleTracks].sort((a, b) =>
      a.id === copied.sourceTrackId ? -1 : b.id === copied.sourceTrackId ? 1 : 0,
    );
    let targetTrack = candidateTracks.find(
      (track) =>
        !intervalOverlapsAnyClip(track.clips, startSec, copied.duration) &&
        !intervalOverlapsAnyClip(
          clipsToInsertByTrackId.get(track.id) ?? [],
          startSec,
          copied.duration,
        ),
    );
    if (!targetTrack) {
      targetTrack = freshTrackForClipKind(copied.kind);
      createdTracks.push(targetTrack);
    }

    let linkId: string | undefined;
    if (copied.sourceLinkId != null) {
      linkId = freshLinkIdBySourceLinkId.get(copied.sourceLinkId);
      if (!linkId) {
        linkId = freshId("link");
        freshLinkIdBySourceLinkId.set(copied.sourceLinkId, linkId);
      }
    }
    const pastedClip: TimelineClip = {
      id: freshId("clip"),
      kind: copied.kind,
      assetId: copied.assetId,
      start: startSec,
      duration: copied.duration,
      sourceStartSec: copied.sourceStartSec,
      ...(linkId != null ? { linkId } : {}),
    };
    pastedClipIds.push(pastedClip.id);
    const pending = clipsToInsertByTrackId.get(targetTrack.id) ?? [];
    clipsToInsertByTrackId.set(targetTrack.id, [...pending, pastedClip]);
  }

  const withInsertedClips = (track: TimelineTrack): TimelineTrack => {
    const inserted = clipsToInsertByTrackId.get(track.id);
    if (!inserted) return track;
    return { ...track, clips: [...track.clips, ...inserted].sort((a, b) => a.start - b.start) };
  };
  return {
    pastedClipIds,
    timeline: {
      ...timeline,
      tracks: [...timeline.tracks.map(withInsertedClips), ...createdTracks.map(withInsertedClips)],
    },
  };
}
