// Model/API Studio Actions: the preset's whitelisted ids must run the real
// manager health checks and capability summaries, persist health like the
// manual test buttons, and commit only to host commands (open manager /
// report) — never touching a raw key.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  builtinModelApiActions,
  commitModelApiProposal,
  reviewModelApiProposal,
  type ModelApiActionContext,
} from "./modelApiActions";
import { parseAgentProposal } from "./studioAgent";
import { guardProposal, presetAllowsAction, presetForWorkspace } from "../assistant/agentPreset";
import type { DeviceRegistrySnapshot } from "../bridge/deviceRegistry";
import {
  emptyRegistry,
  upsertApiProfile,
  upsertLocalModel,
  type ApiProfileEntry,
  type BackendRegistry,
  type LocalModelEntry,
} from "../models/backendRegistry";

const profile = (over: Partial<ApiProfileEntry> = {}): ApiProfileEntry => ({
  ref: "openai-main",
  display_name: "OpenAI main",
  provider_kind: "openai-compatible",
  base_url: "https://api.example.com",
  credentials_ref: "secret://openai",
  default_model: "gpt-test",
  known_models: [],
  capabilities: ["text.generate"],
  health: "untested",
  ...over,
});

const localModel = (over: Partial<LocalModelEntry> = {}): LocalModelEntry => ({
  ref: "sam2-local",
  display_name: "SAM 2",
  capabilities: ["mask.subject"],
  engine: "onnx",
  weights_path: "",
  device_policy: "auto",
  precision_policy: "auto",
  health: "untested",
  fallback_policy: "built_in",
  health_detail: null,
  ...over,
});

const deviceSnapshot: DeviceRegistrySnapshot = {
  adapters: [
    { name: "Test GPU", backend: "vulkan", max_texture_dimension_2d: 16384, max_buffer_size: 2 ** 31 },
  ],
  grade_wgpu: { available: true, detail: "ok" },
  viewport_surface: { available: true, detail: "ok" },
  ffmpeg: { available: true, detail: "software" },
  ffmpeg_hw_encoders: [],
  ffmpeg_hw_decoders: [],
  onnx_providers: ["cpu"],
};

