// Model/API Studio Actions (PAGE_CONTEXT_AGENT_PRESET_PLAN, step 8): the five
// action ids the Model/API preset whitelists, backed by the *real* manager
// health checks and capability reports. The checks are the same ones the
// Model Manager's manual test buttons run (`backendHealth.ts`,
// `capabilitySummary.ts`) — never a second implementation, and never a raw
// key: the API test only touches the profile's base URL, reads go through
// the registry (which stores credential refs, not secrets).
//
//   dry run (ref/report availability) -> commit -> ModelApiCommand -> host

import type { ActionPlan } from "./studioAction";
import type { AgentProposal } from "./studioAgent";
import { probeLocalModelHealth, testApiProfileHealth } from "../models/backendHealth";
import {
  MODEL_CAPABILITIES,
  backendsFor,
  saveRegistry,
  upsertApiProfile,
  upsertLocalModel,
  type BackendRegistry,
  type ModelCapability,
} from "../models/backendRegistry";
import type { DeviceRegistrySnapshot } from "../bridge/deviceRegistry";
import type { EngineProbeReport } from "../bridge/engineProbe";
import { summarizeCapabilities, summarizeDeviceRegistry } from "../runtime/capabilitySummary";

/** What a Model/API action gets: the manager registry plus cached probes. */
export interface ModelApiActionContext {
  registry: BackendRegistry;
  /** Cached engine probe report; `null` when no probe has run yet. */
  probe: EngineProbeReport | null;
  /** Cached device registry snapshot; `null` when no probe has run yet. */
  deviceRegistry: DeviceRegistrySnapshot | null;
  /** Persist a registry with updated health (defaults to `saveRegistry`). */
  persist?: (next: BackendRegistry) => void;
}

/** What a committed Model/API action asks the host to do. */
export type ModelApiCommand =
  | { kind: "open_manager"; capability?: ModelCapability }
  | { kind: "report"; text: string };

export interface ModelApiCommitResult {
  ok: boolean;
  summary: string;
  command?: ModelApiCommand;
}

export interface ModelApiStudioAction<TParams = unknown> {
  id: string;
  label: string;
  dryRun(ctx: ModelApiActionContext, params: TParams): ActionPlan;
  /** Async: health checks reach the network / the desktop backend. */
  commit(ctx: ModelApiActionContext, params: TParams): Promise<ModelApiCommitResult>;
}

export interface ModelApiActionRegistry {
  register<TParams>(action: ModelApiStudioAction<TParams>): void;
  get(id: string): ModelApiStudioAction | undefined;
  list(): ModelApiStudioAction[];
  dryRun(id: string, ctx: ModelApiActionContext, params?: unknown): ActionPlan;
  /** Commit refuses to run when its own dry run reports a problem. */
  commit(id: string, ctx: ModelApiActionContext, params?: unknown): Promise<ModelApiCommitResult>;
}

const refuse = (action: string, summary: string): ActionPlan => ({
  ok: false,
  action,
  target: "model_manager",
  costClass: "free",
  summary,
});

export function createModelApiActionRegistry(): ModelApiActionRegistry {
  const actions = new Map<string, ModelApiStudioAction>();
  return {
    register(action) {
      if (actions.has(action.id)) throw new Error(`model/api action already registered: ${action.id}`);
      actions.set(action.id, action as ModelApiStudioAction);
    },
    get: (id) => actions.get(id),
    list: () => [...actions.values()],
    dryRun(id, ctx, params) {
      const action = actions.get(id);
      if (!action) return refuse(id, `unknown action: ${id}`);
      return action.dryRun(ctx, params);
    },
    async commit(id, ctx, params) {
      const action = actions.get(id);
      if (!action) return { ok: false, summary: `unknown action: ${id}` };
      const plan = action.dryRun(ctx, params);
      if (!plan.ok) return { ok: false, summary: plan.summary };
      return action.commit(ctx, params);
    },
  };
}

// --- manager actions ------------------------------------------------------------

export interface OpenManagerParams {
  capability?: ModelCapability;
}

