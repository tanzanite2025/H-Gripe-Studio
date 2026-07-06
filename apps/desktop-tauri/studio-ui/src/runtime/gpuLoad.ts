// Canvas-side GPU load flag: while heavy GPU work is in flight (a graph run,
// a grade/video preview render), the node canvas yields — it defers backend
// thumbnail decodes and drops cosmetic CSS transitions — so WebView
// compositing does not compete with the wgpu kernels for the device. This is
// a UI courtesy signal only; real GPU admission stays with the Rust
// scheduler's GPU lane (see `bridge/scheduler.ts`).
//
// Framework-agnostic external store (same pattern as `ingestStore`): a
// reentrant counter so overlapping sources (run + preview) compose.

import { useSyncExternalStore } from "react";

let depth = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Mark the start of heavy GPU work. Returns a disposer that ends it. */
export function beginGpuWork(): () => void {
  depth += 1;
  if (depth === 1) emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    depth -= 1;
    if (depth === 0) emit();
  };
}

/** True while any heavy GPU work is in flight. */
export function isGpuBusy(): boolean {
  return depth > 0;
}

export function subscribeGpuBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding: re-renders only when busy flips on/off. */
export function useGpuBusy(): boolean {
  return useSyncExternalStore(subscribeGpuBusy, isGpuBusy, isGpuBusy);
}

/**
 * Resolves once no heavy GPU work is in flight (immediately when idle).
 * Used to defer non-urgent decodes (e.g. card thumbnails) behind a run.
 */
export function whenGpuIdle(): Promise<void> {
  if (!isGpuBusy()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = subscribeGpuBusy(() => {
      if (!isGpuBusy()) {
        unsub();
        resolve();
      }
    });
  });
}
