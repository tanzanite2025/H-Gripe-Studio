// Agent boundary for Studio Actions (docs/plans/active/
// MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md, step 8). An assistant / API /
// local model may only *propose* sequences of approved Studio Actions; the
// runtime resolves targets, dry-runs every step, and holds the whole proposal
// at a preview gate until the user confirms. The agent never clicks the UI,
// never guesses the active layer, and never writes raw `edit_paths` JSON —
// anything that is not a registered action id is rejected at parse time.
//
//   agent proposal (JSON)
//     -> parseAgentProposal   (only approved action ids survive)
//     -> reviewProposal       (target resolver + per-step dry run, no mutation)
//     -> commitProposal       (user-confirmed; each step one undo record)

import type { EditState } from "./maskEdit";
import type { ActionPlan, StudioActionRegistry } from "./studioAction";
import type { StudioDocumentRef } from "./studioTarget";
import { resolveActiveTarget } from "./studioTarget";

/** One proposed call: an approved action id plus its params — nothing else. */
export interface AgentProposalStep {
  actionId: string;
  params?: unknown;
}

export interface AgentProposal {
  /** What the agent said it wants, echoed for the review UI/log. */
  intent: string;
  steps: AgentProposalStep[];
}

export type ParseResult =
  | { ok: true; proposal: AgentProposal }
  | { ok: false; error: string };

/** Any action registry the agent boundary can validate ids against. */
export interface ActionIdLookup {
  get(id: string): unknown;
}

/**
 * Validate a raw agent payload into a proposal. Fails closed: malformed
 * shapes, empty step lists, and action ids the registry does not know are
 * all rejected — an agent cannot smuggle a UI operation or raw document
 * mutation through this surface. Works against any action registry (mask
 * document or canvas): the id lookup is the shared surface.
 */
export function parseAgentProposal(raw: unknown, registry: ActionIdLookup): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "proposal must be an object" };
  const o = raw as { intent?: unknown; steps?: unknown };
  const intent = typeof o.intent === "string" ? o.intent : "";
  if (!Array.isArray(o.steps) || o.steps.length === 0) {
    return { ok: false, error: "proposal needs at least one step" };
  }
  const steps: AgentProposalStep[] = [];
  for (const [i, rawStep] of o.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object") return { ok: false, error: `step ${i + 1} must be an object` };
    const s = rawStep as { actionId?: unknown; params?: unknown };
    if (typeof s.actionId !== "string" || !s.actionId) {
      return { ok: false, error: `step ${i + 1} has no actionId` };
    }
    if (!registry.get(s.actionId)) {
      return { ok: false, error: `step ${i + 1}: "${s.actionId}" is not an approved studio action` };
    }
    steps.push({ actionId: s.actionId, params: s.params });
  }
  return { ok: true, proposal: { intent, steps } };
}

export interface ProposalStepReview {
  actionId: string;
  plan: ActionPlan;
}

/** The dry-run report the preview gate shows before the user confirms. */
export interface ProposalReview {
  intent: string;
  steps: ProposalStepReview[];
  /** Every step's dry run passed against the sequentially previewed state. */
  ok: boolean;
  status: "waiting_confirmation" | "rejected";
}

/**
 * Dry-run the whole proposal without mutating the caller's state. Steps are
 * planned against the state each *previous* step would leave behind (a
 * `create_layer_mask` step makes the following `feather_layer_mask` step
 * resolvable), so the report matches what a confirmed commit will do. The
 * caller's `EditState` is never touched.
 */
export function reviewProposal(
  proposal: AgentProposal,
  registry: StudioActionRegistry,
  state: EditState,
  ref: StudioDocumentRef,
): ProposalReview {
  const steps: ProposalStepReview[] = [];
  let ok = true;
  let cursor = state;
  for (const step of proposal.steps) {
    const target = resolveActiveTarget(cursor.current, ref);
    const ctx = { state: cursor, target };
    const plan = registry.dryRun(step.actionId, ctx, step.params);
    steps.push({ actionId: step.actionId, plan });
    if (!plan.ok) {
      ok = false;
      break;
    }
    const committed = registry.commit(step.actionId, ctx, step.params);
    if (!committed.ok) {
      ok = false;
      break;
    }
    cursor = committed.state;
  }
  return { intent: proposal.intent, steps, ok, status: ok ? "waiting_confirmation" : "rejected" };
}

export interface ProposalCommitResult {
  ok: boolean;
  state: EditState;
  /** Per-step commit summaries, in execution order. */
  summaries: string[];
  /** The step that refused, when the run stopped early. */
  failedStep?: string;
}

/**
 * Execute a user-confirmed proposal. Each step resolves its target against
 * the live document, commits as an ordinary undo record, and the run stops
 * at the first refusal — earlier steps stay committed (and undoable), the
 * document is never left mid-step.
 */
export function commitProposal(
  proposal: AgentProposal,
  registry: StudioActionRegistry,
  state: EditState,
  ref: StudioDocumentRef,
): ProposalCommitResult {
  const summaries: string[] = [];
  let cursor = state;
  for (const step of proposal.steps) {
    const target = resolveActiveTarget(cursor.current, ref);
    const result = registry.commit(step.actionId, { state: cursor, target }, step.params);
    if (!result.ok) {
      return { ok: false, state: cursor, summaries, failedStep: step.actionId };
    }
    summaries.push(result.summary);
    cursor = result.state;
  }
  return { ok: true, state: cursor, summaries };
}
