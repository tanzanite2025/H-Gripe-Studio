// Canvas Studio Actions (PAGE_CONTEXT_AGENT_PRESET_PLAN, step 7): the six
// action ids the Canvas preset whitelists, backed by the *real* run-scope
// model. The action layer never executes a graph itself — a commit resolves
// the scope through `resolveRunScope` (the same dependency policy every UI
// entry point uses) and returns a `CanvasCommand` the host run controller
// executes, so an agent-triggered run is indistinguishable from a toolbar
// run. Read-style actions (`explain`, `validate`) commit to reports.
//
//   dry run (scope resolution + warnings) -> commit -> CanvasCommand -> host

import type { ActionPlan } from "./studioAction";
import type { AgentProposal } from "./studioAgent";
import type { BackendRegistry } from "../models/backendRegistry";
import { validateBackendRefs } from "../models/backendBindings";
import type { WorkflowGraph } from "../graph/model";
import { nodeSpec } from "../graph/nodeSpecs";
import {
  describeRunScope,
  resolveRunScope,
  type RunScope,
} from "../runtime/runScope";

/** What a canvas action gets: the live graph plus the page selection. */
export interface CanvasActionContext {
  canvasId: string;
  graph: WorkflowGraph;
  selectedNodeIds: string[];
  /** Manager registry, for backend-ref validation. */
  registry: BackendRegistry;
}

/**
 * What a committed canvas action asks the host to do. Runs and previews are
 * *requests* — the run controller (or preview modal host) executes them, the
 * action layer never mutates runtime state.
 */
export type CanvasCommand =
  | { kind: "run"; scope: RunScope }
  | { kind: "open_preview"; canvasId: string; nodeId: string; portId?: string }
  | { kind: "report"; text: string };

export interface CanvasCommitResult {
  ok: boolean;
  summary: string;
  command?: CanvasCommand;
}

export interface CanvasStudioAction<TParams = unknown> {
  id: string;
  label: string;
  dryRun(ctx: CanvasActionContext, params: TParams): ActionPlan;
  commit(ctx: CanvasActionContext, params: TParams): CanvasCommitResult;
}

export interface CanvasActionRegistry {
  register<TParams>(action: CanvasStudioAction<TParams>): void;
  get(id: string): CanvasStudioAction | undefined;
  list(): CanvasStudioAction[];
  dryRun(id: string, ctx: CanvasActionContext, params?: unknown): ActionPlan;
  /** Commit refuses to run when its own dry run reports a problem. */
  commit(id: string, ctx: CanvasActionContext, params?: unknown): CanvasCommitResult;
}

const refuse = (action: string, ctx: CanvasActionContext, summary: string): ActionPlan => ({
  ok: false,
  action,
  target: `canvas(${ctx.canvasId})`,
  costClass: "free",
  summary,
});

export function createCanvasActionRegistry(): CanvasActionRegistry {
  const actions = new Map<string, CanvasStudioAction>();
  return {
    register(action) {
      if (actions.has(action.id)) throw new Error(`canvas action already registered: ${action.id}`);
      actions.set(action.id, action as CanvasStudioAction);
    },
    get: (id) => actions.get(id),
    list: () => [...actions.values()],
    dryRun(id, ctx, params) {
      const action = actions.get(id);
      if (!action) return refuse(id, ctx, `unknown action: ${id}`);
      return action.dryRun(ctx, params);
    },
    commit(id, ctx, params) {
      const action = actions.get(id);
      if (!action) return { ok: false, summary: `unknown action: ${id}` };
      const plan = action.dryRun(ctx, params);
      if (!plan.ok) return { ok: false, summary: plan.summary };
      return action.commit(ctx, params);
    },
  };
}

// --- scope-backed run actions --------------------------------------------------

const hasNode = (graph: WorkflowGraph, nodeId: string): boolean =>
  graph.nodes.some((n) => n.id === nodeId);

/** Spec title of a node kind; the raw kind when the spec table lacks it. */
function nodeTitle(kind: string): string {
  try {
    return nodeSpec(kind).title || kind;
  } catch {
    return kind;
  }
}

