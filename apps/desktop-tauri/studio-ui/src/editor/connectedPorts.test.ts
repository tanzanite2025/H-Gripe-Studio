import { describe, expect, it } from "vitest";
import type { Edge } from "@hgripe/flow";
import { connectedInputPorts } from "./connectedPorts";

const edges: Edge[] = [
  { id: "e1", source: "a", target: "b", targetHandle: "image" },
  { id: "e2", source: "c", target: "b", targetHandle: "template" },
  { id: "e3", source: "a", target: "d", targetHandle: null },
];

describe("connectedInputPorts", () => {
  it("returns the sorted, comma-joined input ports for a node", () => {
    expect(connectedInputPorts(edges, "b")).toBe("image,template");
  });

  it("treats a missing targetHandle as the empty port", () => {
    expect(connectedInputPorts(edges, "d")).toBe("");
  });

  it("returns an empty string for nodes with no incoming edges", () => {
    expect(connectedInputPorts(edges, "a")).toBe("");
  });

  it("is referentially stable per edges revision", () => {
    expect(connectedInputPorts(edges, "b")).toBe(connectedInputPorts(edges, "b"));
    const next = [...edges, { id: "e4", source: "c", target: "b", targetHandle: "alpha" }];
    expect(connectedInputPorts(next, "b")).toBe("alpha,image,template");
  });
});
