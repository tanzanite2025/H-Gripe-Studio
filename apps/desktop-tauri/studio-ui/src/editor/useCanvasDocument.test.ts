// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";

import { useCanvasDocument, type CanvasFileBridge } from "./useCanvasDocument";

function node(id: string): Node {
  return { id, type: "hgripe", position: { x: 0, y: 0 }, data: { kind: "prompt" } };
}

function bridge(initial: { path: string | null; dirty: boolean }): {
  bridge: CanvasFileBridge;
  state: { path: string | null; dirty: boolean };
  set: ReturnType<typeof vi.fn>;
} {
  const state = { ...initial };
  const set = vi.fn((path: string | null, dirty: boolean) => {
    state.path = path;
    state.dirty = dirty;
  });
  return { bridge: { get: () => ({ ...state }), set }, state, set };
}

describe("useCanvasDocument tabs", () => {
  it("starts with one tab wrapping the initial graph", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe(result.current.documentId);
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("openNewCanvas parks the active graph and starts empty, untitled", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: true });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.openNewCanvas());

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.documentId).not.toBe(firstId);
    expect(result.current.nodes).toEqual([]);
    // The new canvas is untitled and clean; the parked tab keeps its file state.
    expect(file.set).toHaveBeenCalledWith(null, false);
    expect(result.current.tabs[0]).toMatchObject({ path: "C:/flows/hero.json", dirty: true });
  });

  it("activateCanvas restores the parked graph, selection, and file state", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: true });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;
    act(() => result.current.setSelectedId("a"));

    act(() => result.current.openNewCanvas());
    expect(result.current.selectedId).toBeNull();

    act(() => result.current.activateCanvas(firstId));
    expect(result.current.documentId).toBe(firstId);
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(result.current.selectedId).toBe("a");
    expect(file.set).toHaveBeenLastCalledWith("C:/flows/hero.json", true);
  });

  it("closeCanvas of an inactive tab never touches the active canvas", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: null, dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.openNewCanvas());
    const secondId = result.current.documentId;

    act(() => result.current.closeCanvas(firstId));
    expect(result.current.tabs.map((t) => t.id)).toEqual([secondId]);
    expect(result.current.documentId).toBe(secondId);
  });

  it("closing the last tab replaces it with a fresh untitled canvas", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: null, dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.closeCanvas(firstId));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.documentId).not.toBe(firstId);
    expect(result.current.nodes).toEqual([]);
  });

  it("closing the active tab activates the remaining one", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: null, dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.openNewCanvas());
    const secondId = result.current.documentId;

    act(() => result.current.closeCanvas(secondId));
    expect(result.current.tabs.map((t) => t.id)).toEqual([firstId]);
    expect(result.current.documentId).toBe(firstId);
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("describe reports the wrapper plus controller-owned state", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const doc = result.current.describe({
      path: "C:/flows/hero.json",
      dirty: true,
      runState: "running",
      untitledLabel: "untitled",
    });
    expect(doc).toMatchObject({
      id: result.current.documentId,
      title: "hero.json",
      kind: "workflow",
      dirty: true,
      runState: "running",
      historyScopeId: result.current.documentId,
    });
  });
});