/** A run action's dry run: resolve the real scope and report size + warnings. */
function planScopedRun(action: string, ctx: CanvasActionContext, scope: RunScope): ActionPlan {
  const resolved = resolveRunScope(ctx.graph, scope);
  const warnings = resolved.warnings.length
    ? `; warnings: ${resolved.warnings.join("; ")}`
    : "";
  return {
    ok: true,
    action,
    target: describeRunScope(scope),
    costClass: "local_compute",
    summary: `run ${describeRunScope(scope)} — ${resolved.graph.nodes.length} node(s)${warnings}`,
  };
}

const runCommand = (scope: RunScope): CanvasCommitResult => ({
  ok: true,
  summary: `run requested: ${describeRunScope(scope)}`,
  command: { kind: "run", scope },
});

/** `run_selected_with_upstream`: the page selection plus its input chains. */
export const runSelectedWithUpstreamAction: CanvasStudioAction<void> = {
  id: "run_selected_with_upstream",
  label: "Run selection (with upstream)",
  dryRun(ctx) {
    if (ctx.selectedNodeIds.length === 0) return refuse(this.id, ctx, "no nodes selected");
    const scope: RunScope = {
      kind: "selection_with_upstream",
      canvasId: ctx.canvasId,
      nodeIds: ctx.selectedNodeIds,
    };
    return planScopedRun(this.id, ctx, scope);
  },
  commit(ctx) {
    return runCommand({
      kind: "selection_with_upstream",
      canvasId: ctx.canvasId,
      nodeIds: ctx.selectedNodeIds,
    });
  },
};

export interface NodeScopeParams {
  nodeId: string;
}

/** `run_to_node`: the node's upstream chain, nothing downstream. */
export const runToNodeAction: CanvasStudioAction<NodeScopeParams> = {
  id: "run_to_node",
  label: "Run to node",
  dryRun(ctx, params) {
    if (!params?.nodeId) return refuse(this.id, ctx, "needs a nodeId");
    if (!hasNode(ctx.graph, params.nodeId)) return refuse(this.id, ctx, `no node ${params.nodeId}`);
    return planScopedRun(this.id, ctx, {
      kind: "node_upstream",
      canvasId: ctx.canvasId,
      nodeId: params.nodeId,
    });
  },
  commit(ctx, params) {
    return runCommand({ kind: "node_upstream", canvasId: ctx.canvasId, nodeId: params.nodeId });
  },
};

/** `run_downstream`: the node's consumers plus whatever they need upstream. */
export const runDownstreamAction: CanvasStudioAction<NodeScopeParams> = {
  id: "run_downstream",
  label: "Run downstream",
  dryRun(ctx, params) {
    if (!params?.nodeId) return refuse(this.id, ctx, "needs a nodeId");
    if (!hasNode(ctx.graph, params.nodeId)) return refuse(this.id, ctx, `no node ${params.nodeId}`);
    return planScopedRun(this.id, ctx, {
      kind: "node_downstream",
      canvasId: ctx.canvasId,
      nodeId: params.nodeId,
    });
  },
  commit(ctx, params) {
    return runCommand({ kind: "node_downstream", canvasId: ctx.canvasId, nodeId: params.nodeId });
  },
};

// --- read-style actions ---------------------------------------------------------

/** `explain_selected_nodes`: node kinds, titles, and wiring of the selection. */
export const explainSelectedNodesAction: CanvasStudioAction<void> = {
  id: "explain_selected_nodes",
  label: "Explain selected nodes",
  dryRun(ctx) {
    if (ctx.selectedNodeIds.length === 0) return refuse(this.id, ctx, "no nodes selected");
    return {
      ok: true,
      action: this.id,
      target: `selection (${ctx.selectedNodeIds.length} node(s))`,
      costClass: "free",
      summary: `describe ${ctx.selectedNodeIds.length} selected node(s)`,
    };
  },
  commit(ctx) {
    const selected = new Set(ctx.selectedNodeIds);
    const lines = ctx.graph.nodes
      .filter((n) => selected.has(n.id))
      .map((n) => {
        const inputs = ctx.graph.edges.filter((e) => e.target === n.id).length;
        const outputs = ctx.graph.edges.filter((e) => e.source === n.id).length;
        return `${n.id}: ${nodeTitle(n.kind)} (${n.kind}) — ${inputs} input edge(s), ${outputs} output edge(s)`;
      });
    return {
      ok: true,
      summary: `described ${lines.length} node(s)`,
      command: { kind: "report", text: lines.join("\n") },
    };
  },
};

