import { describe, expect, it } from "vitest";
import { GRAPH_VERSION, type WorkflowGraph } from "../graph/model";
import { GROUP_KIND } from "./grouping";
import { buildRunPreview } from "./runPreview";

function graph(partial: Pick<WorkflowGraph, "nodes" | "edges">): WorkflowGraph {
  return { version: GRAPH_VERSION, ...partial };
}

function node(id: string, kind = "prompt") {
  return { id, kind, position: { x: 0, y: 0 }, params: {} };
}

function edge(source: string, target: string, targetPort = "in") {
  return { id: `${source}->${target}`, source, sourcePort: "out", target, targetPort };
}

describe("buildRunPreview", () => {
  it("counts every card for a full-canvas scope and excludes group frames", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("frame", GROUP_KIND)],
      edges: [edge("a", "b")],
    });
    const p = buildRunPreview(g, { kind: "full_canvas", canvasId: "c1" });
    expect(p.total).toBe(2);
    expect(p.warnings).toEqual([]);
    expect(p.groups.flatMap((grp) => grp.nodes.map((n) => n.id))).toEqual(["a", "b"]);
  });

  it("narrows to the selection plus upstream", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c"), node("x")],
      edges: [edge("a", "b"), edge("b", "c")],
    });
    const p = buildRunPreview(g, {
      kind: "selection_with_upstream",
      canvasId: "c1",
      nodeIds: ["c"],
    });
    expect(p.groups.flatMap((grp) => grp.nodes.map((n) => n.id)).sort()).toEqual(["a", "b", "c"]);
    expect(p.total).toBe(3);
  });

  it("surfaces resolver warnings for selection_only with cut-away inputs", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    });
    const p = buildRunPreview(g, { kind: "selection_only", canvasId: "c1", nodeIds: ["b"] });
    expect(p.total).toBe(1);
    expect(p.warnings).toHaveLength(1);
  });

  it("groups unknown kinds under internal instead of throwing", () => {
    const g = graph({ nodes: [node("z", "no-such-kind")], edges: [] });
    const p = buildRunPreview(g, { kind: "full_canvas", canvasId: "c1" });
    expect(p.groups).toEqual([
      { category: "internal", nodes: [{ id: "z", kind: "no-such-kind" }] },
    ]);
  });
});
