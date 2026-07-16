// Page-context agent presets: preset resolution must follow the active
// workspace (with optional pinning), and the whitelist / cost gates must
// fail closed before any Studio Action write.

import { describe, expect, it } from "vitest";
import {
  costGateFor,
  costGateForPlans,
  describePageContext,
  guardProposal,
  listPresets,
  presetAllowsAction,
  presetAllowsRead,
  presetForWorkspace,
  resolvePreset,
  type PageContext,
} from "./agentPreset";
import { builtinStudioActions } from "../editor/studioAction";
import { parseAgentProposal } from "../editor/studioAgent";
import type { ActionPlan } from "../editor/studioAction";

const ctx = (workspace: PageContext["workspace"]): PageContext => ({ workspace });

describe("preset resolution", () => {
  it("auto mode follows the active workspace", () => {
    expect(resolvePreset(ctx("image_editor")).id).toBe("preset.image_editor");
    expect(resolvePreset(ctx("model_api")).id).toBe("preset.model_api");
  });

  it("a pinned mode overrides the page context", () => {
    expect(resolvePreset(ctx("image_editor"), "canvas").id).toBe("preset.canvas");
  });

  it("every workspace has exactly one preset", () => {
    const ids = listPresets().map((p) => p.id);
    expect(new Set(ids).size).toBe(6);
    for (const ws of ["project", "canvas", "image_editor", "timeline_grade", "model_api", "settings"] as const) {
      expect(presetForWorkspace(ws)).toBeDefined();
    }
  });

  it("registered image-editor studio actions are covered by the preset whitelist", () => {
    const preset = presetForWorkspace("image_editor");
    for (const action of builtinStudioActions().list()) {
      expect(presetAllowsAction(preset, action.id)).toBe(true);
    }
  });
});

describe("whitelist enforcement", () => {
  it("read scopes are preset-bounded", () => {
    const modelApi = presetForWorkspace("model_api");
    expect(presetAllowsRead(modelApi, "api_profile_registry_no_secrets")).toBe(true);
    expect(presetAllowsRead(modelApi, "layer_stack")).toBe(false);
  });

  it("forbidden ids stay rejected even if a whitelist would list them", () => {
    const preset = {
      ...presetForWorkspace("project"),
      allowedActionIds: ["change_api_secret"],
    };
    expect(presetAllowsAction(preset, "change_api_secret")).toBe(false);
  });

  it("guardProposal reports every out-of-preset step", () => {
    const preset = presetForWorkspace("image_editor");
    const result = guardProposal(
      {
        intent: "mask then export",
        steps: [
          { actionId: "record_point_selection" },
          { actionId: "run_full_canvas" },
          { actionId: "change_api_secret" },
        ],
      },
      preset,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain("run_full_canvas");
  });

  it("a parsed builtin-action proposal passes the image editor preset", () => {
    const registry = builtinStudioActions();
    const parsed = parseAgentProposal(
      {
        intent: "soften the mask",
        steps: [{ actionId: "feather_layer_mask", params: { radiusPx: 4 } }],
      },
      registry,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("image_editor")).ok).toBe(true);
    // The same proposal is out of bounds for the model/API preset.
    expect(guardProposal(parsed.proposal, presetForWorkspace("model_api")).ok).toBe(false);
  });
});

describe("cost gates", () => {
  it("maps cost class x policy to allow/confirm/refuse", () => {
    expect(costGateFor("free", "local_only")).toBe("allow");
    expect(costGateFor("local_compute", "confirm_api")).toBe("allow");
    expect(costGateFor("local_compute", "confirm_expensive")).toBe("confirm");
    expect(costGateFor("api_paid", "confirm_api")).toBe("confirm");
    expect(costGateFor("api_paid", "local_only")).toBe("refuse");
  });

  it("the strictest step gates the whole plan list", () => {
    const plan = (costClass: ActionPlan["costClass"]): ActionPlan => ({
      ok: true,
      action: "x",
      target: "t",
      costClass,
      summary: "",
    });
    const preset = presetForWorkspace("image_editor"); // confirm_expensive
    expect(costGateForPlans([plan("free")], preset)).toBe("allow");
    expect(costGateForPlans([plan("free"), plan("local_compute")], preset)).toBe("confirm");
    expect(
      costGateForPlans([plan("api_paid")], { ...preset, costPolicy: "local_only" }),
    ).toBe("refuse");
  });
});

describe("context summary", () => {
  it("summarises targets, selection, and scope", () => {
    const summary = describePageContext({
      workspace: "image_editor",
      activeDocumentId: "doc-1",
      selectedTargets: [
        { kind: "layer_mask", canvasId: "c1", documentId: "doc-1", layerId: "layer-7", maskId: "m1" },
      ],
      selectedNodeIds: ["n1", "n2", "n3"],
      activeRunScope: { kind: "node_upstream", canvasId: "c1", nodeId: "node-4" },
    });
    expect(summary).toContain("doc-1");
    expect(summary).toContain("layer-7");
    expect(summary).toContain("Selected Nodes: 3");
    expect(summary).toContain("node-4");
  });
});
