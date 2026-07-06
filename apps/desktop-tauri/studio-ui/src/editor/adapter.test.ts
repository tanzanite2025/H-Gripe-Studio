import { describe, expect, it } from "vitest";
import { HGRIPE_BINDING_EDGE_TYPE, HGRIPE_DATA_EDGE_TYPE, type Edge, type Node } from "@hgripe/flow";
import { fromWorkflowGraph, toWorkflowGraph } from "./adapter";
import type { HgripeNodeData } from "./HgripeNode";
import { deserializeGraph, serializeGraph } from "../graph/model";

const nodes: Node[] = [
  {
    id: "prompt-1",
    type: "hgripe",
    position: { x: 10, y: 20 },
    data: { kind: "promptOptimize", params: { text: "hi" }, status: "idle" } satisfies HgripeNodeData,
  },
  {
    id: "generate-1",
    type: "hgripe",
    position: { x: 200, y: 40 },
    data: { kind: "generate", params: { provider: "mock", steps: 20 }, status: "idle" } satisfies HgripeNodeData,
  },
];
const edges: Edge[] = [
  { id: "e1", source: "prompt-1", sourceHandle: "text", target: "generate-1", targetHandle: "prompt" },
];

describe("adapter round-trip", () => {
  it("toWorkflowGraph then fromWorkflowGraph preserves nodes/edges", () => {
    const graph = toWorkflowGraph(nodes, edges);
    const back = fromWorkflowGraph(graph);

    expect(back.nodes.map((n) => n.id)).toEqual(["prompt-1", "generate-1"]);
    expect(back.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect((back.nodes[0].data as HgripeNodeData).params.text).toBe("hi");
    expect(back.edges).toEqual([
      {
        id: "e1",
        source: "prompt-1",
        sourceHandle: "text",
        target: "generate-1",
        targetHandle: "prompt",
        type: HGRIPE_DATA_EDGE_TYPE,
      },
    ]);
  });

  it("restores normal and binding edge render types from graph edges", () => {
    const back = fromWorkflowGraph({
      version: 1,
      nodes: [],
      edges: [
        { id: "e-normal", source: "a", sourcePort: "image", target: "b", targetPort: "image" },
        { id: "binding-edit-1", source: "a", sourcePort: "image", target: "edit-1", targetPort: "image" },
      ],
    });

    expect(back.edges.map((e) => e.type)).toEqual([HGRIPE_DATA_EDGE_TYPE, HGRIPE_BINDING_EDGE_TYPE]);
  });

  it("survives JSON serialize/deserialize", () => {
    const graph = toWorkflowGraph(nodes, edges);
    const restored = deserializeGraph(serializeGraph(graph));
    expect(restored).toEqual(graph);
  });

  it("merges saved params over the kind's current defaults", () => {
    // A graph saved before `steps`/`seed` existed should still get defaults.
    const graph = toWorkflowGraph(
      [
        {
          id: "g",
          type: "hgripe",
          position: { x: 0, y: 0 },
          data: { kind: "generate", params: { provider: "x" }, status: "idle" } satisfies HgripeNodeData,
        },
      ],
      [],
    );
    const back = fromWorkflowGraph(graph);
    const params = (back.nodes[0].data as HgripeNodeData).params;
    expect(params.provider).toBe("x");
    expect(params.steps).toBe(20); // default filled in
  });
});
