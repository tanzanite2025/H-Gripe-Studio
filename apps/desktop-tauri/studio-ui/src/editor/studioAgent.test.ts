// Agent boundary (plan step 8): agents may only propose approved Studio
// Actions; the runtime parses (fail-closed), dry-runs the whole proposal at
// a preview gate, and commits only on user confirmation — every step an
// ordinary undo record.

import { describe, expect, it } from "vitest";
import { builtinStudioActions } from "./studioAction";
import {
  commitProposal,
  parseAgentProposal,
  reviewProposal,
  type AgentProposal,
} from "./studioAgent";
import { addLayerMask, initEditState, undo } from "./imageEditorState";
import type { StudioDocumentRef } from "./studioTarget";

const ref: StudioDocumentRef = { canvasId: "canvas-1", documentId: "node-1/edit_paths" };

describe("parseAgentProposal", () => {
  const registry = builtinStudioActions();

  it("accepts only approved action ids", () => {
    const result = parseAgentProposal(
      { intent: "mask then feather", steps: [{ actionId: "create_layer_mask" }, { actionId: "feather_layer_mask", params: { radiusPx: 2 } }] },
      registry,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unapproved actions (no UI ops, no raw document writes)", () => {
    const result = parseAgentProposal(
      { intent: "sneaky", steps: [{ actionId: "click_toolbar" }] },
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not an approved studio action/);
  });

  it("rejects malformed payloads and empty step lists", () => {
    expect(parseAgentProposal(null, registry).ok).toBe(false);
    expect(parseAgentProposal({ intent: "x", steps: [] }, registry).ok).toBe(false);
    expect(parseAgentProposal({ intent: "x", steps: [{}] }, registry).ok).toBe(false);
  });
});

describe("reviewProposal (preview gate)", () => {
  const registry = builtinStudioActions();

  it("plans steps sequentially without mutating the live state", () => {
    const state = initEditState();
    const proposal: AgentProposal = {
      intent: "add a mask, feather 2px",
      steps: [
        { actionId: "create_layer_mask" },
        { actionId: "feather_layer_mask", params: { radiusPx: 2 } },
      ],
    };
    const review = reviewProposal(proposal, registry, state, ref);
    expect(review.ok).toBe(true);
    expect(review.status).toBe("waiting_confirmation");
    expect(review.steps.map((s) => s.plan.target)).toEqual([
      expect.stringMatching(/^pixel_layer\(/),
      expect.stringMatching(/^layer_mask\(/),
    ]);
    expect(state.current.layers[0].mask).toBeUndefined(); // gate did not commit
  });

  it("rejects when a step's dry run fails", () => {
    const state = initEditState();
    const review = reviewProposal(
      { intent: "feather nothing", steps: [{ actionId: "feather_layer_mask", params: { radiusPx: 2 } }] },
      registry,
      state,
      ref,
    );
    expect(review.ok).toBe(false);
    expect(review.status).toBe("rejected");
    expect(review.steps[0].plan.summary).toMatch(/not accepted/);
  });
});

describe("commitProposal (user-confirmed)", () => {
  const registry = builtinStudioActions();

  it("commits each step as its own undo record", () => {
    const proposal: AgentProposal = {
      intent: "mask + sam + feather",
      steps: [
        { actionId: "create_layer_mask" },
        { actionId: "record_point_selection", params: { points: [{ x: 5, y: 6, label: 1 }] } },
        { actionId: "feather_layer_mask", params: { radiusPx: 3 } },
      ],
    };
    const result = commitProposal(proposal, registry, initEditState(), ref);
    expect(result.ok).toBe(true);
    expect(result.summaries).toHaveLength(3);
    const doc = result.state.current;
    expect(doc.layers).toHaveLength(1); // never a new layer
    expect(doc.layers[0].mask!.ops).toEqual([{ type: "feather", amount: 3 }]);
    expect(doc.points).toEqual([{ x: 5, y: 6, label: 1 }]);

    const back1 = undo(result.state);
    expect(back1.current.layers[0].mask!.ops).toEqual([]);
    const back2 = undo(back1);
    expect(back2.current.points).toEqual([]);
    const back3 = undo(back2);
    expect(back3.current.layers[0].mask).toBeUndefined();
  });

  it("stops at the first refusing step, keeping earlier commits", () => {
    const state = addLayerMask(initEditState(), 0);
    const proposal: AgentProposal = {
      intent: "feather then re-mask",
      steps: [
        { actionId: "feather_layer_mask", params: { radiusPx: 2 } },
        { actionId: "create_layer_mask" }, // refuses: target resolves to the mask
      ],
    };
    const result = commitProposal(proposal, registry, state, ref);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("create_layer_mask");
    expect(result.summaries).toHaveLength(1);
    expect(result.state.current.layers[0].mask!.ops).toEqual([{ type: "feather", amount: 2 }]);
  });
});
