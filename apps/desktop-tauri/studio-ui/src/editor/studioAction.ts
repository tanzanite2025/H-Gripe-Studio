// Studio Action runtime (docs/plans/active/
// MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md, steps 6–7). Actions are the
// only surface an assistant/API/local model may call — never UI clicks and
// never raw `edit_paths` JSON. Every action resolves a first-class
// `StudioTarget` before it runs and passes the transaction stages:
//
//   dry_run -> preview -> commit -> undoable edit history
//
// Commit is built on the editor's pure `EditState` commands, so every action
// lands as an ordinary undo step of the same document history that manual
// tools write.

import type { ComputeCapabilityId, ComputeCostClass } from "./computeBlocks";
import type { EditState } from "./maskEdit";
import { addLayerMask, addOperation, setActiveLayer, setActiveTarget } from "./maskEdit";
import type { SelectionTarget, StudioTarget } from "./studioTarget";
import { describeTarget } from "./studioTarget";
import type { MaskDocument, PointPrompt } from "../types/production";

/** What an action gets to work with: the document history plus its resolved target. */
export interface ActionContext {
  state: EditState;
  target: StudioTarget;
}

/** The dry-run report: what the action will touch, call, create, and cost. */
export interface ActionPlan {
  ok: boolean;
  action: string;
  /** `describeTarget` of the resolved target the commit will touch. */
  target: string;
  costClass: ComputeCostClass;
  /** Compute capability the action will call, when it calls one. */
  capability?: ComputeCapabilityId;
  /** What artifact/attachment the commit creates, when it creates one. */
  creates?: string;
  summary: string;
}

/** A cheap deterministic preview: the document as it would look after commit. */
export interface PreviewArtifact {
  kind: "document";
  doc: MaskDocument;
}

export interface CommitResult {
  ok: boolean;
  state: EditState;
  summary: string;
}

export interface StudioAction<TParams = unknown> {
  id: string;
  label: string;
  capabilities: ComputeCapabilityId[];
  requiredTarget: StudioTarget["kind"][];
  dryRun(ctx: ActionContext, params: TParams): ActionPlan;
  preview(ctx: ActionContext, params: TParams): PreviewArtifact;
  commit(ctx: ActionContext, params: TParams): CommitResult;
}

export interface StudioActionRegistry {
  register<TParams>(action: StudioAction<TParams>): void;
  get(id: string): StudioAction | undefined;
  list(): StudioAction[];
  /** Stage runner: target-kind check, then the action's own dry run. */
  dryRun(id: string, ctx: ActionContext, params?: unknown): ActionPlan;
  preview(id: string, ctx: ActionContext, params?: unknown): PreviewArtifact;
  /** Commit refuses to run when its own dry run reports a problem. */
  commit(id: string, ctx: ActionContext, params?: unknown): CommitResult;
}

const refuse = (action: string, ctx: ActionContext, summary: string): ActionPlan => ({
  ok: false,
  action,
  target: describeTarget(ctx.target),
  costClass: "free",
  summary,
});

export function createStudioActionRegistry(): StudioActionRegistry {
  const actions = new Map<string, StudioAction>();

  const resolve = (id: string, ctx: ActionContext): { action?: StudioAction; error?: ActionPlan } => {
    const action = actions.get(id);
    if (!action) return { error: refuse(id, ctx, `unknown action: ${id}`) };
    if (!action.requiredTarget.includes(ctx.target.kind)) {
      return {
        error: refuse(
          id,
          ctx,
          `target kind ${ctx.target.kind} not accepted (requires ${action.requiredTarget.join(" | ")})`,
        ),
      };
    }
    return { action };
  };

  return {
    register(action) {
      if (actions.has(action.id)) throw new Error(`studio action already registered: ${action.id}`);
      actions.set(action.id, action as StudioAction);
    },
    get: (id) => actions.get(id),
    list: () => [...actions.values()],
    dryRun(id, ctx, params) {
      const { action, error } = resolve(id, ctx);
      return error ?? action!.dryRun(ctx, params);
    },
    preview(id, ctx, params) {
      const { action, error } = resolve(id, ctx);
      if (error) return { kind: "document", doc: ctx.state.current };
      return action!.preview(ctx, params);
    },
    commit(id, ctx, params) {
      const { action, error } = resolve(id, ctx);
      const plan = error ?? action!.dryRun(ctx, params);
      if (!plan.ok) return { ok: false, state: ctx.state, summary: plan.summary };
      return action!.commit(ctx, params);
    },
  };
}

