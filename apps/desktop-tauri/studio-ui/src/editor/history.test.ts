import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { createHistoryStack, findHeavyGraphData, type GraphSnapshot } from "./history";

function snap(label: string): GraphSnapshot {
  return { nodes: [{ id: label, position: { x: 0, y: 0 }, data: {} } as Node], edges: [] as Edge[] };
}

describe("createHistoryStack", () => {
  it("undo returns the prior snapshot and redo restores the later one", () => {
    const h = createHistoryStack();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);

    // Edit A -> B: snapshot A before applying B.
    h.push(snap("A"));
    expect(h.canUndo()).toBe(true);

    // Undo from current B → restores A, stashes B for redo.
    const back = h.undo(snap("B"));
    expect(back?.nodes[0].id).toBe("A");
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    // Redo from current A → restores B.
    const fwd = h.redo(snap("A"));
    expect(fwd?.nodes[0].id).toBe("B");
    expect(h.canRedo()).toBe(false);
    expect(h.canUndo()).toBe(true);
  });

  it("a new push after undo clears the redo stack", () => {
    const h = createHistoryStack();
    h.push(snap("A"));
    h.undo(snap("B"));
    expect(h.canRedo()).toBe(true);
    h.push(snap("C"));
    expect(h.canRedo()).toBe(false);
  });

  it("undo/redo on an empty stack return null", () => {
    const h = createHistoryStack();
    expect(h.undo(snap("X"))).toBeNull();
    expect(h.redo(snap("X"))).toBeNull();
  });

  it("respects the snapshot limit, dropping the oldest", () => {
    const h = createHistoryStack(2);
    h.push(snap("A"));
    h.push(snap("B"));
    h.push(snap("C")); // drops A
    expect(h.undo(snap("D"))?.nodes[0].id).toBe("C");
    expect(h.undo(snap("C"))?.nodes[0].id).toBe("B");
    expect(h.canUndo()).toBe(false); // A was dropped
  });

  it("clear() drops all history", () => {
    const h = createHistoryStack();
    h.push(snap("A"));
    h.undo(snap("B"));
    h.clear();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});

describe("findHeavyGraphData", () => {
  function withData(data: Record<string, unknown>): GraphSnapshot {
    return { nodes: [{ id: "n1", position: { x: 0, y: 0 }, data } as Node], edges: [] };
  }

  it("passes light reference data (paths, ids, nested params)", () => {
    expect(
      findHeavyGraphData(
        withData({
          kind: "imageSource",
          imagePath: "C:/media/photo.png",
          params: { path: "C:/media/photo.png", nested: { ids: ["a", "b"] } },
        }),
      ),
    ).toBeNull();
  });

  it("flags data: URIs embedded in node data", () => {
    const heavy = findHeavyGraphData(
      withData({ kind: "imageSource", thumb: `data:image/png;base64,${"A".repeat(2000)}` }),
    );
    expect(heavy).toContain("data: URI");
    expect(heavy).toContain("n1");
  });

  it("flags oversized strings nested inside params", () => {
    const heavy = findHeavyGraphData(
      withData({ kind: "prompt", params: { log: "x".repeat(70 * 1024) } }),
    );
    expect(heavy).toContain("string over");
  });

  it("tolerates circular references in node data", () => {
    const cyc: Record<string, unknown> = { kind: "group" };
    cyc.self = cyc;
    expect(findHeavyGraphData(withData(cyc))).toBeNull();
  });
});
