// Global production state (state-management consolidation plan): the media
// bin, the timeline, the unified bin/clip selection, and the per-clip edit
// documents (grade docs, audio edits) live in one external store instead of
// scattered `useState` hooks. Every mutation that removes an entity cascades:
// deleting a bin asset drops its clips, and dropping clips prunes the edit
// documents keyed by them — so long sessions never accumulate state for media
// that no longer exists. Framework-free core (subscribe/getState/mutate) with
// a `useSyncExternalStore` hook on top, so the cascade logic is unit testable
// without React.

import { useSyncExternalStore } from "react";

import {
  addAsset,
  removeAsset,
  setAssetMediaInfo as setAssetMediaInfoInBin,
  type MediaAsset,
  type MediaAssetKind,
} from "./mediaBin";
import {
  addTrack,
  appendClip,
  appendVideoWithAudio,
  createTimeline,
  findClip,
  removeClip,
  removeClipsForAsset,
  removeMarker,
  removeTrack,
  splitClip,
  toggleMarker,
  toggleTrackHidden,
  toggleTrackLock,
  trimClip,
  type TimelineModel,
  type TrackKind,
} from "./timeline";
import { clampAudioEdit, editedDuration, type AudioClipEdit } from "./audioEdit";
import {
  clampClipProperties,
  defaultClipProperties,
  isDefaultClipProperties,
  type ClipProperties,
} from "./clipProps";
import { targetKey } from "./productionTarget";

export interface AudioEditEntry {
  edit: AudioClipEdit;
  /** Source duration assumed when the clip was first opened. */
  sourceDurationSec: number;
}

export interface ProductionState {
  binAssets: MediaAsset[];
  /** Active bin asset (mutually exclusive with a clip selection). */
  activeAssetId: string | null;
  timeline: TimelineModel;
  /** Selected timeline clip (mutually exclusive with a bin selection). */
  selectedClipId: string | null;
  /** Per-target grade documents (JSON strings) keyed by `targetKey`. */
  gradeDocs: Record<string, string>;
  /** Per-clip non-destructive audio edits, keyed by clip id. */
  audioEdits: Record<string, AudioEditEntry>;
  /** Per-clip property documents (transform / crop), keyed by clip id. */
  clipProps: Record<string, ClipProperties>;
}

function initialState(): ProductionState {
  return {
    binAssets: [],
    activeAssetId: null,
    timeline: createTimeline(),
    selectedClipId: null,
    gradeDocs: {},
    audioEdits: {},
    clipProps: {},
  };
}

type Listener = () => void;

/** The store: an immutable snapshot plus subscribe/mutate. */
export interface ProductionStore {
  getState(): ProductionState;
  subscribe(listener: Listener): () => void;
  /** Replace the snapshot with the reducer's result and notify (no-op when
   * the reducer returns the same reference). */
  mutate(reduce: (state: ProductionState) => ProductionState): void;
  reset(): void;
}

export function createProductionStore(): ProductionStore {
  let state = initialState();
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate(reduce) {
      const next = reduce(state);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
    reset() {
      state = initialState();
      for (const l of [...listeners]) l();
    },
  };
}

/** The application-wide store instance. Tests build their own. */
export const productionStore = createProductionStore();

/** Subscribe a component to a slice of the production state. The selector
 * must return a stable value for unchanged state (the snapshot is immutable,
 * so field reads are stable by construction). */
export function useProductionState<T>(
  select: (state: ProductionState) => T,
  store: ProductionStore = productionStore,
): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

/** The grade-doc key of a clip: its `video_clip` target on this timeline. */
export function clipGradeKey(timeline: TimelineModel, clipId: string): string | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  return targetKey({
    kind: "video_clip",
    timelineId: timeline.id,
    trackId: found.track.id,
    clipId: found.clip.id,
  });
}

/** The stored grade doc of a clip, or null. */
export function clipGradeDocOf(state: ProductionState, clipId: string): string | null {
  const key = clipGradeKey(state.timeline, clipId);
  return key ? (state.gradeDocs[key] ?? null) : null;
}

function allClipIds(timeline: TimelineModel): Set<string> {
  const ids = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) ids.add(clip.id);
  return ids;
}

