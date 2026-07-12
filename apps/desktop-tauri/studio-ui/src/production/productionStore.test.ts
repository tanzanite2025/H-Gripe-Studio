import { describe, expect, it } from "vitest";

import {
  addAssetClip,
  addAssetToBin,
  addTimelineTrack,
  clearProductionSelection,
  clearSequencePlaybackInPointAction,
  clearSequencePlaybackOutPointAction,
  clipGradeDocOf,
  clipGradeKey,
  commitAudioEdit,
  createProductionStore,
  moveTimelineClip,
  moveTimelineClipToTrack,
  removeAssetFromBin,
  removeSelectedTimelineClips,
  removeTimelineClip,
  removeTimelineTrack,
  replaceTimelineClipSelection,
  toggleClipInSelection,
  trimTimelineClipEdge,
  selectBinAsset,
  selectClip,
  setBinAssetMediaInfo,
  setClipGradeDoc,
  setClipProperties,
  setSequencePlaybackInPoint,
  setSequencePlaybackOutPoint,
  splitTimelineClip,
  type ProductionStore,
} from "./productionStore";
import { defaultAudioEdit } from "./audioEdit";
import { defaultClipProperties } from "./clipProps";
import { findClip } from "./timeline";

function storeWithClip(kind: "image" | "audio" = "image"): {
  store: ProductionStore;
  assetId: string;
  clipId: string;
} {
  const store = createProductionStore();
  const asset = addAssetToBin(store, { kind, path: `/media/a.${kind === "image" ? "png" : "wav"}` });
  addAssetClip(store, asset.id);
  const clipId = store.getState().selectedClipId!;
  return { store, assetId: asset.id, clipId };
}

