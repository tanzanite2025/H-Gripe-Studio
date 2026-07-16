// API-profile Studio Actions backed by the manager's real health checks and
// capability report. They share `backendHealth.ts` with the modal and never read a raw
// key: the API test only touches the profile's base URL, reads go through
// the registry (which stores credential refs, not secrets).
//
//   dry run (ref/report availability) -> commit -> ModelApiCommand -> host

import type { ActionPlan } from "./studioAction";
import type { AgentProposal } from "./studioAgent";
import { testApiProfileHealth } from "../models/backendHealth";
import {
  MODEL_CAPABILITIES,
  backendsFor,
  saveRegistry,
  upsertApiProfile,
  type BackendRegistry,
  type ModelCapability,
} from "../models/backendRegistry";

/** What an API-profile action gets. */
export interface ModelApiActionContext {
  registry: BackendRegistry;
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

/** `open_model_api_manager`: ask the host to open the API Profiles modal. */
export const openModelApiManagerAction: ModelApiStudioAction<OpenManagerParams | undefined> = {
  id: "open_model_api_manager",
  label: "Open API Profiles manager",
  dryRun(_ctx, params) {
    return {
      ok: true,
      action: this.id,
      target: "model_manager",
      costClass: "free",
      summary: `open the API Profiles manager${params?.capability ? ` filtered to ${params.capability}` : ""}`,
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

// --- report actions --------------------------------------------------------------

/**
 * `show_missing_capability_report`: capabilities with no configured backend,
 * and unhealthy API profile entries.
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
      summary: "report capabilities without API profiles and unhealthy entries",
    };
  },
  commit(ctx) {
    const lines: string[] = [];
    const uncovered = MODEL_CAPABILITIES.filter((cap) => backendsFor(ctx.registry, cap).length === 0);
    lines.push(
      uncovered.length === 0
        ? "every API capability has at least one configured profile"
        : `capabilities without a configured API profile: ${uncovered.join(", ")}`,
    );
    for (const p of ctx.registry.apiProfiles) {
      if (p.health !== "valid" && p.health !== "untested") {
        lines.push(`API profile ${p.ref}: ${p.health}`);
      }
    }
    return Promise.resolve({
      ok: true,
      summary: `${lines.length} report line(s)`,
      command: { kind: "report", text: lines.join("\n") },
    });
  },
};

// --- agent boundary (same gates as the image editor document / canvas chains) -----

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
  registry.register(showMissingCapabilityReportAction);
  return registry;
}
