import { describe, expect, it } from "vitest";
import { GRAPH_VERSION, type WorkflowGraph } from "../graph/model";
import { describeRunScope, resolveRunScope, type RunScope } from "./runScope";

function graph(partial: Pick<WorkflowGraph, "nodes" | "edges">): WorkflowGraph {
  return { version: GRAPH_VERSION, ...partial };
}

function node(id: string) {
  return { id, kind: "prompt", position: { x: 0, y: 0 }, params: {} };
}

function edge(source: string, target: string) {
  return { id: `${source}->${target}`, source, sourcePort: "out", target, targetPort: "in" };
}

// a -> b -> c -> d, plus an unrelated branch x -> y.
//           b also feeds a side consumer s.
const g = graph({
  nodes: [node("a"), node("b"), node("c"), node("d"), node("s"), node("x"), node("y")],
  edges: [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("b", "s"), edge("x", "y")],
});

const ids = (r: { graph: WorkflowGraph }) => new Set(r.graph.nodes.map((n) => n.id));

describe("resolveRunScope", () => {
  it("full_canvas returns the graph unchanged", () => {
    const r = resolveRunScope(g, { kind: "full_canvas", canvasId: "c1" });
    expect(r.graph).toBe(g);
    expect(r.warnings).toEqual([]);
  });

  it("node_upstream keeps the node and its transitive inputs only", () => {
    const r = resolveRunScope(g, { kind: "node_upstream", canvasId: "c1", nodeId: "c" });
    expect(ids(r)).toEqual(new Set(["a", "b", "c"]));
    expect(r.warnings).toEqual([]);
  });

  it("node_upstream on an unknown node degrades to full canvas with a warning", () => {
    const r = resolveRunScope(g, { kind: "node_upstream", canvasId: "c1", nodeId: "nope" });
    expect(ids(r)).toEqual(new Set(["a", "b", "c", "d", "s", "x", "y"]));
    expect(r.warnings).toHaveLength(1);
  });

  it("node_downstream keeps consumers plus the upstream they need", () => {
    const r = resolveRunScope(g, { kind: "node_downstream", canvasId: "c1", nodeId: "b" });
    // Descendants of b (b, c, d, s) plus their required upstream (a);
    // the unrelated x -> y branch stays out.
    expect(ids(r)).toEqual(new Set(["a", "b", "c", "d", "s"]));
  });

  it("selection_with_upstream includes dependencies outside the selection", () => {
    const r = resolveRunScope(g, {
      kind: "selection_with_upstream",
      canvasId: "c1",
      nodeIds: ["c", "y"],
    });
    expect(ids(r)).toEqual(new Set(["a", "b", "c", "x", "y"]));
    expect(r.warnings).toEqual([]);
  });

  it("selection_only keeps just the selected nodes and warns about cut inputs", () => {
    const r = resolveRunScope(g, { kind: "selection_only", canvasId: "c1", nodeIds: ["c", "d"] });
    expect(ids(r)).toEqual(new Set(["c", "d"]));
    expect(r.graph.edges).toEqual([edge("c", "d")]);
    expect(r.warnings).toEqual([
      'c: input "in" comes from b outside the selection and will be missing',
    ]);
  });

  it("empty selection degrades to full canvas with a warning", () => {
    const r = resolveRunScope(g, { kind: "selection_with_upstream", canvasId: "c1", nodeIds: [] });
    expect(r.graph.nodes).toHaveLength(7);
    expect(r.warnings).toHaveLength(1);
  });

  it("card resolves to the card's upstream chain", () => {
    const r = resolveRunScope(g, { kind: "card", canvasId: "c1", nodeId: "s" });
    expect(ids(r)).toEqual(new Set(["a", "b", "s"]));
  });

  it("card_row resolves to the card's upstream chain with a warning for now", () => {
    const r = resolveRunScope(g, { kind: "card_row", canvasId: "c1", nodeId: "s", rowId: "enhance" });
    expect(ids(r)).toEqual(new Set(["a", "b", "s"]));
    expect(r.warnings).toHaveLength(1);
  });
});

describe("describeRunScope", () => {
  it("labels every scope kind", () => {
    const scopes: RunScope[] = [
      { kind: "full_canvas", canvasId: "c1" },
      { kind: "node_upstream", canvasId: "c1", nodeId: "n" },
      { kind: "node_downstream", canvasId: "c1", nodeId: "n" },
      { kind: "selection_with_upstream", canvasId: "c1", nodeIds: ["n"] },
      { kind: "selection_only", canvasId: "c1", nodeIds: ["n"] },
      { kind: "card", canvasId: "c1", nodeId: "n" },
      { kind: "card_row", canvasId: "c1", nodeId: "n", rowId: "r" },
    ];
    for (const scope of scopes) {
      expect(describeRunScope(scope)).toBeTruthy();
    }
    expect(describeRunScope(scopes[1])).toBe("up to n");
  });
});
