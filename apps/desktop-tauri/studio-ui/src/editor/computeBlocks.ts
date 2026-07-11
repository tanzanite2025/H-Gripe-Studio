// Compute block capability registry (docs/plans/active/
// MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md, step 5). A compute block is a
// structured, capability-addressed computation:
// `image + prompts -> selection alpha artifact`; never a hidden UI click and
// never a magical layer creator. Blocks are the backend-facing half of Studio
// Actions: an action resolves a target, then asks the registry which block serves
// a capability id and which managed backend (model manager entry) can run it.

import { sam2PromptMask } from "../bridge/sam2";
import type { ManagedBackendRef, ModelCapability } from "../models/backendRegistry";
import { type PointPrompt } from "../contracts/imageEditOps";

/**
 * The capability taxonomy Studio Actions speak. Finer-grained than the model
 * manager's `ModelCapability` 鈥?each id maps onto one manager capability for
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

/** SAM 2 point-prompt request: image + prompts -> selection-alpha artifact. */
export interface Sam2SelectionAlphaRequest {
  imageRef: string;
  targetSpace: "document" | "layer" | "viewport";
  points?: PointPrompt[];
  box?: [number, number, number, number];
  pathId?: string;
  selectionId?: string;
  variant?: "tiny" | "small" | "base_plus" | "large";
  backendRef?: string;
}

/** SAM 2 point-prompt result: a previewable selection-alpha artifact, never a layer. */
export interface Sam2SelectionAlphaResult {
  selectionAlphaArtifactRef: string;
  confidence?: number;
  bbox?: [number, number, number, number];
  provider: "sam2" | "builtin-cpu" | string;
  variantUsed?: string;
  /** Fraction of selected pixels, 0..=1, when the backend reports it. */
  coverage?: number;
  /** The weight file(s) inference ran on, when the backend reports it. */
  modelPath?: string;
}

/** The backend a block run was resolved to (from the model manager). */
export interface ComputeRunContext {
  backend: ManagedBackendRef | null;
}

/**
 * One registered computation. `run` is injected by the host (Rust bridge,
 * API client, test fake) 鈥?the registry owns the contract, not the transport.
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
export type Sam2Runner = (
  request: Sam2SelectionAlphaRequest,
  ctx: ComputeRunContext,
) => Promise<Sam2SelectionAlphaResult>;

/**
 * SAM 2 as the first compute block: `mask.subject.point_prompt`. Backend
 * selection goes through the model manager's `mask.subject` entries.
 */
export function sam2PointPromptBlock(
  run: Sam2Runner,
): ComputeBlock<Sam2SelectionAlphaRequest, Sam2SelectionAlphaResult> {
  return {
    id: "sam2.point_prompt",
    label: "SAM 2 point-prompt selection alpha",
    capability: "mask.subject.point_prompt",
    backendCapability: "mask.subject",
    costClass: "local_compute",
    run,
  };
}

/**
 * The real transport: the Rust `sam2_prompt_mask` command via the Tauri
 * bridge (the in-process ONNX SAM 2 stack; salient / builtin CPU fallback
 * when weights are missing). Needs at least one positive point 鈥?box / path /
 * selection prompts are later work for the Rust command.
 */
export const bridgeSam2Runner: Sam2Runner = async (request) => {
  const points = request.points ?? [];
  if (!points.some((p) => p.label === 1)) {
    throw new Error("SAM 2 point-prompt needs at least one positive point");
  }
  const result = await sam2PromptMask({
    image: request.imageRef,
    points: points.map((p) => ({ x: p.x, y: p.y, label: p.label })),
    variant: request.variant,
  });
  return {
    selectionAlphaArtifactRef: result.mask_path,
    bbox: result.bbox ?? undefined,
    provider: result.provider,
    variantUsed: result.variant_requested,
    coverage: result.coverage,
    modelPath: result.model_path ?? undefined,
  };
};

/** The registry preloaded with the production compute blocks. */
export function builtinComputeBlocks(): ComputeBlockRegistry {
  const registry = createComputeBlockRegistry();
  registry.register(sam2PointPromptBlock(bridgeSam2Runner));
  return registry;
}