/** `validate_backend_refs`: the same pre-run manager-registry check runs use. */
export const validateBackendRefsAction: CanvasStudioAction<void> = {
  id: "validate_backend_refs",
  label: "Validate backend refs",
  dryRun(ctx) {
    return {
      ok: true,
      action: this.id,
      target: `canvas(${ctx.canvasId})`,
      costClass: "free",
      summary: `validate backend refs of ${ctx.graph.nodes.length} node(s)`,
    };
  },
  commit(ctx) {
    const issues = validateBackendRefs(ctx.graph, ctx.registry);
    const text =
      issues.length === 0
        ? "all backend refs valid"
        : issues.map((i) => `${i.node} (${i.nodeId}): ${i.message}`).join("\n");
    return {
      ok: true,
      summary: `${issues.length} backend ref issue(s)`,
      command: { kind: "report", text },
    };
  },
};

export interface NodePreviewParams {
  nodeId: string;
  portId?: string;
}

/** `open_node_result_preview`: ask the host to open the shared preview modal. */
export const openNodeResultPreviewAction: CanvasStudioAction<NodePreviewParams> = {
  id: "open_node_result_preview",
  label: "Open node result preview",
  dryRun(ctx, params) {
    if (!params?.nodeId) return refuse(this.id, ctx, "needs a nodeId");
    if (!hasNode(ctx.graph, params.nodeId)) return refuse(this.id, ctx, `no node ${params.nodeId}`);
    return {
      ok: true,
      action: this.id,
      target: `node_output(${params.nodeId}${params.portId ? `:${params.portId}` : ""})`,
      costClass: "free",
      summary: `open the result preview of ${params.nodeId}`,
    };
  },
  commit(ctx, params) {
    return {
      ok: true,
      summary: `preview requested for ${params.nodeId}`,
      command: {
        kind: "open_preview",
        canvasId: ctx.canvasId,
        nodeId: params.nodeId,
        portId: params.portId,
      },
    };
  },
};

// --- agent boundary (same gates as the mask-document chain) ---------------------

/** The dry-run report the preview gate shows before the user confirms. */
export interface CanvasProposalReview {
  intent: string;
  steps: { actionId: string; plan: ActionPlan }[];
  ok: boolean;
  status: "waiting_confirmation" | "rejected";
}

/**
 * Dry-run a parsed proposal (see `parseAgentProposal`) against the live
 * canvas without executing anything: scope resolution and warnings only.
 */
export function reviewCanvasProposal(
  proposal: AgentProposal,
  registry: CanvasActionRegistry,
  ctx: CanvasActionContext,
): CanvasProposalReview {
  const steps: CanvasProposalReview["steps"] = [];
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

export interface CanvasProposalCommitResult {
  ok: boolean;
  /** Host commands of the committed steps, in execution order. */
  commands: CanvasCommand[];
  summaries: string[];
  failedStep?: string;
}

/**
 * Commit a user-confirmed proposal: each step re-checks its own dry run and
 * the run stops at the first refusal. The returned commands are what the
 * host run controller / preview modal actually executes.
 */
export function commitCanvasProposal(
  proposal: AgentProposal,
  registry: CanvasActionRegistry,
  ctx: CanvasActionContext,
): CanvasProposalCommitResult {
  const commands: CanvasCommand[] = [];
  const summaries: string[] = [];
  for (const step of proposal.steps) {
    const result = registry.commit(step.actionId, ctx, step.params);
    if (!result.ok) return { ok: false, commands, summaries, failedStep: step.actionId };
    summaries.push(result.summary);
    if (result.command) commands.push(result.command);
  }
  return { ok: true, commands, summaries };
}

/** The registry preloaded with every Canvas-preset action id. */
export function builtinCanvasActions(): CanvasActionRegistry {
  const registry = createCanvasActionRegistry();
  registry.register(explainSelectedNodesAction);
  registry.register(validateBackendRefsAction);
  registry.register(runSelectedWithUpstreamAction);
  registry.register(runToNodeAction);
  registry.register(runDownstreamAction);
  registry.register(openNodeResultPreviewAction);
  return registry;
}
