// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerMovePreviewStore } from "./layerMovePreviewStore";

afterEach(() => vi.restoreAllMocks());

describe("layer move preview store", () => {
  it("publishes one transaction with monotonic absolute-delta sequences", () => {
    let queued: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queued = callback;
      return 7;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const store = createLayerMovePreviewStore();

    store.begin("document-a", "layer-a");
    expect(store.getSnapshot()).toMatchObject({
      transactionId: "layer-move-1",
      baseDocumentKey: "document-a",
      selectedLayerId: "layer-a",
      sequence: 0,
      delta: null,
      phase: "dragging",
    });

    store.update([4, 2]);
    store.update([9, 5]);
    expect(store.getSnapshot()?.sequence).toBe(0);
    const frame = queued as FrameRequestCallback | null;
    expect(frame).not.toBeNull();
    frame?.(0);
    expect(store.getSnapshot()).toMatchObject({ sequence: 1, delta: [9, 5] });
  });

  it("holds the final draft while committing and releases only the matching transaction", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(11);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const store = createLayerMovePreviewStore();

    store.begin("document-a", "layer-a");
    store.update([12, 6]);
    store.complete([12, 6]);

    expect(cancel).toHaveBeenCalledWith(11);
    expect(store.getSnapshot()).toMatchObject({
      transactionId: "layer-move-1",
      sequence: 1,
      delta: [12, 6],
      phase: "committing",
    });
    store.release("another-transaction");
    expect(store.getSnapshot()).not.toBeNull();
    store.release("layer-move-1");
    expect(store.getSnapshot()).toBeNull();
  });

  it("clears a click immediately without entering the handoff", () => {
    const store = createLayerMovePreviewStore();
    store.begin("document-a", "layer-a");

    store.complete(null);

    expect(store.getSnapshot()).toBeNull();
  });
});
