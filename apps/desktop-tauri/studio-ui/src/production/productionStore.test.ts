import { describe, expect, it } from "vitest";

import {
  addAssetClip,
  addAssetToBin,
  addTimelineTrack,
  clearProductionSelection,
  clipGradeDocOf,
  clipGradeKey,
  commitAudioEdit,
  createProductionStore,
  removeAssetFromBin,
  removeTimelineClip,
  removeTimelineTrack,
  selectBinAsset,
  selectClip,
  setClipGradeDoc,
  type ProductionStore,
} from "./productionStore";
import { defaultAudioEdit } from "./audioEdit";
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

  it("reset returns to a fresh state", () => {
    const { store } = storeWithClip();
    store.reset();
    const state = store.getState();
    expect(state.binAssets).toHaveLength(0);
    expect(state.timeline.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(state.gradeDocs).toEqual({});
    expect(state.audioEdits).toEqual({});
  });
});
