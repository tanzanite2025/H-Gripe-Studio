// Canvas Studio Actions: the Canvas preset's whitelisted ids must be backed
// by real run-scope resolution, and commits must produce host commands (run
// requests / preview requests / reports) instead of executing anything.

import { describe, expect, it } from "vitest";
import {
  builtinCanvasActions,
  commitCanvasProposal,
  reviewCanvasProposal,
  type CanvasActionContext,
} from "./canvasActions";
import { parseAgentProposal } from "./studioAgent";
import { guardProposal, presetAllowsAction, presetForWorkspace } from "../assistant/agentPreset";
import { GRAPH_VERSION, type WorkflowGraph } from "../graph/model";
import { emptyRegistry } from "../models/backendRegistry";

// a -> b -> c
const graph: WorkflowGraph = {
  version: GRAPH_VERSION,
  nodes: [
    { id: "a", kind: "imageSource", position: { x: 0, y: 0 }, params: {} },
    { id: "b", kind: "matchLightColor", position: { x: 0, y: 0 }, params: {} },
    { id: "c", kind: "save", position: { x: 0, y: 0 }, params: {} },
  ],
  edges: [
    { id: "e1", source: "a", sourcePort: "out", target: "b", targetPort: "in" },
    { id: "e2", source: "b", sourcePort: "out", target: "c", targetPort: "in" },
  ],
};

const ctx = (selected: string[] = []): CanvasActionContext => ({
  canvasId: "canvas-1",
  graph,
  selectedNodeIds: selected,
  registry: emptyRegistry(),
});

describe("canvas action registry", () => {
  it("every builtin id is whitelisted by the Canvas preset", () => {
    const preset = presetForWorkspace("canvas");
    for (const action of builtinCanvasActions().list()) {
      expect(presetAllowsAction(preset, action.id)).toBe(true);
    }
  });

  it("run_to_node resolves the real upstream scope in its dry run", () => {
    const plan = builtinCanvasActions().dryRun("run_to_node", ctx(), { nodeId: "b" });
    expect(plan.ok).toBe(true);
    expect(plan.costClass).toBe("local_compute");
    expect(plan.summary).toContain("2 node(s)"); // a + b, never c
  });

  it("run_downstream includes consumers plus their upstream needs", () => {
    const plan = builtinCanvasActions().dryRun("run_downstream", ctx(), { nodeId: "b" });
    expect(plan.ok).toBe(true);
    expect(plan.summary).toContain("3 node(s)"); // b, c, and a (c's input chain)
  });

  it("run actions refuse unknown nodes and empty selections", () => {
    const registry = builtinCanvasActions();
    expect(registry.dryRun("run_to_node", ctx(), { nodeId: "nope" }).ok).toBe(false);
    expect(registry.dryRun("run_selected_with_upstream", ctx()).ok).toBe(false);
    expect(registry.commit("run_to_node", ctx(), { nodeId: "nope" }).ok).toBe(false);
  });

  it("committed run actions produce run commands, not executions", () => {
    const result = builtinCanvasActions().commit("run_selected_with_upstream", ctx(["b"]));
    expect(result.ok).toBe(true);
    expect(result.command).toEqual({
      kind: "run",
      scope: { kind: "selection_with_upstream", canvasId: "canvas-1", nodeIds: ["b"] },
    });
  });

  it("explain_selected_nodes reports titles and wiring", () => {
    const result = builtinCanvasActions().commit("explain_selected_nodes", ctx(["b"]));
    expect(result.ok).toBe(true);
    expect(result.command?.kind).toBe("report");
    if (result.command?.kind !== "report") return;
    expect(result.command.text).toContain("b:");
    expect(result.command.text).toContain("1 input edge(s), 1 output edge(s)");
  });

  it("validate_backend_refs runs the manager registry check", () => {
    const result = builtinCanvasActions().commit("validate_backend_refs", ctx());
    expect(result.ok).toBe(true);
    expect(result.command?.kind).toBe("report");
  });

  it("open_node_result_preview requests the shared preview modal", () => {
    const result = builtinCanvasActions().commit("open_node_result_preview", ctx(), {
      nodeId: "c",
      portId: "out",
    });
    expect(result.command).toEqual({
      kind: "open_preview",
      canvasId: "canvas-1",
      nodeId: "c",
      portId: "out",
    });
  });
});

describe("canvas agent chain", () => {
  it("parse -> preset guard -> review -> commit for a valid proposal", () => {
    const registry = builtinCanvasActions();
    const parsed = parseAgentProposal(
      {
        intent: "check the graph then run to the color node",
        steps: [
          { actionId: "validate_backend_refs" },
          { actionId: "run_to_node", params: { nodeId: "b" } },
        ],
      },
      registry,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("canvas")).ok).toBe(true);

    const review = reviewCanvasProposal(parsed.proposal, registry, ctx());
    expect(review.ok).toBe(true);
    expect(review.status).toBe("waiting_confirmation");

    const committed = commitCanvasProposal(parsed.proposal, registry, ctx());
    expect(committed.ok).toBe(true);
    expect(committed.commands.map((c) => c.kind)).toEqual(["report", "run"]);
  });

  it("rejects non-canvas ids at parse time and cross-preset ids at the guard", () => {
    const registry = builtinCanvasActions();
    expect(
      parseAgentProposal(
        { intent: "x", steps: [{ actionId: "feather_layer_mask" }] },
        registry,
      ).ok,
    ).toBe(false);
    // An id the canvas registry knows is still out of bounds for another preset.
    const parsed = parseAgentProposal(
      { intent: "x", steps: [{ actionId: "run_to_node", params: { nodeId: "b" } }] },
      registry,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("settings")).ok).toBe(false);
  });

  it("review and commit stop at the first refused step", () => {
    const registry = builtinCanvasActions();
    const proposal = {
      intent: "bad node",
      steps: [
        { actionId: "run_to_node", params: { nodeId: "nope" } },
        { actionId: "validate_backend_refs" },
      ],
    };
    const review = reviewCanvasProposal(proposal, registry, ctx());
    expect(review.ok).toBe(false);
    expect(review.status).toBe("rejected");
    expect(review.steps).toHaveLength(1);

    const committed = commitCanvasProposal(proposal, registry, ctx());
    expect(committed.ok).toBe(false);
    expect(committed.failedStep).toBe("run_to_node");
    expect(committed.commands).toHaveLength(0);
  });
});
