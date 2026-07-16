import { describe, expect, it } from "vitest";

import { buildRunReport } from "./runReport";
import { lowerWorkflowGraph } from "../graph/lowering";
import { GRAPH_VERSION, type WorkflowGraph } from "../graph/model";

function graph(
  nodes: { id: string; kind: string; params?: Record<string, unknown> }[],
  edges: { source: string; sourcePort: string; target: string; targetPort: string }[] = [],
): WorkflowGraph {
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((n) => ({ ...n, params: n.params ?? {}, position: { x: 0, y: 0 } })),
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
  };
}

function report(authored: WorkflowGraph, scopeLabel = "full canvas") {
  const { graph: lowered, origin } = lowerWorkflowGraph(authored);
  return buildRunReport({ scopeLabel, authored, lowered, origin });
}

describe("buildRunReport", () => {
  it("summarises a plain graph without integrated cards", () => {
    const lines = report(
      graph([
        { id: "src", kind: "imageSource" },
        { id: "crop", kind: "crop" },
      ]),
    );
    expect(lines).toEqual(["scope full canvas: 2 node(s) to execute"]);
  });

  it("lists running vs skipped rows for integrated cards", () => {
    const authored = graph(
      [
        { id: "src", kind: "imageSource" },
        { id: "card", kind: "imageProcessing" },
      ],
      [{ source: "src", sourcePort: "image", target: "card", targetPort: "enhance.in" }],
    );
    const lines = report(authored, "card card");
    expect(lines[0]).toBe(
      "scope card card: 2 node(s) to execute (1 row(s) from 1 integrated card(s))",
    );
    expect(lines[1]).toBe(
      "card card: runs enhance; skips layerSplit, grade, crop, repair",
    );
  });

  it("reports an integrated card with no wired rows", () => {
    const lines = report(graph([{ id: "card", kind: "videoProcessing" }]));
    expect(lines[0]).toBe("scope full canvas: 0 node(s) to execute");
    expect(lines[1]).toBe("card card: no rows to run; skips assemble, trim");
  });

  it("reports API profile refs on executing nodes", () => {
    const authored = graph(
      [
        { id: "src", kind: "imageSource" },
        {
          id: "card",
          kind: "imageProcessing",
          params: {
            "repair.api_profile_ref": "openai-main",
          },
        },
      ],
      [
        { source: "src", sourcePort: "image", target: "card", targetPort: "enhance.in" },
        { source: "src", sourcePort: "image", target: "card", targetPort: "repair.in" },
      ],
    );
    const lines = report(authored);
    expect(lines).toContain('backend card::repair: api profile "openai-main"');
  });

  it("ignores stale backend refs that the node cannot execute", () => {
    const lines = report(
      graph([
        {
          id: "match",
          kind: "matchLightColor",
          params: {
            local_model_ref: "legacy-color-model",
            api_profile_ref: "legacy-api",
            device: "cuda",
          },
        },
      ]),
    );
    expect(lines).toEqual(["scope full canvas: 1 node(s) to execute"]);
  });
});
