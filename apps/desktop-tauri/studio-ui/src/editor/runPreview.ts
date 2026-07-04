// Pre-run preview for the canvas run HUD: given the authored graph and a
// RunScope, list exactly which cards would execute, grouped by their palette
// category, plus the scope resolver's warnings. Pure and renderer-agnostic so
// the HUD (and any future entry point) can show "what will run" before
// dispatching anything.

import type { WorkflowGraph } from "../graph/model";
import { NODE_SPECS } from "../graph/nodeSpecs";
import { resolveRunScope, type RunScope } from "../runtime/runScope";
import { GROUP_KIND } from "./grouping";

export type PreviewCategory =
  | "source"
  | "generate"
  | "process"
  | "review"
  | "workflow"
  | "output"
  | "internal";

export interface RunPreviewNode {
  id: string;
  kind: string;
}

export interface RunPreviewGroup {
  category: PreviewCategory;
  nodes: RunPreviewNode[];
}

export interface RunPreview {
  /** Executable card count (group frames excluded). */
  total: number;
  /** Scope resolution warnings (missing nodes, cut-away inputs). */
  warnings: string[];
  /** Cards to execute, grouped by palette category in display order. */
  groups: RunPreviewGroup[];
}

const CATEGORY_ORDER: PreviewCategory[] = [
  "source",
  "generate",
  "process",
  "review",
  "workflow",
  "output",
  "internal",
];

export function buildRunPreview(graph: WorkflowGraph, scope: RunScope): RunPreview {
  const resolved = resolveRunScope(graph, scope);
  const cards = resolved.graph.nodes.filter((n) => n.kind !== GROUP_KIND);

  const byCategory = new Map<PreviewCategory, RunPreviewNode[]>();
  for (const node of cards) {
    // Unknown kinds (stale saved graphs) group under `internal` instead of throwing.
    const category = (NODE_SPECS[node.kind]?.category ?? "internal") as PreviewCategory;
    let list = byCategory.get(category);
    if (!list) byCategory.set(category, (list = []));
    list.push({ id: node.id, kind: node.kind });
  }

  const groups: RunPreviewGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const nodes = byCategory.get(category);
    if (nodes && nodes.length > 0) groups.push({ category, nodes });
  }

  return { total: cards.length, warnings: resolved.warnings, groups };
}