describe("productionStore", () => {
  it("persists sequence playback in/out points on the timeline and undoes them", () => {
    const store = createProductionStore();
    setSequencePlaybackInPoint(store, 1);
    setSequencePlaybackOutPoint(store, 4);
    expect(store.getState().timeline.playbackRange).toEqual({ inPointSec: 1, outPointSec: 4 });
    clearSequencePlaybackInPointAction(store);
    expect(store.getState().timeline.playbackRange).toEqual({ inPointSec: null, outPointSec: 4 });
    clearSequencePlaybackOutPointAction(store);
    expect(store.getState().timeline.playbackRange).toEqual({ inPointSec: null, outPointSec: null });
    store.undo();
    expect(store.getState().timeline.playbackRange).toEqual({ inPointSec: null, outPointSec: 4 });
    store.undo();
    expect(store.getState().timeline.playbackRange).toEqual({ inPointSec: 1, outPointSec: 4 });
  });

  it("notifies subscribers on mutation and not on no-ops", () => {
    const store = createProductionStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    clearProductionSelection(store); // already clear — no-op
    expect(calls).toBe(0);
    addAssetToBin(store, { kind: "image", path: "/media/a.png" });
    expect(calls).toBe(1);
    unsubscribe();
    addAssetToBin(store, { kind: "image", path: "/media/b.png" });
    expect(calls).toBe(1);
  });

  it("adding an asset selects it and clears the clip selection", () => {
    const { store } = storeWithClip();
    expect(store.getState().selectedClipId).not.toBeNull();
    const asset = addAssetToBin(store, { kind: "image", path: "/media/b.png" });
    const state = store.getState();
    expect(state.activeAssetId).toBe(asset.id);
    expect(state.selectedClipId).toBeNull();
  });

  it("bin and clip selection are mutually exclusive", () => {
    const { store, assetId, clipId } = storeWithClip();
    selectBinAsset(store, assetId);
    expect(store.getState().selectedClipId).toBeNull();
    selectClip(store, clipId);
    expect(store.getState().activeAssetId).toBeNull();
    clearProductionSelection(store);
    expect(store.getState().selectedClipId).toBeNull();
    expect(store.getState().activeAssetId).toBeNull();
  });

  it("removing a clip cascades its grade doc and audio edit away", () => {
    const { store, clipId } = storeWithClip("audio");
    setClipGradeDoc(store, clipId, "{}");
    commitAudioEdit(store, clipId, defaultAudioEdit());
    expect(clipGradeDocOf(store.getState(), clipId)).toBe("{}");
    expect(store.getState().audioEdits[clipId]).toBeDefined();

    const key = clipGradeKey(store.getState().timeline, clipId)!;
    removeTimelineClip(store, clipId);
    const state = store.getState();
    expect(findClip(state.timeline, clipId)).toBeNull();
    expect(state.gradeDocs[key]).toBeUndefined();
    expect(state.audioEdits[clipId]).toBeUndefined();
    expect(state.selectedClipId).toBeNull();
  });

  it("removing a bin asset removes its clips and their edit documents", () => {
    const { store, assetId, clipId } = storeWithClip();
    setClipGradeDoc(store, clipId, '{"wb":1}');
    removeAssetFromBin(store, assetId);
    const state = store.getState();
    expect(state.binAssets).toHaveLength(0);
    expect(state.activeAssetId).toBeNull();
    expect(findClip(state.timeline, clipId)).toBeNull();
    expect(Object.keys(state.gradeDocs)).toHaveLength(0);
    expect(state.selectedClipId).toBeNull();
  });

  it("removing a track cascades every clip document on it", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "audio", path: "/media/a.wav" });
    addTimelineTrack(store, "audio");
    const tracks = store.getState().timeline.tracks;
    const extraTrack = tracks[tracks.length - 1];
    addAssetClip(store, asset.id, { trackId: extraTrack.id });
    const clipId = store.getState().selectedClipId!;
    commitAudioEdit(store, clipId, { ...defaultAudioEdit(), gainDb: 3 });
    expect(store.getState().audioEdits[clipId]).toBeDefined();

    removeTimelineTrack(store, extraTrack.id);
    const state = store.getState();
    expect(state.timeline.tracks.some((t) => t.id === extraTrack.id)).toBe(false);
    expect(state.audioEdits[clipId]).toBeUndefined();
    expect(state.selectedClipId).toBeNull();
  });

  it("keeps documents of surviving clips when another clip is removed", () => {
    const store = createProductionStore();
    const a = addAssetToBin(store, { kind: "image", path: "/media/a.png" });
    const b = addAssetToBin(store, { kind: "image", path: "/media/b.png" });
    addAssetClip(store, a.id);
    const keepId = store.getState().selectedClipId!;
    addAssetClip(store, b.id);
    const dropId = store.getState().selectedClipId!;
    setClipGradeDoc(store, keepId, '{"keep":true}');
    setClipGradeDoc(store, dropId, '{"drop":true}');

    removeTimelineClip(store, dropId);
    const state = store.getState();
    expect(clipGradeDocOf(state, keepId)).toBe('{"keep":true}');
    expect(clipGradeDocOf(state, dropId)).toBeNull();
    expect(Object.keys(state.gradeDocs)).toHaveLength(1);
  });

  it("stores clamped clip properties and prunes documents reset to defaults", () => {
    const { store, clipId } = storeWithClip();
    const props = defaultClipProperties();
    setClipProperties(store, clipId, {
      transform: { ...props.transform, scalePct: 50, opacityPct: 250 },
      crop: props.crop,
    });
    let doc = store.getState().clipProps[clipId];
    expect(doc.transform.scalePct).toBe(50);
    expect(doc.transform.opacityPct).toBe(100);

    setClipProperties(store, clipId, defaultClipProperties());
    expect(store.getState().clipProps[clipId]).toBeUndefined();
  });

  it("removing a clip cascades its property document away", () => {
    const { store, clipId } = storeWithClip();
    const props = defaultClipProperties();
    setClipProperties(store, clipId, {
      transform: { ...props.transform, rotationDeg: 45 },
      crop: props.crop,
    });
    expect(store.getState().clipProps[clipId]).toBeDefined();
    removeTimelineClip(store, clipId);
    expect(store.getState().clipProps[clipId]).toBeUndefined();
  });

  it("splits a clip and selects the right-hand segment", () => {
    const { store, clipId } = storeWithClip();
    splitTimelineClip(store, clipId, 2);
    const state = store.getState();
    const track = state.timeline.tracks.find((t) => t.clips.some((c) => c.id === clipId))!;
    expect(track.clips).toHaveLength(2);
    expect(track.clips[0]).toMatchObject({ id: clipId, duration: 2, sourceStartSec: 0 });
    expect(track.clips[1]).toMatchObject({ start: 2, sourceStartSec: 2 });
    expect(state.selectedClipId).toBe(track.clips[1].id);
  });

  it("commitAudioEdit clamps the edit and trims the clip to the edited span", () => {
    const { store, clipId } = storeWithClip("audio");
    const before = findClip(store.getState().timeline, clipId)!.clip;
    commitAudioEdit(store, clipId, {
      trimStartSec: 1,
      trimEndSec: before.duration - 1,
      gainDb: 99, // clamps to MAX_GAIN_DB
      fadeInSec: 0,
      fadeOutSec: 0,
    });
    const state = store.getState();
    expect(state.audioEdits[clipId].edit.gainDb).toBeLessThanOrEqual(24);
    expect(findClip(state.timeline, clipId)!.clip.duration).toBeCloseTo(before.duration - 2);
  });

  it("uses probed media info when placing a video asset", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "video", path: "/media/a.mp4" });
    setBinAssetMediaInfo(store, asset.id, { durationSec: 7.5 });
    addAssetClip(store, asset.id);
    const state = store.getState();
    const videoClip = findClip(state.timeline, state.selectedClipId!)!.clip;
    expect(videoClip.duration).toBe(7.5);
    const audioTrack = state.timeline.tracks.find((t) => t.kind === "audio")!;
    expect(audioTrack.clips).toHaveLength(1);
    expect(audioTrack.clips[0].duration).toBe(7.5);
    expect(audioTrack.clips[0].linkId).toBe(videoClip.linkId);
  });

  it("skips the audio counterpart for a video known to have no audio", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "video", path: "/media/silent.mp4" });
    setBinAssetMediaInfo(store, asset.id, { hasAudio: false });
    addAssetClip(store, asset.id);
    const state = store.getState();
    const audioTrack = state.timeline.tracks.find((t) => t.kind === "audio")!;
    expect(audioTrack.clips).toHaveLength(0);
    const videoClip = findClip(state.timeline, state.selectedClipId!)!.clip;
    expect(videoClip.kind).toBe("video");
    expect(videoClip.linkId).toBeUndefined();
  });

  it("places clips at the requested drop time", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "audio", path: "/media/a.wav" });
    addAssetClip(store, asset.id, { atSec: 4 });
    const state = store.getState();
    expect(findClip(state.timeline, state.selectedClipId!)!.clip.start).toBe(4);
  });

  it("removing one half of a linked pair cascades both clips' documents", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "video", path: "/media/a.mp4" });
    addAssetClip(store, asset.id);
    const state = store.getState();
    const videoClipId = state.selectedClipId!;
    const audioClip = state.timeline.tracks.find((t) => t.kind === "audio")!.clips[0];
    commitAudioEdit(store, audioClip.id, defaultAudioEdit());
    expect(store.getState().audioEdits[audioClip.id]).toBeDefined();
    removeTimelineClip(store, videoClipId);
    const after = store.getState();
    expect(findClip(after.timeline, videoClipId)).toBeNull();
    expect(findClip(after.timeline, audioClip.id)).toBeNull();
    expect(after.audioEdits[audioClip.id]).toBeUndefined();
  });

  it("undo/redo restore whole snapshots including cascaded documents", () => {
    const { store, clipId } = storeWithClip("audio");
    setClipGradeDoc(store, clipId, "{}");
    commitAudioEdit(store, clipId, defaultAudioEdit());
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    removeTimelineClip(store, clipId);
    expect(findClip(store.getState().timeline, clipId)).toBeNull();

    store.undo();
    const restored = store.getState();
    expect(findClip(restored.timeline, clipId)).not.toBeNull();
    expect(clipGradeDocOf(restored, clipId)).toBe("{}");
    expect(restored.audioEdits[clipId]).toBeDefined();
    expect(store.canRedo()).toBe(true);

    store.redo();
    expect(findClip(store.getState().timeline, clipId)).toBeNull();
    expect(store.getState().audioEdits[clipId]).toBeUndefined();
  });

  it("coalesces a drag's move/trim events into a single undo step", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "audio", path: "/media/a.wav" });
    addAssetClip(store, asset.id);
    const clipId = store.getState().selectedClipId!;

    moveTimelineClip(store, clipId, 2);
    moveTimelineClip(store, clipId, 4);
    moveTimelineClip(store, clipId, 6);
    expect(findClip(store.getState().timeline, clipId)!.clip.start).toBe(6);
    store.undo();
    expect(findClip(store.getState().timeline, clipId)!.clip.start).toBe(0);

    store.redo();
    trimTimelineClipEdge(store, clipId, "end", 8);
    trimTimelineClipEdge(store, clipId, "end", 9);
    store.undo(); // both trim events undo together
    const clip = findClip(store.getState().timeline, clipId)!.clip;
    expect(clip.start).toBe(6);
    expect(clip.duration).not.toBe(3);
  });

  it("selection changes are not undo steps", () => {
    const { store, clipId } = storeWithClip();
    selectClip(store, null);
    selectClip(store, clipId);
    store.undo(); // undoes the clip insertion, not the selection changes
    expect(store.getState().timeline.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(store.canUndo()).toBe(false);
  });

  it("ctrl-click toggles clips in and out of the multi-selection", () => {
    const store = createProductionStore();
    const a = addAssetToBin(store, { kind: "image", path: "/media/a.png" });
    const b = addAssetToBin(store, { kind: "image", path: "/media/b.png" });
    addAssetClip(store, a.id);
    const firstId = store.getState().selectedClipId!;
    addAssetClip(store, b.id);
    const secondId = store.getState().selectedClipId!;

    toggleClipInSelection(store, firstId);
    let state = store.getState();
    expect(state.selectedClipIds).toEqual([secondId, firstId]);
    expect(state.selectedClipId).toBe(firstId);
    expect(state.activeAssetId).toBeNull();

    toggleClipInSelection(store, firstId);
    state = store.getState();
    expect(state.selectedClipIds).toEqual([secondId]);
    expect(state.selectedClipId).toBe(secondId);

    toggleClipInSelection(store, "missing");
    expect(store.getState().selectedClipIds).toEqual([secondId]);

    selectClip(store, firstId); // plain click collapses to a single selection
    expect(store.getState().selectedClipIds).toEqual([firstId]);
  });

  it("moveTimelineClipToTrack drops a clip onto another track and is undoable", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "video", path: "/media/a.mp4" });
    addAssetClip(store, asset.id, { atSec: 0 });
    const clipId = store.getState().selectedClipId!;
    const sourceTrackId = findClip(store.getState().timeline, clipId)!.track.id;
    addTimelineTrack(store, "video");
    const tracks = store.getState().timeline.tracks;
    const targetTrackId = tracks[tracks.length - 1].id;

    moveTimelineClipToTrack(store, clipId, targetTrackId, 4);
    let location = findClip(store.getState().timeline, clipId)!;
    expect(location.track.id).toBe(targetTrackId);
    expect(location.clip.start).toBe(4);

    store.undo();
    location = findClip(store.getState().timeline, clipId)!;
    expect(location.track.id).toBe(sourceTrackId);
  });

  it("replaceTimelineClipSelection swaps the selection and drops missing ids", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "audio", path: "/media/a.wav" });
    addAssetClip(store, asset.id, { atSec: 0 });
    const firstId = store.getState().selectedClipId!;
    addAssetClip(store, asset.id, { atSec: 10 });
    const secondId = store.getState().selectedClipId!;

    replaceTimelineClipSelection(store, [firstId, secondId, "missing"]);
    let state = store.getState();
    expect(state.selectedClipIds).toEqual([firstId, secondId]);
    expect(state.selectedClipId).toBe(secondId);
    expect(state.activeAssetId).toBeNull();

    replaceTimelineClipSelection(store, []);
    state = store.getState();
    expect(state.selectedClipIds).toEqual([]);
    expect(state.selectedClipId).toBeNull();
  });

  it("moves the whole multi-selection together and batch-deletes it", () => {
    const store = createProductionStore();
    const asset = addAssetToBin(store, { kind: "audio", path: "/media/a.wav" });
    addAssetClip(store, asset.id, { atSec: 0 });
    const firstId = store.getState().selectedClipId!;
    addAssetClip(store, asset.id, { atSec: 10 });
    const secondId = store.getState().selectedClipId!;
    toggleClipInSelection(store, firstId);

    const firstStart = findClip(store.getState().timeline, firstId)!.clip.start;
    const secondStart = findClip(store.getState().timeline, secondId)!.clip.start;
    moveTimelineClip(store, firstId, firstStart + 2);
    let state = store.getState();
    expect(findClip(state.timeline, firstId)!.clip.start).toBe(firstStart + 2);
    expect(findClip(state.timeline, secondId)!.clip.start).toBe(secondStart + 2);

    removeSelectedTimelineClips(store);
    state = store.getState();
    expect(findClip(state.timeline, firstId)).toBeNull();
    expect(findClip(state.timeline, secondId)).toBeNull();
    expect(state.selectedClipIds).toEqual([]);
    expect(state.selectedClipId).toBeNull();

    store.undo();
    expect(findClip(store.getState().timeline, firstId)).not.toBeNull();
    expect(findClip(store.getState().timeline, secondId)).not.toBeNull();
  });

  it("reset returns to a fresh state", () => {
    const { store } = storeWithClip();
    store.reset();
    const state = store.getState();
    expect(state.binAssets).toHaveLength(0);
    expect(state.timeline.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(state.gradeDocs).toEqual({});
    expect(state.audioEdits).toEqual({});
    expect(state.clipProps).toEqual({});
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });
});
