// Compute block capability registry (docs/plans/active/
// MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md, step 5). A compute block is a
// structured, capability-addressed computation — `image + prompts -> mask` —
// never a hidden UI click and never a magical layer creator. Blocks are the
// backend-facing half of Studio Actions: an action resolves a target, then
// asks the registry which block serves a capability id and which managed
// backend (model manager entry) can run it.

import type { ManagedBackendRef, ModelCapability } from "../models/backendRegistry";
import type { PointPrompt } from "../types/production";

/**
 * The capability taxonomy Studio Actions speak. Finer-grained than the model
 * manager's `ModelCapability` — each id maps onto one manager capability for
 * backend selection.
 */
export type ComputeCapabilityId =
  | "mask.subject.point_prompt"
  | "mask.subject.salient"
  | "matte.alpha.refine"
  | "selection.from_colour"
  | "selection.from_path"
  | "image.inpaint";

/** How a block spends resources; the preview gate shows this before commit. */
export type ComputeCostClass = "free" | "local_compute" | "api_paid";

/** SAM 2 prompt-mask request: image + prompts -> mask. */
export interface Sam2MaskRequest {
  imageRef: string;
  targetSpace: "document" | "layer" | "viewport";
  points?: PointPrompt[];
  box?: [number, number, number, number];
  pathId?: string;
  selectionId?: string;
  variant?: "tiny" | "small" | "base_plus" | "large";
  backendRef?: string;
}

/** SAM 2 prompt-mask result: a previewable mask artifact, never a layer. */
export interface Sam2MaskResult {
  maskArtifactRef: string;
  confidence?: number;
  bbox?: [number, number, number, number];
  provider: "sam2" | "builtin-cpu" | string;
  variantUsed?: string;
}

/** The backend a block run was resolved to (from the model manager). */
export interface ComputeRunContext {
  backend: ManagedBackendRef | null;
}

/**
 * One registered computation. `run` is injected by the host (Rust bridge,
 * API client, test fake) — the registry owns the contract, not the transport.
 */
export interface ComputeBlock<TRequest = unknown, TResult = unknown> {
  id: string;
  label: string;
  capability: ComputeCapabilityId;
  /** Model-manager capability used to list/resolve backends for this block. */
  backendCapability: ModelCapability;
  costClass: ComputeCostClass;
  run(request: TRequest, ctx: ComputeRunContext): Promise<TResult>;
}

export interface ComputeBlockRegistry {
  register(block: ComputeBlock<never, unknown>): void;
  get(id: string): ComputeBlock | undefined;
  /** Blocks serving one capability id, in registration order. */
  forCapability(capability: ComputeCapabilityId): ComputeBlock[];
  list(): ComputeBlock[];
}

export function createComputeBlockRegistry(): ComputeBlockRegistry {
  const blocks = new Map<string, ComputeBlock>();
  return {
    register(block) {
      if (blocks.has(block.id)) throw new Error(`compute block already registered: ${block.id}`);
      blocks.set(block.id, block as ComputeBlock);
    },
    get: (id) => blocks.get(id),
    forCapability: (capability) => [...blocks.values()].filter((b) => b.capability === capability),
    list: () => [...blocks.values()],
  };
}

/** The transport actually running a SAM 2 prompt (Rust bridge / API / fake). */
export type Sam2Runner = (request: Sam2MaskRequest, ctx: ComputeRunContext) => Promise<Sam2MaskResult>;

/**
 * SAM 2 as the first compute block: `mask.subject.point_prompt`. Backend
 * selection goes through the model manager's `mask.subject` entries.
 */
export function sam2PointPromptBlock(run: Sam2Runner): ComputeBlock<Sam2MaskRequest, Sam2MaskResult> {
  return {
    id: "sam2.point_prompt",
    label: "SAM 2 point-prompt mask",
    capability: "mask.subject.point_prompt",
    backendCapability: "mask.subject",
    costClass: "local_compute",
    run,
  };
}
