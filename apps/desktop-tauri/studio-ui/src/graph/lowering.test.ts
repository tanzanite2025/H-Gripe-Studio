import { describe, expect, it } from "vitest";

import { lowerWorkflowGraph, originNodeId } from "./lowering";
import { GRAPH_VERSION, type WorkflowGraph } from "./model";
import { validateGraph } from "../runtime/dag";

function graph(partial: Pick<WorkflowGraph, "nodes" | "edges">): WorkflowGraph {
  return { version: GRAPH_VERSION, ...partial };
}

const pos = { x: 0, y: 0 };

describe("lowerWorkflowGraph", () => {
  it("returns the graph unchanged when there is no imageProcessing card", () => {
    const g = graph({
      nodes: [{ id: "a", kind: "imageSource", position: pos, params: {} }],
      edges: [],
    });
    const { graph: lowered, origin } = lowerWorkflowGraph(g);
    expect(lowered).toBe(g);
    expect(origin.size).toBe(0);
  });

  it("lowers a wired grade row to a hidden imageGrade node with rewritten edges", () => {
    const g = graph({
      nodes: [
        { id: "src", kind: "imageSource", position: pos, params: { path: "a.png" } },
        {
          id: "proc",
          kind: "imageProcessing",
          position: pos,
          params: { "grade.format": "tiff", "crop.mode": "manual" },
        },
        { id: "prev", kind: "preview", position: pos, params: {} },
      ],
      edges: [
        { id: "e1", source: "src", sourcePort: "image", target: "proc", targetPort: "grade.in" },
        { id: "e2", source: "proc", sourcePort: "grade.out", target: "prev", targetPort: "image" },
      ],
    });
    const { graph: lowered, origin } = lowerWorkflowGraph(g);

    // The card is replaced by exactly the one row the graph wires.
    expect(lowered.nodes.map((n) => n.kind).sort()).toEqual([
      "imageGrade",
      "imageSource",
      "preview",
    ]);
    const gradeNode = lowered.nodes.find((n) => n.kind === "imageGrade");
    expect(gradeNode).toBeDefined();
    expect(origin.get(gradeNode!.id)).toBe("proc");
    expect(originNodeId(origin, gradeNode!.id)).toBe("proc");
    // Row params are un-prefixed; other rows' params are not forwarded.
    expect(gradeNode!.params).toEqual({ format: "tiff" });
    // Edges land on the leaf node's real ports.
    expect(lowered.edges).toEqual([
      { id: "e1", source: "src", sourcePort: "image", target: gradeNode!.id, targetPort: "image" },
      { id: "e2", source: gradeNode!.id, sourcePort: "image", target: "prev", targetPort: "image" },
    ]);
    // The lowered graph validates against the leaf specs.
    expect(validateGraph(lowered)).toEqual([]);
  });

  it("creates one leaf node per wired row and maps the repair report input", () => {
    const g = graph({
      nodes: [
        { id: "src", kind: "imageSource", position: pos, params: {} },
        { id: "proc", kind: "imageProcessing", position: pos, params: {} },
      ],
      edges: [
        { id: "e1", source: "src", sourcePort: "image", target: "proc", targetPort: "mask.in" },
        { id: "e2", source: "src", sourcePort: "image", target: "proc", targetPort: "repair.in" },
        { id: "e3", source: "src", sourcePort: "image", target: "proc", targetPort: "repair.report" },
      ],
    });
    const { graph: lowered } = lowerWorkflowGraph(g);
    expect(lowered.nodes.map((n) => n.kind).sort()).toEqual([
      "detailRepaint",
      "imageSource",
      "subjectMask",
    ]);
    const repaint = lowered.nodes.find((n) => n.kind === "detailRepaint")!;
    const targets = lowered.edges
      .filter((e) => e.target === repaint.id)
      .map((e) => e.targetPort)
      .sort();
    expect(targets).toEqual(["image", "quality_report"]);
  });

  it("lowers videoProcessing rows to videoAssemble / videoTrim", () => {
    const g = graph({
      nodes: [
        { id: "vid", kind: "videoSource", position: pos, params: { path: "a.mp4" } },
        {
          id: "proc",
          kind: "videoProcessing",
          position: pos,
          params: { "trim.start_sec": 1, "trim.end_sec": 5, "assemble.fps": 30 },
        },
      ],
      edges: [
        { id: "e1", source: "vid", sourcePort: "video", target: "proc", targetPort: "trim.in" },
      ],
    });
    const { graph: lowered, origin } = lowerWorkflowGraph(g);
    // Only the wired trim row is created.
    expect(lowered.nodes.map((n) => n.kind).sort()).toEqual(["videoSource", "videoTrim"]);
    const trim = lowered.nodes.find((n) => n.kind === "videoTrim")!;
    expect(origin.get(trim.id)).toBe("proc");
    expect(trim.params).toEqual({ start_sec: 1, end_sec: 5 });
    expect(lowered.edges).toEqual([
      { id: "e1", source: "vid", sourcePort: "video", target: trim.id, targetPort: "video" },
    ]);
    expect(validateGraph(lowered)).toEqual([]);
  });
});
