// Which manager capability each card's backend selectors filter by, plus the
// pre-run validation over stored refs (backend selection contract plan, step 8:
// "Add validation for missing or capability-incompatible refs"). Shared between
// the Inspector (renders the selectors) and the run controller (warns in the
// run log before executing).

import type { WorkflowGraph } from "../graph/model";
import { nodeSpec } from "../graph/nodeSpecs";
import {
  type BackendRegistry,
  type ModelCapability,
  apiProfilesFor,
  localModelsFor,
} from "./backendRegistry";

// Which manager capability a node's backend selector filters by. Selection is
// stored as `api_profile_ref`; legacy provider/model/credentials_ref params are
// still written alongside so the existing executors keep working (backend
// selection contract plan, migration notes).
export function backendCapability(
  kind: string,
  params: Record<string, unknown>,
): ModelCapability | null {
  if (kind === "generate")
    return String(params.operation ?? "") === "image.edit" ? "image.edit" : "image.generate";
  if (kind === "promptOptimize" && String(params.mode ?? "") === "api") return "prompt.rewrite";
  if (kind === "detailRepaint") return "image.edit";
  return null;
}

// Which manager capability a node's local model selector filters by. Selection
// stores `local_model_ref` and mirrors the node's device/precision fields
// where present; the legacy `engine` select stays as the advanced escape hatch.
export function localModelCapability(
  kind: string,
  params: Record<string, unknown>,
): ModelCapability | null {
  if (kind === "subjectMask") return "mask.subject";
  if (kind === "refineMaskEdge") return "matte.refine";
  if (kind === "imageEnhance") return "image.upscale";
  if (kind === "matchLightColor") return "image.enhance";
  if (
    kind === "detailRepaint" &&
    ["sd_inpaint", "sdxl_inpaint", "flux_fill"].includes(String(params.engine ?? ""))
  )
    return "image.inpaint";
  return null;
}

// Row-level backend bindings for integrated cards (backend selection contract
// plan, steps 3–6): each entry is one capability-filtered selector whose
// selection is stored under the card's `<row>.`-namespaced params, so lowering
// forwards it to the leaf executor unchanged.
export interface RowBackendBinding {
  /** Card param the selected ref is stored under. */
  paramKey: string;
  kind: "api" | "local";
  capability: ModelCapability;
  /** i18n key for the row's field label. */
  labelKey: string;
  /** Only active when this param has one of the listed values. */
  visibleWhen?: { param: string; in: string[] };
}

export const ROW_BACKEND_BINDINGS: Record<string, RowBackendBinding[]> = {
  imageProcessing: [
    {
      paramKey: "enhance.local_model_ref",
      kind: "local",
      capability: "image.upscale",
      labelKey: "models.selector.rowEnhance",
    },
    {
      paramKey: "mask.local_model_ref",
      kind: "local",
      capability: "mask.subject",
      labelKey: "models.selector.rowMask",
    },
    {
      paramKey: "repair.api_profile_ref",
      kind: "api",
      capability: "image.edit",
      labelKey: "models.selector.rowRepairApi",
      visibleWhen: { param: "repair.engine", in: ["provider"] },
    },
    {
      paramKey: "repair.local_model_ref",
      kind: "local",
      capability: "image.inpaint",
      labelKey: "models.selector.rowRepairLocal",
      visibleWhen: { param: "repair.engine", in: ["sd_inpaint", "sdxl_inpaint", "flux_fill"] },
    },
  ],
};

function paramOrDefault(kind: string, params: Record<string, unknown>, key: string): unknown {
  return params[key] ?? nodeSpec(kind).params.find((p) => p.key === key)?.defaultValue;
}

/** Whether a row binding is active for the card's current params. */
export function rowBindingActive(
  binding: RowBackendBinding,
  kind: string,
  params: Record<string, unknown>,
): boolean {
  if (!binding.visibleWhen) return true;
  return binding.visibleWhen.in.includes(
    String(paramOrDefault(kind, params, binding.visibleWhen.param)),
  );
}

export interface BackendRefIssue {
  /** Node title (falls back to kind) for the run log. */
  node: string;
  nodeId: string;
  message: string;
}

function checkRef(
  registry: BackendRegistry,
  refKind: "api" | "local",
  ref: string,
  capability: ModelCapability,
): string | null {
  if (ref === "") return null;
  const matching =
    refKind === "api" ? apiProfilesFor(registry, capability) : localModelsFor(registry, capability);
  if (matching.some((e) => e.ref === ref)) return null;
  const all = refKind === "api" ? registry.apiProfiles : registry.localModels;
  const label = refKind === "api" ? "API profile" : "local model";
  return all.some((e) => e.ref === ref)
    ? `${label} ref "${ref}" does not declare capability ${capability} — pick another in the Models / APIs manager`
    : `${label} ref "${ref}" not found in the Models / APIs manager — re-pick or add it`;
}

/**
 * Pre-run validation of every stored backend ref against the manager registry:
 * a ref must exist and its entry must declare the capability the selector
 * filters by. Warnings only — the executors keep their own fallback behavior.
 */
export function validateBackendRefs(
  graph: WorkflowGraph,
  registry: BackendRegistry,
  opts?: {
    /**
     * When set, row bindings of this card are checked only for this row
     * (RunScope `card_row`: other rows do not execute, so their refs are
     * irrelevant to the run).
     */
    rowFilter?: { nodeId: string; rowId: string };
  },
): BackendRefIssue[] {
  const rowFilter = opts?.rowFilter;
  const issues: BackendRefIssue[] = [];
  for (const node of graph.nodes) {
    const spec = nodeSpec(node.kind);
    const title = spec.title || node.kind;
    const push = (message: string | null) => {
      if (message) issues.push({ node: title, nodeId: node.id, message });
    };

    const apiCap = backendCapability(node.kind, node.params);
    if (apiCap) push(checkRef(registry, "api", String(node.params.api_profile_ref ?? ""), apiCap));
    const localCap = localModelCapability(node.kind, node.params);
    if (localCap)
      push(checkRef(registry, "local", String(node.params.local_model_ref ?? ""), localCap));

    for (const binding of ROW_BACKEND_BINDINGS[node.kind] ?? []) {
      if (
        rowFilter &&
        node.id === rowFilter.nodeId &&
        !binding.paramKey.startsWith(`${rowFilter.rowId}.`)
      )
        continue;
      if (!rowBindingActive(binding, node.kind, node.params)) continue;
      push(
        checkRef(
          registry,
          binding.kind,
          String(node.params[binding.paramKey] ?? ""),
          binding.capability,
        ),
      );
    }
  }
  return issues;
}
