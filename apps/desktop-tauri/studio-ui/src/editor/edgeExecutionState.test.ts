import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@hgripe/flow";
import {
  edgeExecutionVisualState,
  withEdgeExecutionStates,
} from "./edgeExecutionState";

describe("edgeExecutionVisualState", () => {
  it("marks edges touching the running node as active", () => {
    expect(edgeExecutionVisualState("running", "queued")).toBe("running");
    expect(edgeExecutionVisualState("succeeded", "running")).toBe("running");
  });

  it("gives failures priority over running state", () => {
    expect(edgeExecutionVisualState("running", "failed")).toBe("error");
    expect(edgeExecutionVisualState("cancelled", "running")).toBe("error");
  });

  it("keeps settled and queued paths neutral", () => {
    expect(edgeExecutionVisualState("succeeded", "queued")).toBe("default");
    expect(edgeExecutionVisualState(undefined, undefined)).toBe("default");
  });
});

describe("withEdgeExecutionStates", () => {
  it("decorates rendered edges without changing the graph edges", () => {
    const edges: Edge[] = [{ id: "e1", source: "a", target: "b", data: { value: 1 } }];
    const nodes = [
      { id: "a", position: { x: 0, y: 0 }, data: { status: "succeeded" } },
      { id: "b", position: { x: 1, y: 0 }, data: { status: "failed" } },
    ] as Node[];

    const rendered = withEdgeExecutionStates(edges, nodes);

    expect(rendered[0].data).toEqual({ value: 1, hgripeVisualState: "error" });
    expect(edges[0].data).toEqual({ value: 1 });
  });
});