// --- first non-agent actions (plan step 7) -----------------------------------

const layerIndexOf = (doc: MaskDocument, layerId: string): number =>
  doc.layers.findIndex((l) => l.id === layerId);

/** The mask attachment of a `layer_mask` target activated as the edit target. */
function withMaskTargetActive(state: EditState, target: StudioTarget & { kind: "layer_mask" }): EditState | null {
  const index = layerIndexOf(state.current, target.layerId);
  const layer = state.current.layers[index];
  if (!layer?.mask || layer.mask.id !== target.maskId) return null;
  return setActiveTarget(setActiveLayer(state, index), "mask");
}

/** `create_layer_mask(pixel_layer)`: attach an empty mask, never a new layer. */
export const createLayerMaskAction: StudioAction<void> = {
  id: "create_layer_mask",
  label: "Add layer mask",
  capabilities: [],
  requiredTarget: ["pixel_layer"],
  dryRun(ctx) {
    if (ctx.target.kind !== "pixel_layer") return refuse(this.id, ctx, "not a pixel layer");
    const index = layerIndexOf(ctx.state.current, ctx.target.layerId);
    const layer = ctx.state.current.layers[index];
    if (!layer) return refuse(this.id, ctx, `no layer ${ctx.target.layerId}`);
    if (layer.mask) return refuse(this.id, ctx, "layer already owns a mask");
    if (layer.locked || layer.kind === "adjustment") return refuse(this.id, ctx, "layer cannot own a mask");
    return {
      ok: true,
      action: this.id,
      target: describeTarget(ctx.target),
      costClass: "free",
      creates: "layer_mask",
      summary: `attach an empty layer mask to ${describeTarget(ctx.target)}`,
    };
  },
  preview(ctx) {
    return { kind: "document", doc: this.commit(ctx, undefined).state.current };
  },
  commit(ctx) {
    if (ctx.target.kind !== "pixel_layer") return { ok: false, state: ctx.state, summary: "not a pixel layer" };
    const index = layerIndexOf(ctx.state.current, ctx.target.layerId);
    const next = addLayerMask(ctx.state, index);
    if (next === ctx.state) return { ok: false, state: ctx.state, summary: "layer cannot take a mask" };
    return { ok: true, state: next, summary: `layer mask attached to ${describeTarget(ctx.target)}` };
  },
};

export interface SelectionToMaskParams {
  selection: SelectionTarget;
}

/** `commit_selection_to_layer_mask`: record the selection region onto the mask stack. */
export const selectionToLayerMaskAction: StudioAction<SelectionToMaskParams> = {
  id: "commit_selection_to_layer_mask",
  label: "Selection to layer mask",
  capabilities: [],
  requiredTarget: ["layer_mask"],
  dryRun(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return refuse(this.id, ctx, "not a layer mask");
    if (!params?.selection) return refuse(this.id, ctx, "no selection to commit");
    if (!withMaskTargetActive(ctx.state, ctx.target)) return refuse(this.id, ctx, "mask target not found");
    return {
      ok: true,
      action: this.id,
      target: describeTarget(ctx.target),
      costClass: "free",
      creates: "mask edit op",
      summary: `record selection ${params.selection.id} (${params.selection.source}) onto ${describeTarget(ctx.target)}`,
    };
  },
  preview(ctx, params) {
    return { kind: "document", doc: this.commit(ctx, params).state.current };
  },
  commit(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return { ok: false, state: ctx.state, summary: "not a layer mask" };
    const targeted = withMaskTargetActive(ctx.state, ctx.target);
    if (!targeted) return { ok: false, state: ctx.state, summary: "mask target not found" };
    const next = addOperation(targeted, { type: "rect", region: [...params.selection.bounds] });
    if (next === targeted) return { ok: false, state: ctx.state, summary: "mask stack rejected the op" };
    return { ok: true, state: next, summary: `selection ${params.selection.id} committed to ${describeTarget(ctx.target)}` };
  },
};

