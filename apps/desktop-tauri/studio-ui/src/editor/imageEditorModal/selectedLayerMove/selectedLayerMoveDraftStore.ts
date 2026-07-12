import { useSyncExternalStore } from "react";

export type SelectedLayerMoveDraft = readonly [number, number] | null;

export interface SelectedLayerMoveDraftStore {
  getSnapshot: () => SelectedLayerMoveDraft;
  subscribe: (listener: () => void) => () => void;
  setDraft: (draft: SelectedLayerMoveDraft) => void;
  dispose: () => void;
}

export function createSelectedLayerMoveDraftStore(): SelectedLayerMoveDraftStore {
  let current: SelectedLayerMoveDraft = null;
  let pending: SelectedLayerMoveDraft = null;
  let raf: number | null = null;
  const listeners = new Set<() => void>();

  const publish = (draft: SelectedLayerMoveDraft) => {
    current = draft;
    for (const listener of listeners) listener();
  };

  const cancelQueuedFrame = () => {
    if (raf === null) return;
    window.cancelAnimationFrame(raf);
    raf = null;
  };

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft: (draft) => {
      if (draft === null) {
        pending = null;
        cancelQueuedFrame();
        publish(null);
        return;
      }
      pending = draft;
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        publish(pending);
      });
    },
    dispose: () => {
      pending = null;
      cancelQueuedFrame();
      listeners.clear();
      current = null;
    },
  };
}

export function useSelectedLayerMoveDraftSnapshot(store: SelectedLayerMoveDraftStore): SelectedLayerMoveDraft {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
