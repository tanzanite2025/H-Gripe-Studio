import { useSyncExternalStore } from "react";

export type LayerMoveDelta = readonly [number, number] | null;

export interface LayerMovePreviewTransaction {
  transactionId: string;
  baseDocumentKey: string;
  selectedLayerId: string;
  sequence: number;
  delta: LayerMoveDelta;
  phase: "dragging" | "committing";
}

export interface LayerMovePreviewStore {
  getSnapshot: () => LayerMovePreviewTransaction | null;
  subscribe: (listener: () => void) => () => void;
  begin: (baseDocumentKey: string, selectedLayerId: string) => void;
  update: (delta: LayerMoveDelta) => void;
  complete: (delta: LayerMoveDelta) => void;
  release: (transactionId: string) => void;
  dispose: () => void;
}

export function createLayerMovePreviewStore(): LayerMovePreviewStore {
  let transactionCounter = 0;
  let current: LayerMovePreviewTransaction | null = null;
  let pendingDelta: LayerMoveDelta = null;
  let raf: number | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const publishDelta = (delta: LayerMoveDelta) => {
    if (!current || current.phase !== "dragging") return;
    current = {
      ...current,
      sequence: current.sequence + 1,
      delta,
    };
    notify();
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
      return () => listeners.delete(listener);
    },
    begin: (baseDocumentKey, selectedLayerId) => {
      if (current?.phase === "committing") return;
      cancelQueuedFrame();
      pendingDelta = null;
      transactionCounter += 1;
      current = {
        transactionId: `layer-move-${transactionCounter}`,
        baseDocumentKey,
        selectedLayerId,
        sequence: 0,
        delta: null,
        phase: "dragging",
      };
      notify();
    },
    update: (delta) => {
      if (!current || current.phase !== "dragging") return;
      pendingDelta = delta;
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        publishDelta(pendingDelta);
      });
    },
    complete: (delta) => {
      pendingDelta = null;
      cancelQueuedFrame();
      if (!current) return;
      if (!delta) {
        current = null;
        notify();
        return;
      }
      const changed = current.delta?.[0] !== delta[0] || current.delta?.[1] !== delta[1];
      current = {
        ...current,
        sequence: current.sequence + (changed ? 1 : 0),
        delta,
        phase: "committing",
      };
      notify();
    },
    release: (transactionId) => {
      if (current?.transactionId !== transactionId) return;
      current = null;
      notify();
    },
    dispose: () => {
      pendingDelta = null;
      cancelQueuedFrame();
      current = null;
      listeners.clear();
    },
  };
}

export function useLayerMovePreviewTransaction(
  store: LayerMovePreviewStore,
): LayerMovePreviewTransaction | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
