// Node type catalogue. Each node kind declares its typed input/output ports
// and default params. The editor builds handles from this, the runtime reads
// it to wire inputs/outputs, and connection validation uses the port types.

import type { PortDataType, PortSpec } from "../model";

export type { PortSpec } from "../model";

export type ParamControl =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "slider"
  | "checkbox"
  | "path"
  /** Registry-backed model dropdown (local models + API profiles, empty allowed). */
  | "model";

export interface ParamSpec {
  key: string;
  label: string;
  control: ParamControl;
  options?: string[];
  defaultValue?: unknown;
  /** For `slider` / `number`. */
  min?: number;
  max?: number;
  step?: number;
  /** Optional hint shown under the control in the inspector. */
  hint?: string;
  /** Render this param directly on the node card (not just the inspector). */
  inline?: boolean;
  /**
   * Render this inline param inside the function block of the given input
   * port, so the param sits in the same framed block as its connection dot
   * (the dot stays vertically centred on the block).
   */
  port?: string;
  /**
   * Only show this param in the inspector when a sibling param's current value
   * is one of `in`. Lets a node hide irrelevant controls (e.g. show API fields
   * only when `mode === "api"`).
   */
  visibleWhen?: { param: string; in: string[] };
  /** For `path` controls: native file-picker extension filter. */
  pickerFilterName?: string;
  pickerExtensions?: string[];
  /**
   * Legacy/diagnostic field kept loadable for saved workflows but hidden from
   * the normal inspector surface behind an advanced disclosure. Cards should
   * carry a managed backend ref (`api_profile_ref`) instead of raw
   * provider/model/credential fields (backend selection contract plan).
   */
  advanced?: boolean;
}

/**
 * Where a node runs — the routing/grouping discriminator.
 * - `graph`  pure in-process node (no backend call).
 * - `local`  a local card; its engines run in-process in native Rust and must
 *   not touch the network.
 * - `compute` in-process native-Rust image/model work; must not touch the network.
 * - `api`    always a provider call (needs a profile + credentials_ref).
 * - `hybrid` user picks per-node via a `mode` param (e.g. `promptOptimize`).
 * See docs/card-executor-split-and-psd-chain-hardening.md.
 */
export type Executor = "graph" | "local" | "compute" | "api" | "hybrid";

/**
 * Visual identity family for the corner type badge on the node card. Separate
 * from `executor` (an image node can be API-backed or a pure file input; its
 * badge family is still `image`). See NODE_CARD_CORNER_BADGE_PLAN.md.
 */
export type NodeVisualFamily =
  | "image"
  | "video"
  | "audio"
  | "psd"
  | "mask"
  | "crop"
  | "grade"
  | "api"
  | "compute"
  | "export"
  | "utility";

export interface NodeSpec {
  kind: string;
  /** Corner badge identity family; the card shell renders the badge from this. */
  family: NodeVisualFamily;
  title: string;
  /** Short description shown in the inspector / node palette. */
  description: string;
  /**
   * Palette grouping. Categories are production-facing so the palette reads
   * like a studio tool (see NODE_CARD_PRODUCT_BOUNDARY_PLAN.md):
   * - `source`   the user places an input object on the canvas.
   * - `generate` a model/provider generation step.
   * - `process`  a production media operation (split/enhance/grade/crop/mask/repair).
   * - `review`   the user confirms or inspects a meaningful result.
   * - `workflow` changes how the graph is executed (e.g. batch fan-out).
   * - `output`   produces a deliverable.
   * - `internal` implementation primitives kept only for saved-workflow /
   *   runtime compatibility; never shown in the palette.
   */
  category: "source" | "generate" | "process" | "review" | "workflow" | "output" | "internal";
  /** Where the node runs; drives palette local/API grouping + broker routing. */
  executor: Executor;
  /**
   * Internal primitives stay loadable for saved workflows/runtime support, but
   * they are not product-facing cards. Their behavior belongs inside the
   * owning media/model/edit card as params, ports, menus, or internal rules.
   */
  palette?: "default" | "internal";
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
}

export function port(id: string, label: string, type: PortDataType): PortSpec {
  return { id, label, type };
}
