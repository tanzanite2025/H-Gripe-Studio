import { afterEach, describe, expect, it, vi } from "vitest";

import {
  builtinModelApiActions,
  commitModelApiProposal,
  reviewModelApiProposal,
  type ModelApiActionContext,
} from "./modelApiActions";
import { parseAgentProposal } from "./studioAgent";
import { guardProposal, presetAllowsAction, presetForWorkspace } from "../assistant/agentPreset";
import {
  emptyRegistry,
  upsertApiProfile,
  type ApiProfileEntry,
  type BackendRegistry,
} from "../models/backendRegistry";

const profile = (overrides: Partial<ApiProfileEntry> = {}): ApiProfileEntry => ({
  ref: "openai-main",
  display_name: "OpenAI main",
  provider_kind: "openai-compatible",
  base_url: "https://api.example.com",
  credentials_ref: "secret://openai",
  default_model: "gpt-test",
  known_models: [],
  capabilities: ["text.generate"],
  health: "untested",
  ...overrides,
});

function ctx(registry: BackendRegistry): ModelApiActionContext & { persisted: BackendRegistry[] } {
  const persisted: BackendRegistry[] = [];
  return { registry, persist: (next) => persisted.push(next), persisted };
}

afterEach(() => vi.unstubAllGlobals());

describe("API-profile action registry", () => {
  it("whitelists every built-in action in the Model/API preset", () => {
    const preset = presetForWorkspace("model_api");
    for (const action of builtinModelApiActions().list()) {
      expect(presetAllowsAction(preset, action.id)).toBe(true);
    }
  });

  it("tests API reachability and persists health", async () => {
    const actions = builtinModelApiActions();
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    expect(actions.dryRun("test_api_profile", context, { ref: "nope" }).ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await actions.commit("test_api_profile", context, { ref: "openai-main" });
    expect(result.command).toEqual({
      kind: "report",
      text: "API profile openai-main: reachable (health: valid)",
    });
    expect(context.persisted[0].apiProfiles[0].health).toBe("valid");
  });

  it("marks unreachable API endpoints", async () => {
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await builtinModelApiActions().commit("test_api_profile", context, { ref: "openai-main" });
    expect(context.persisted[0].apiProfiles[0].health).toBe("unreachable");
  });

  it("reports missing API capability coverage and unhealthy profiles", async () => {
    const registry = upsertApiProfile(emptyRegistry(), profile({ health: "unreachable" }));
    const result = await builtinModelApiActions().commit(
      "show_missing_capability_report",
      ctx(registry),
    );
    if (result.command?.kind !== "report") throw new Error("expected report");
    expect(result.command.text).toContain("capabilities without a configured API profile");
    expect(result.command.text).toContain("image.generate");
    expect(result.command.text).toContain("API profile openai-main: unreachable");
  });

  it("opens the API profile manager with an optional capability filter", async () => {
    const result = await builtinModelApiActions().commit(
      "open_model_api_manager",
      ctx(emptyRegistry()),
      { capability: "image.edit" },
    );
    expect(result.command).toEqual({ kind: "open_manager", capability: "image.edit" });
  });
});

describe("API-profile agent chain", () => {
  it("parses, reviews and commits a valid proposal", async () => {
    const actions = builtinModelApiActions();
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const parsed = parseAgentProposal(
      {
        intent: "check provider health",
        steps: [{ actionId: "test_api_profile", params: { ref: "openai-main" } }],
      },
      actions,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("model_api")).ok).toBe(true);
    expect(reviewModelApiProposal(parsed.proposal, actions, context).ok).toBe(true);
    expect((await commitModelApiProposal(parsed.proposal, actions, context)).ok).toBe(true);
  });

  it("rejects an unknown API profile", async () => {
    const actions = builtinModelApiActions();
    const proposal = {
      intent: "bad ref",
      steps: [{ actionId: "test_api_profile", params: { ref: "nope" } }],
    };
    expect(reviewModelApiProposal(proposal, actions, ctx(emptyRegistry())).ok).toBe(false);
    expect((await commitModelApiProposal(proposal, actions, ctx(emptyRegistry()))).failedStep).toBe(
      "test_api_profile",
    );
  });
});