/** `open_model_api_manager`: ask the host to open the Models / APIs modal. */
export const openModelApiManagerAction: ModelApiStudioAction<OpenManagerParams | undefined> = {
  id: "open_model_api_manager",
  label: "Open Models / APIs manager",
  dryRun(_ctx, params) {
    return {
      ok: true,
      action: this.id,
      target: "model_manager",
      costClass: "free",
      summary: `open the Models / APIs manager${params?.capability ? ` filtered to ${params.capability}` : ""}`,
    };
  },
  commit(_ctx, params) {
    return Promise.resolve({
      ok: true,
      summary: "manager open requested",
      command: { kind: "open_manager", capability: params?.capability },
    });
  },
};

export interface ProfileRefParams {
  ref: string;
}

/** `test_api_profile`: the manager's manual reachability check, health persisted. */
export const testApiProfileAction: ModelApiStudioAction<ProfileRefParams> = {
  id: "test_api_profile",
  label: "Test API profile",
  dryRun(ctx, params) {
    if (!params?.ref) return refuse(this.id, "needs a profile ref");
    const profile = ctx.registry.apiProfiles.find((p) => p.ref === params.ref);
    if (!profile) return refuse(this.id, `no API profile "${params.ref}"`);
    return {
      ok: true,
      action: this.id,
      target: `api_profile(${params.ref})`,
      costClass: "free",
      summary: `test reachability of "${profile.display_name || profile.ref}" (base URL only, no credentials)`,
    };
  },
  async commit(ctx, params) {
    const profile = ctx.registry.apiProfiles.find((p) => p.ref === params.ref);
    if (!profile) return { ok: false, summary: `no API profile "${params.ref}"` };
    const { outcome, health } = await testApiProfileHealth(profile);
    const next = upsertApiProfile(ctx.registry, { ...profile, health });
    (ctx.persist ?? saveRegistry)(next);
    return {
      ok: true,
      summary: `${profile.ref}: ${outcome} -> health ${health}`,
      command: { kind: "report", text: `API profile ${profile.ref}: ${outcome} (health: ${health})` },
    };
  },
};

/** `probe_local_model`: the manager's manual weights-presence check. */
export const probeLocalModelAction: ModelApiStudioAction<ProfileRefParams> = {
  id: "probe_local_model",
  label: "Probe local model",
  dryRun(ctx, params) {
    if (!params?.ref) return refuse(this.id, "needs a model ref");
    const model = ctx.registry.localModels.find((m) => m.ref === params.ref);
    if (!model) return refuse(this.id, `no local model "${params.ref}"`);
    return {
      ok: true,
      action: this.id,
      target: `local_model(${params.ref})`,
      costClass: "free",
      summary: `probe weights of "${model.display_name || model.ref}"`,
    };
  },
  async commit(ctx, params) {
    const model = ctx.registry.localModels.find((m) => m.ref === params.ref);
    if (!model) return { ok: false, summary: `no local model "${params.ref}"` };
    const { outcome, health, detail } = await probeLocalModelHealth(model);
    if (health !== null) {
      const next = upsertLocalModel(ctx.registry, { ...model, health, health_detail: detail });
      (ctx.persist ?? saveRegistry)(next);
    }
    return {
      ok: true,
      summary: `${model.ref}: ${outcome}${health ? ` -> health ${health}` : ""}`,
      command: {
        kind: "report",
        text: `local model ${model.ref}: ${outcome}${health ? ` (health: ${health})` : ""}${detail ? ` — ${detail}` : ""}`,
      },
    };
  },
};

// --- report actions --------------------------------------------------------------

/**
 * `show_missing_capability_report`: capabilities with no configured backend,
 * unhealthy registry entries, and the probe's warn lines — the "what can this
 * box not do right now" answer.
 */