function ctx(
  registry: BackendRegistry,
  over: Partial<ModelApiActionContext> = {},
): ModelApiActionContext & { persisted: BackendRegistry[] } {
  const persisted: BackendRegistry[] = [];
  return {
    registry,
    probe: null,
    deviceRegistry: null,
    persist: (next) => persisted.push(next),
    persisted,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("model/api action registry", () => {
  it("every builtin id is whitelisted by the Model/API preset", () => {
    const preset = presetForWorkspace("model_api");
    for (const action of builtinModelApiActions().list()) {
      expect(presetAllowsAction(preset, action.id)).toBe(true);
    }
  });

  it("test_api_profile refuses unknown refs and reports reachability with persisted health", async () => {
    const registry = builtinModelApiActions();
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    expect(registry.dryRun("test_api_profile", context, { ref: "nope" }).ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await registry.commit("test_api_profile", context, { ref: "openai-main" });
    expect(result.ok).toBe(true);
    expect(result.command).toEqual({
      kind: "report",
      text: "API profile openai-main: reachable (health: valid)",
    });
    expect(context.persisted).toHaveLength(1);
    expect(context.persisted[0].apiProfiles[0].health).toBe("valid");
  });

  it("test_api_profile marks unreachable hosts", async () => {
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const result = await builtinModelApiActions().commit("test_api_profile", context, {
      ref: "openai-main",
    });
    expect(result.ok).toBe(true);
    expect(context.persisted[0].apiProfiles[0].health).toBe("unreachable");
  });

  it("probe_local_model records missing weights without a desktop backend call", async () => {
    const context = ctx(upsertLocalModel(emptyRegistry(), localModel()));
    const result = await builtinModelApiActions().commit("probe_local_model", context, {
      ref: "sam2-local",
    });
    expect(result.ok).toBe(true);
    expect(context.persisted[0].localModels[0].health).toBe("missing_weights");
    expect(result.command?.kind).toBe("report");
  });

  it("show_missing_capability_report lists uncovered capabilities and unhealthy entries", async () => {
    const registry = upsertLocalModel(
      upsertApiProfile(emptyRegistry(), profile({ health: "unreachable" })),
      localModel({ health: "missing_weights", health_detail: "C:/weights" }),
    );
    const result = await builtinModelApiActions().commit(
      "show_missing_capability_report",
      ctx(registry),
    );
    expect(result.ok).toBe(true);
    expect(result.command?.kind).toBe("report");
    if (result.command?.kind !== "report") return;
    expect(result.command.text).toContain("capabilities without a configured backend");
    expect(result.command.text).toContain("image.generate"); // uncovered
    expect(result.command.text).not.toMatch(/backend: text\.generate/); // covered by the profile
    expect(result.command.text).toContain("API profile openai-main: unreachable");
    expect(result.command.text).toContain("local model sam2-local: missing_weights — C:/weights");
    expect(result.command.text).toContain("engine probe has not run");
  });

  it("show_device_report refuses without a snapshot and summarises one when cached", async () => {
    const actions = builtinModelApiActions();
    expect(actions.dryRun("show_device_report", ctx(emptyRegistry())).ok).toBe(false);

    const result = await actions.commit(
      "show_device_report",
      ctx(emptyRegistry(), { deviceRegistry: deviceSnapshot }),
    );
    expect(result.ok).toBe(true);
    if (result.command?.kind !== "report") throw new Error("expected report");
    expect(result.command.text).toContain("Test GPU (vulkan)");
    expect(result.command.text).toContain("onnx providers: cpu (warn)");
  });

  it("open_model_api_manager requests the modal, optionally capability-filtered", async () => {
    const result = await builtinModelApiActions().commit("open_model_api_manager", ctx(emptyRegistry()), {
      capability: "mask.subject",
    });
    expect(result.command).toEqual({ kind: "open_manager", capability: "mask.subject" });
  });
});

describe("model/api agent chain", () => {
  it("parse -> preset guard -> review -> commit for a valid proposal", async () => {
    const actions = builtinModelApiActions();
    const context = ctx(upsertApiProfile(emptyRegistry(), profile()));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const parsed = parseAgentProposal(
      {
        intent: "check provider health then show what is missing",
        steps: [
          { actionId: "test_api_profile", params: { ref: "openai-main" } },
          { actionId: "show_missing_capability_report" },
        ],
      },
      actions,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("model_api")).ok).toBe(true);

    const review = reviewModelApiProposal(parsed.proposal, actions, context);
    expect(review.ok).toBe(true);
    expect(review.status).toBe("waiting_confirmation");

    const committed = await commitModelApiProposal(parsed.proposal, actions, context);
    expect(committed.ok).toBe(true);
    expect(committed.commands.map((c) => c.kind)).toEqual(["report", "report"]);
  });

  it("review and commit stop at the first refused step", async () => {
    const actions = builtinModelApiActions();
    const context = ctx(emptyRegistry());
    const proposal = {
      intent: "bad ref",
      steps: [
        { actionId: "test_api_profile", params: { ref: "nope" } },
        { actionId: "show_missing_capability_report" },
      ],
    };
    const review = reviewModelApiProposal(proposal, actions, context);
    expect(review.ok).toBe(false);
    expect(review.status).toBe("rejected");
    expect(review.steps).toHaveLength(1);

    const committed = await commitModelApiProposal(proposal, actions, context);
    expect(committed.ok).toBe(false);
    expect(committed.failedStep).toBe("test_api_profile");
    expect(committed.commands).toHaveLength(0);
  });

  it("canvas-only ids stay out of bounds for the Model/API preset", () => {
    const parsed = parseAgentProposal(
      { intent: "x", steps: [{ actionId: "open_model_api_manager" }] },
      builtinModelApiActions(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(guardProposal(parsed.proposal, presetForWorkspace("canvas")).ok).toBe(false);
  });
});