/**
 * Cascade a timeline change: clips present in `before` but gone from `after`
 * take their edit documents with them (their audio edits and their grade docs
 * — the doc key derives from the clip's placement in `before`). Selection is
 * cleared when it pointed at a removed clip.
 */
function withTimeline(state: ProductionState, after: TimelineModel): ProductionState {
  if (after === state.timeline) return state;
  const survivors = allClipIds(after);
  let gradeDocs = state.gradeDocs;
  let audioEdits = state.audioEdits;
  let clipProps = state.clipProps;
  for (const track of state.timeline.tracks) {
    for (const clip of track.clips) {
      if (survivors.has(clip.id)) continue;
      const key = targetKey({
        kind: "video_clip",
        timelineId: state.timeline.id,
        trackId: track.id,
        clipId: clip.id,
      });
      if (key in gradeDocs) {
        if (gradeDocs === state.gradeDocs) gradeDocs = { ...gradeDocs };
        delete gradeDocs[key];
      }
      if (clip.id in audioEdits) {
        if (audioEdits === state.audioEdits) audioEdits = { ...audioEdits };
        delete audioEdits[clip.id];
      }
      if (clip.id in clipProps) {
        if (clipProps === state.clipProps) clipProps = { ...clipProps };
        delete clipProps[clip.id];
      }
    }
  }
  const selectedClipId =
    state.selectedClipId && !survivors.has(state.selectedClipId) ? null : state.selectedClipId;
  return { ...state, timeline: after, gradeDocs, audioEdits, clipProps, selectedClipId };
}

// --- actions -----------------------------------------------------------------

export interface AssetDraft {
  kind: MediaAssetKind;
  path: string;
  name?: string;
  sourceNodeId?: string;
}

/** Register a media reference in the bin and make it the active selection. */
export function addAssetToBin(store: ProductionStore, draft: AssetDraft): MediaAsset {
  const result = addAsset(store.getState().binAssets, draft);
  store.mutate((state) => ({
    ...state,
    binAssets: result.assets,
    activeAssetId: result.asset.id,
    selectedClipId: null,
  }));
  return result.asset;
}

/** Attach probed media info (real duration, audio-stream presence) to a bin
 * asset, so later timeline placements use it. */
export function setBinAssetMediaInfo(
  store: ProductionStore,
  assetId: string,
  info: { durationSec?: number | null; hasAudio?: boolean | null },
): void {
  store.mutate((state) => {
    const next = setAssetMediaInfoInBin(state.binAssets, assetId, info);
    return next === state.binAssets ? state : { ...state, binAssets: next };
  });
}

/** Delete a bin asset. Clips referencing it leave with it (and their edit
 * documents cascade away with the clips). */
export function removeAssetFromBin(store: ProductionStore, assetId: string): void {
  store.mutate((state) => {
    const next = withTimeline(state, removeClipsForAsset(state.timeline, assetId));
    return {
      ...next,
      binAssets: removeAsset(next.binAssets, assetId),
      activeAssetId: next.activeAssetId === assetId ? null : next.activeAssetId,
    };
  });
}

/** Append the asset to a compatible track (the given one when provided) and
 * select the new clip. */
export function addAssetClip(
  store: ProductionStore,
  assetId: string,
  opts: { trackId?: string; atSec?: number } = {},
): void {
  store.mutate((state) => {
    const asset = state.binAssets.find((a) => a.id === assetId);
    if (!asset) return state;
    const placement = { ...opts, duration: asset.durationSec };
    if (asset.kind === "video" && asset.hasAudio !== false) {
      const result = appendVideoWithAudio(state.timeline, asset, placement);
      if (opts.trackId && result.videoTrackId !== opts.trackId) return state;
      return {
        ...state,
        timeline: result.timeline,
        selectedClipId: result.video.id,
      };
    }
    const result = appendClip(state.timeline, asset, placement);
    if (!result) return state;
    if (opts.trackId && result.trackId !== opts.trackId) return state;
    return {
      ...state,
      timeline: result.timeline,
      selectedClipId: result.clip.id,
    };
  });
}

/** Add / clear a sequence marker at the given time (M key at the playhead). */
export function toggleTimelineMarker(store: ProductionStore, sec: number): void {
  store.mutate((state) => ({ ...state, timeline: toggleMarker(state.timeline, sec) }));
}