export const showMissingCapabilityReportAction: ModelApiStudioAction<void> = {
  id: "show_missing_capability_report",
  label: "Missing capability report",
  dryRun() {
    return {
      ok: true,
      action: this.id,
      target: "capability_map",
      costClass: "free",
      summary: "report capabilities without backends, unhealthy entries, and probe warnings",
    };
  },
  commit(ctx) {
    const lines: string[] = [];
    const uncovered = MODEL_CAPABILITIES.filter((cap) => backendsFor(ctx.registry, cap).length === 0);
    lines.push(
      uncovered.length === 0
        ? "every capability has at least one configured backend"
        : `capabilities without a configured backend: ${uncovered.join(", ")}`,
    );
    for (const p of ctx.registry.apiProfiles) {
      if (p.health !== "valid" && p.health !== "untested") {
        lines.push(`API profile ${p.ref}: ${p.health}`);
      }
    }
    for (const m of ctx.registry.localModels) {
      if (m.health !== "installed" && m.health !== "untested") {
        lines.push(`local model ${m.ref}: ${m.health}${m.health_detail ? ` — ${m.health_detail}` : ""}`);
      }
    }
    if (ctx.probe) {
      for (const line of summarizeCapabilities(ctx.probe)) {
        if (line.tone === "warn") lines.push(`probe: ${line.label} — ${line.value}`);
      }
    } else {
      lines.push("engine probe has not run — refresh in the Models / APIs manager");
    }
    return Promise.resolve({
      ok: true,
      summary: `${lines.length} report line(s)`,
      command: { kind: "report", text: lines.join("\n") },
    });
  },
};

/** `show_device_report`: the cached device-registry snapshot as plain lines. */
export const showDeviceReportAction: ModelApiStudioAction<void> = {
  id: "show_device_report",
  label: "Device report",
  dryRun(ctx) {
    if (!ctx.deviceRegistry) {
      return refuse(this.id, "no device snapshot — refresh in the Models / APIs manager first");
    }
    return {
      ok: true,
      action: this.id,
      target: "device_registry",
      costClass: "free",
      summary: "report the cached device registry snapshot",
    };
  },
  commit(ctx) {
    const text = summarizeDeviceRegistry(ctx.deviceRegistry!)
      .map((line) => `${line.label}: ${line.value}${line.tone === "warn" ? " (warn)" : ""}`)
      .join("\n");
    return Promise.resolve({
      ok: true,
      summary: "device report generated",
      command: { kind: "report", text },
    });
  },
};

// --- agent boundary (same gates as the mask-document / canvas chains) -------------

/** The dry-run report the preview gate shows before the user confirms. */
export interface ModelApiProposalReview {
  intent: string;
  steps: { actionId: string; plan: ActionPlan }[];
  ok: boolean;
  status: "waiting_confirmation" | "rejected";
}

/** Dry-run a parsed proposal (see `parseAgentProposal`) without any checks running. */
export function reviewModelApiProposal(
  proposal: AgentProposal,
  registry: ModelApiActionRegistry,
  ctx: ModelApiActionContext,
): ModelApiProposalReview {
  const steps: ModelApiProposalReview["steps"] = [];
  let ok = true;
  for (const step of proposal.steps) {
    const plan = registry.dryRun(step.actionId, ctx, step.params);
    steps.push({ actionId: step.actionId, plan });
    if (!plan.ok) {
      ok = false;
      break;
    }
  }
  return { intent: proposal.intent, steps, ok, status: ok ? "waiting_confirmation" : "rejected" };
}

export interface ModelApiProposalCommitResult {
  ok: boolean;
  commands: ModelApiCommand[];
  summaries: string[];
  failedStep?: string;
}

/** Commit a user-confirmed proposal; stops at the first refused step. */
export async function commitModelApiProposal(
  proposal: AgentProposal,
  registry: ModelApiActionRegistry,
  ctx: ModelApiActionContext,
): Promise<ModelApiProposalCommitResult> {
  const commands: ModelApiCommand[] = [];
  const summaries: string[] = [];
  for (const step of proposal.steps) {
    const result = await registry.commit(step.actionId, ctx, step.params);
    if (!result.ok) return { ok: false, commands, summaries, failedStep: step.actionId };
    summaries.push(result.summary);
    if (result.command) commands.push(result.command);
  }
  return { ok: true, commands, summaries };
}

/** The registry preloaded with every Model/API-preset action id. */
export function builtinModelApiActions(): ModelApiActionRegistry {
  const registry = createModelApiActionRegistry();
  registry.register(openModelApiManagerAction);
  registry.register(testApiProfileAction);
  registry.register(probeLocalModelAction);
  registry.register(showMissingCapabilityReportAction);
  registry.register(showDeviceReportAction);
  return registry;
}