export interface Sam2PromptMaskParams {
  points: PointPrompt[];
  variant?: "tiny" | "small" | "base_plus" | "large";
}

/**
 * `run_sam2_prompt_mask(layer_mask, points, variant)`: record the SAM 2 point
 * prompts and activate the mask target. The document-level `points` are read
 * by the backend's interactive segmenter on run; the resulting artifact lands
 * on the targeted mask, never on a new layer.
 */
export const sam2PromptMaskAction: StudioAction<Sam2PromptMaskParams> = {
  id: "run_sam2_prompt_mask",
  label: "SAM 2 prompt mask",
  capabilities: ["mask.subject.point_prompt"],
  requiredTarget: ["layer_mask"],
  dryRun(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return refuse(this.id, ctx, "not a layer mask");
    if (!params?.points?.length || !params.points.some((p) => p.label === 1)) {
      return refuse(this.id, ctx, "needs at least one positive point prompt");
    }
    if (!withMaskTargetActive(ctx.state, ctx.target)) return refuse(this.id, ctx, "mask target not found");
    return {
      ok: true,
      action: this.id,
      target: describeTarget(ctx.target),
      costClass: "local_compute",
      capability: "mask.subject.point_prompt",
      creates: "mask artifact",
      summary: `SAM 2 point-prompt (${params.points.length} points${params.variant ? `, ${params.variant}` : ""}) onto ${describeTarget(ctx.target)}`,
    };
  },
  preview(ctx, params) {
    return { kind: "document", doc: this.commit(ctx, params).state.current };
  },
  commit(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return { ok: false, state: ctx.state, summary: "not a layer mask" };
    const targeted = withMaskTargetActive(ctx.state, ctx.target);
    if (!targeted) return { ok: false, state: ctx.state, summary: "mask target not found" };
    const doc = targeted.current;
    const next: EditState = {
      current: { ...doc, points: params.points.map((p) => ({ ...p })) },
      past: [...targeted.past, doc],
      future: [],
    };
    return { ok: true, state: next, summary: `SAM 2 prompts recorded for ${describeTarget(ctx.target)}` };
  },
};

export interface FeatherMaskParams {
  radiusPx: number;
}

/** `feather_layer_mask(layer_mask, radiusPx)`: append a feather op to the mask stack. */
export const featherLayerMaskAction: StudioAction<FeatherMaskParams> = {
  id: "feather_layer_mask",
  label: "Feather layer mask",
  capabilities: [],
  requiredTarget: ["layer_mask"],
  dryRun(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return refuse(this.id, ctx, "not a layer mask");
    if (!params || !(params.radiusPx > 0)) return refuse(this.id, ctx, "feather radius must be positive");
    if (!withMaskTargetActive(ctx.state, ctx.target)) return refuse(this.id, ctx, "mask target not found");
    return {
      ok: true,
      action: this.id,
      target: describeTarget(ctx.target),
      costClass: "free",
      creates: "mask edit op",
      summary: `feather ${describeTarget(ctx.target)} by ${params.radiusPx}px`,
    };
  },
  preview(ctx, params) {
    return { kind: "document", doc: this.commit(ctx, params).state.current };
  },
  commit(ctx, params) {
    if (ctx.target.kind !== "layer_mask") return { ok: false, state: ctx.state, summary: "not a layer mask" };
    const targeted = withMaskTargetActive(ctx.state, ctx.target);
    if (!targeted) return { ok: false, state: ctx.state, summary: "mask target not found" };
    const next = addOperation(targeted, { type: "feather", amount: params.radiusPx });
    if (next === targeted) return { ok: false, state: ctx.state, summary: "mask stack rejected the op" };
    return { ok: true, state: next, summary: `feathered ${describeTarget(ctx.target)} by ${params.radiusPx}px` };
  },
};

/** The registry preloaded with the first non-agent actions. */
export function builtinStudioActions(): StudioActionRegistry {
  const registry = createStudioActionRegistry();
  registry.register(createLayerMaskAction);
  registry.register(selectionToLayerMaskAction);
  registry.register(sam2PromptMaskAction);
  registry.register(featherLayerMaskAction);
  return registry;
}
