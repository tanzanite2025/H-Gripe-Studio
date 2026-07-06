// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@hgripe/flow";

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

  it("openCanvasWith opens a loaded workflow in a new tab without touching the active one", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: true });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    let outcome: string | undefined;
    act(() => {
      outcome = result.current.openCanvasWith({
        nodes: [node("b")],
        edges: [],
        path: "C:/flows/other.json",
      });
    });

    expect(outcome).toBe("opened");
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.documentId).not.toBe(firstId);
    expect(result.current.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(file.set).toHaveBeenLastCalledWith("C:/flows/other.json", false);
    // The parked tab keeps its graph and file state.
    expect(result.current.tabs[0]).toMatchObject({ path: "C:/flows/hero.json", dirty: true });
    act(() => result.current.activateCanvas(firstId));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("openCanvasWith activates the existing tab when the path is already open", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.openNewCanvas());

    let outcome: string | undefined;
    act(() => {
      outcome = result.current.openCanvasWith({
        nodes: [node("stale")],
        edges: [],
        path: "C:/flows/hero.json",
      });
    });

    expect(outcome).toBe("activated");
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.documentId).toBe(firstId);
    // The parked tab's own graph wins over the re-read content.
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("openCanvasWith is a no-op when the path is the active canvas", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));

    let outcome: string | undefined;
    act(() => {
      outcome = result.current.openCanvasWith({
        nodes: [node("stale")],
        edges: [],
        path: "C:/flows/hero.json",
      });
    });

    expect(outcome).toBe("already-active");
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("exportCanvases captures the live active tab and parked tabs verbatim", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("a")], edges: [] }));
    const file = bridge({ path: "C:/flows/hero.json", dirty: true });
    act(() => result.current.registerFileBridge(file.bridge));
    const firstId = result.current.documentId;

    act(() => result.current.openNewCanvas());
    const secondId = result.current.documentId;

    const exported = result.current.exportCanvases({ path: null, dirty: false });
    expect(exported.activeCanvasId).toBe(secondId);
    expect(exported.canvases.map((c) => c.id)).toEqual([firstId, secondId]);
    expect(exported.canvases[0]).toMatchObject({ path: "C:/flows/hero.json", dirty: true });
    expect(exported.canvases[0].nodes.map((n) => n.id)).toEqual(["a"]);
    expect(exported.canvases[1]).toMatchObject({ path: null, dirty: false, nodes: [] });
  });

  it("restoreCanvases replaces the open set and activates the flagged tab", () => {
    const { result } = renderHook(() => useCanvasDocument({ nodes: [node("z")], edges: [] }));
    const file = bridge({ path: null, dirty: false });
    act(() => result.current.registerFileBridge(file.bridge));

    const viewport = { x: 4, y: 8, zoom: 2 };
    act(() =>
      result.current.restoreCanvases("c2", [
        {
          id: "c1",
          path: "C:/flows/a.json",
          dirty: false,
          selectedNodeId: null,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [node("a")],
          edges: [],
        },
        {
          id: "c2",
          path: null,
          dirty: true,
          selectedNodeId: "b",
          viewport,
          nodes: [node("b")],
          edges: [],
        },
      ]),
    );

    expect(result.current.tabs.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(result.current.documentId).toBe("c2");
    expect(result.current.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(result.current.selectedId).toBe("b");
    expect(result.current.viewport).toEqual(viewport);
    expect(file.set).toHaveBeenLastCalledWith(null, true);

    act(() => result.current.activateCanvas("c1"));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(file.set).toHaveBeenLastCalledWith("C:/flows/a.json", false);
  });
});
