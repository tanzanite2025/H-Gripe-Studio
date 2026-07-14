// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyImageEditorDocument, type ImageEditorDocument } from "../../contracts/imageEditorDocument";
import type { MaterializedLayerViaCopy } from "../../contracts/imageEditOps";
import type { EditState } from "../imageEditorState";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { useLayerDuplicateCommand } from "./useLayerDuplicateCommand";

const selection: ActiveSelection = {
  region: [20, 30, 24, 32],
  ellipse: false,
  polygon: [[20, 30], [24, 30], [24, 32]],
  source: "polygon_lasso",
  combineMode: "replace",
  antiAlias: true,
};

const materialized: MaterializedLayerViaCopy = {
  source: { path: "C:/copies/copy.png", width: 4, height: 2 },
  placement: [20, 30, 24, 32],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stateFor(document: ImageEditorDocument = emptyImageEditorDocument()): EditState {
  document.layers[0] = { ...document.layers[0], id: "layer-1" };
  return { current: document, past: [], future: [] };
}

function selectionState(initial: ActiveSelection | null) {
  const ref = { current: initial };
  const set = vi.fn((update: SetStateAction<ActiveSelection | null>) => {
    ref.current = typeof update === "function" ? update(ref.current) : update;
  }) as unknown as Dispatch<SetStateAction<ActiveSelection | null>>;
  return { ref, set };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLayerDuplicateCommand", () => {
  it("keeps ordinary duplicate synchronous when there is no active selection", () => {
    const stateRef = { current: stateFor() };
    const active = selectionState(null);
    const dispatch = vi.fn();
    const materialize = vi.fn();
    const { result } = renderHook(() => useLayerDuplicateCommand({
      imagePath: "C:/images/base.png",
      dimensions: { w: 80, h: 60 },
      stateRef,
      activeSelectionRef: active.ref,
      setActiveSelection: active.set,
      selectionDraft: null,
      dispatch,
      materialize,
    }));

    act(() => result.current.runLayerDuplicate());

    expect(dispatch).toHaveBeenCalledWith({ type: "layer_duplicate" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("waits for compact pixels and then emits exactly one commit", async () => {
    const gate = deferred<MaterializedLayerViaCopy | null>();
    const stateRef = { current: stateFor() };
    const active = selectionState(selection);
    const dispatch = vi.fn();
    const materialize = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useLayerDuplicateCommand({
      imagePath: "C:/images/base.png",
      dimensions: { w: 80, h: 60 },
      stateRef,
      activeSelectionRef: active.ref,
      setActiveSelection: active.set,
      selectionDraft: null,
      dispatch,
      materialize,
    }));

    act(() => {
      result.current.runLayerDuplicate();
      result.current.runLayerDuplicate();
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      selectedLayerId: "layer-1",
      selection: {
        region: [20, 30, 24, 32],
        points: [[20, 30], [24, 30], [24, 32]],
      },
    }));

    gate.resolve(materialized);
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      type: "layer_via_copy_commit",
      baseDocument: stateRef.current.current,
      sourceLayerId: "layer-1",
      materialized,
    });
    expect(active.ref.current).toBeNull();
    await waitFor(() => expect(result.current.layerDuplicatePending).toBe(false));
  });

  it("does not start while a selection draft is uncommitted", () => {
    const draft: SelectionDraft = { region: [1, 2, 3, 4], ellipse: false, status: "closed" };
    const active = selectionState(selection);
    const dispatch = vi.fn();
    const materialize = vi.fn();
    const { result } = renderHook(() => useLayerDuplicateCommand({
      dimensions: { w: 80, h: 60 },
      stateRef: { current: stateFor() },
      activeSelectionRef: active.ref,
      setActiveSelection: active.set,
      selectionDraft: draft,
      dispatch,
      materialize,
    }));

    act(() => result.current.runLayerDuplicate());

    expect(dispatch).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(active.ref.current).toBe(selection);
  });

  it("discards empty, failed, and stale results without clearing the selection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const outcome of [null, new Error("failed"), materialized] as const) {
      const gate = deferred<MaterializedLayerViaCopy | null>();
      const stateRef = { current: stateFor() };
      const active = selectionState(selection);
      const dispatch = vi.fn();
      const { result, unmount } = renderHook(() => useLayerDuplicateCommand({
        dimensions: { w: 80, h: 60 },
        stateRef,
        activeSelectionRef: active.ref,
        setActiveSelection: active.set,
        selectionDraft: null,
        dispatch,
        materialize: () => gate.promise,
      }));
      act(() => result.current.runLayerDuplicate());
      if (outcome === materialized) stateRef.current = stateFor();
      if (outcome instanceof Error) gate.reject(outcome);
      else gate.resolve(outcome);
      await waitFor(() => expect(result.current.layerDuplicatePending).toBe(false));
      expect(dispatch).not.toHaveBeenCalled();
      expect(active.ref.current).toBe(selection);
      unmount();
    }
    expect(warn).toHaveBeenCalledOnce();
  });
});