export function removeTimelineMarker(store: ProductionStore, markerId: string): void {
  store.mutate((state) => ({ ...state, timeline: removeMarker(state.timeline, markerId) }));
}

export function toggleTimelineTrackLock(store: ProductionStore, trackId: string): void {
  store.mutate((state) => ({ ...state, timeline: toggleTrackLock(state.timeline, trackId) }));
}

export function toggleTimelineTrackHidden(store: ProductionStore, trackId: string): void {
  store.mutate((state) => ({ ...state, timeline: toggleTrackHidden(state.timeline, trackId) }));
}

export function addTimelineTrack(store: ProductionStore, kind: TrackKind): void {
  store.mutate((state) => ({ ...state, timeline: addTrack(state.timeline, kind) }));
}

/** Remove a track; its clips' edit documents cascade away. */
export function removeTimelineTrack(store: ProductionStore, trackId: string): void {
  store.mutate((state) => withTimeline(state, removeTrack(state.timeline, trackId)));
}

/** Remove a clip; its edit documents cascade away. */
export function removeTimelineClip(store: ProductionStore, clipId: string): void {
  store.mutate((state) => withTimeline(state, removeClip(state.timeline, clipId)));
}

export function splitTimelineClip(store: ProductionStore, clipId: string, atSec: number): void {
  store.mutate((state) => {
    const result = splitClip(state.timeline, clipId, atSec);
    if (!result) return state;
    return {
      ...withTimeline(state, result.timeline),
      selectedClipId: result.right.id,
    };
  });
}

export function selectClip(store: ProductionStore, clipId: string | null): void {
  store.mutate((state) => ({
    ...state,
    selectedClipId: clipId,
    activeAssetId: clipId ? null : state.activeAssetId,
  }));
}

export function selectBinAsset(store: ProductionStore, assetId: string | null): void {
  store.mutate((state) => ({
    ...state,
    activeAssetId: assetId,
    selectedClipId: assetId ? null : state.selectedClipId,
  }));
}

/** Clear the bin/clip selection (a canvas node was selected instead). */
export function clearProductionSelection(store: ProductionStore): void {
  store.mutate((state) =>
    state.activeAssetId === null && state.selectedClipId === null
      ? state
      : { ...state, activeAssetId: null, selectedClipId: null },
  );
}

/** Store a clip's grade doc under its `video_clip` target key. */
export function setClipGradeDoc(store: ProductionStore, clipId: string, doc: string): void {
  store.mutate((state) => {
    const key = clipGradeKey(state.timeline, clipId);
    if (!key) return state;
    return { ...state, gradeDocs: { ...state.gradeDocs, [key]: doc } };
  });
}

/** A clip's stored property document, or the defaults. */
export function clipPropertiesOf(state: ProductionState, clipId: string): ClipProperties {
  return state.clipProps[clipId] ?? defaultClipProperties();
}

/** Store a clip's property document (clamped); default docs are pruned. */
export function setClipProperties(
  store: ProductionStore,
  clipId: string,
  props: ClipProperties,
): void {
  store.mutate((state) => {
    if (!findClip(state.timeline, clipId)) return state;
    const clamped = clampClipProperties(props);
    if (isDefaultClipProperties(clamped)) {
      if (!(clipId in state.clipProps)) return state;
      const next = { ...state.clipProps };
      delete next[clipId];
      return { ...state, clipProps: next };
    }
    return { ...state, clipProps: { ...state.clipProps, [clipId]: clamped } };
  });
}

/** Commit an audio edit: clamp it against the source duration, store it, and
 * reflect the trimmed span on the timeline clip. */
export function commitAudioEdit(store: ProductionStore, clipId: string, edit: AudioClipEdit): void {
  store.mutate((state) => {
    const found = findClip(state.timeline, clipId);
    if (!found) return state;
    const sourceDurationSec = state.audioEdits[clipId]?.sourceDurationSec ?? found.clip.duration;
    const clamped = clampAudioEdit(edit, sourceDurationSec);
    return {
      ...state,
      audioEdits: { ...state.audioEdits, [clipId]: { edit: clamped, sourceDurationSec } },
      timeline: trimClip(state.timeline, clipId, {
        duration: editedDuration(clamped, sourceDurationSec),
      }),
    };
  });
}
