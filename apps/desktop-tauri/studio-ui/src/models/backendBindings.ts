// API-profile capability mapping and pre-run validation. Local-model refs and
// retired inference engines are recognized only to reject old workflows
// explicitly; they are never resolved or allowed to fall back silently.

import { lowerWorkflowGraph } from "../graph/lowering";
import type { WorkflowGraph } from "../graph/model";
import { nodeSpec } from "../graph/nodeSpecs";
import {
  apiProfilesFor,
  type BackendRegistry,
  type ModelCapability,
} from "./backendRegistry";

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

/** Values accepted by old projects but no longer executable. */
export const RETIRED_LOCAL_ENGINES = new Set([
  "onnx_harmonize",
  "onnx_matting",
  "onnx_defect",
  "realesrgan",
  "sd_inpaint",
  "sdxl_inpaint",
  "flux_fill",
]);

export interface BackendRefIssue {
  node: string;
  nodeId: string;
  message: string;
  /** Retired local execution requests must stop the run. */
  blocking: boolean;
}

function apiRefIssue(
  registry: BackendRegistry,
  ref: string,
  capability: ModelCapability,
): string | null {
  if (ref === "") return null;
  if (apiProfilesFor(registry, capability).some((profile) => profile.ref === ref)) return null;
  return registry.apiProfiles.some((profile) => profile.ref === ref)
    ? `API profile ref "${ref}" does not declare capability ${capability} - pick another API profile`
    : `API profile ref "${ref}" not found - re-pick or add it in API Profiles`;
}

function nonEmptyRef(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validate only executable nodes. Integrated cards are lowered first, so
 * stale refs on unwired rows do not block unrelated work.
 */
export function validateBackendRefs(
  authored: WorkflowGraph,
  registry: BackendRegistry,
): BackendRefIssue[] {
  const graph = lowerWorkflowGraph(authored).graph;
  const issues: BackendRefIssue[] = [];

  for (const node of graph.nodes) {
    const title = nodeSpec(node.kind).title || node.kind;
    const push = (message: string, blocking: boolean) =>
      issues.push({ node: title, nodeId: node.id, message, blocking });

    for (const [key, value] of Object.entries(node.params)) {
      if (key === "local_model_ref" || key.endsWith(".local_model_ref")) {
        const ref = nonEmptyRef(value);
        if (ref) {
          push(
            `backend ref "${ref}" is retired and unavailable; clear it and explicitly choose a built-in deterministic path or an API profile`,
            true,
          );
        }
      }
    }

    const engine = nonEmptyRef(node.params.engine);
    if (engine && RETIRED_LOCAL_ENGINES.has(engine)) {
      push(
        `engine "${engine}" is retired and unavailable; explicitly choose the built-in deterministic engine or an API profile`,
        true,
      );
    }

    const capability = backendCapability(node.kind, node.params);
    if (!capability) continue;
    const message = apiRefIssue(
      registry,
      nonEmptyRef(node.params.api_profile_ref) ?? "",
      capability,
    );
    if (message) push(message, false);
  }

  return issues;
}
