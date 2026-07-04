// Run scope model (RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN, steps 1–2).
//
// A RunScope names *what* the user asked to execute — full canvas, one node's
// upstream chain, a selection, a card, or a card row — independently of the UI
// entry point that produced it (toolbar button, context menu, row affordance,
// or a future automation trigger). `resolveRunScope` turns a scope plus the
// authored graph into the concrete subgraph to execute, so every entry point
// shares one dependency policy instead of re-deriving it.

import type { WorkflowGraph } from "../graph/model";
import { ancestorSubgraph } from "./dag";

export type RunScope =
  | { kind: "full_canvas"; canvasId: string }
  | { kind: "node_upstream"; canvasId: string; nodeId: string }
  | { kind: "node_downstream"; canvasId: string; nodeId: string }
  | { kind: "selection_with_upstream"; canvasId: string; nodeIds: string[] }
  | { kind: "selection_only"; canvasId: string; nodeIds: string[] }
  | { kind: "card"; canvasId: string; nodeId: string }
  | { kind: "card_row"; canvasId: string; nodeId: string; rowId: string };

export interface ResolvedRunScope {
  /** The subgraph to execute (nodes + edges between retained nodes). */
  graph: WorkflowGraph;
  /** Non-fatal problems with the scope (missing inputs, unimplemented narrowing). */
  warnings: string[];
}

/** Human-readable scope label for run logs and status messages. */
export function describeRunScope(scope: RunScope): string {
  switch (scope.kind) {
    case "full_canvas":
      return "full canvas";
    case "node_upstream":
      return `up to ${scope.nodeId}`;
    case "node_downstream":
      return `downstream from ${scope.nodeId}`;
    case "selection_with_upstream":
      return `selection (${scope.nodeIds.length} node(s)) with upstream`;
    case "selection_only":
      return `selection (${scope.nodeIds.length} node(s)) only`;
    case "card":
      return `card ${scope.nodeId}`;
    case "card_row":
      return `card ${scope.nodeId} row ${scope.rowId}`;
  }
}

function subgraphOf(graph: WorkflowGraph, keep: Set<string>): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/** All transitive ancestors of the seed set, including the seeds themselves. */
function withAncestors(graph: WorkflowGraph, seeds: Iterable<string>): Set<string> {
  const upstream = new Map<string, string[]>();
  for (const node of graph.nodes) upstream.set(node.id, []);
  for (const edge of graph.edges) upstream.get(edge.target)?.push(edge.source);

  const keep = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const cur = stack.pop()!;
    if (keep.has(cur) || !upstream.has(cur)) continue;
    keep.add(cur);
    for (const up of upstream.get(cur) ?? []) stack.push(up);
  }
  return keep;
}

/** All transitive descendants of `nodeId`, including the node itself. */
function withDescendants(graph: WorkflowGraph, nodeId: string): Set<string> {
  const downstream = new Map<string, string[]>();
  for (const node of graph.nodes) downstream.set(node.id, []);
  for (const edge of graph.edges) downstream.get(edge.source)?.push(edge.target);

  const keep = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (keep.has(cur) || !downstream.has(cur)) continue;
    keep.add(cur);
    for (const down of downstream.get(cur) ?? []) stack.push(down);
  }
  return keep;
}

/**
 * Resolve a scope against the authored graph.
 *
 * Dependency policy (see the plan's "Dependency Rules"):
 * - upstream dependencies are included by default — a scoped run must be able
 *   to compute its inputs even when they sit outside the visual selection;
 * - downstream consumers never run unless the scope is explicitly a
 *   downstream one (`node_downstream`);
 * - `selection_only` keeps just the selected nodes and warns about every
 *   selected node whose required inputs were cut away.
 *
 * Unknown node ids resolve to the full graph (matching `ancestorSubgraph`)
 * with a warning, so a stale id degrades to a normal run instead of a crash.
 */
export function resolveRunScope(graph: WorkflowGraph, scope: RunScope): ResolvedRunScope {
  const warnings: string[] = [];
  const has = (id: string) => graph.nodes.some((n) => n.id === id);

  switch (scope.kind) {
    case "full_canvas":
      return { graph, warnings };

    case "node_upstream":
      if (!has(scope.nodeId)) {
        warnings.push(`node ${scope.nodeId} not found; running the full canvas`);
        return { graph, warnings };
      }
      return { graph: ancestorSubgraph(graph, scope.nodeId), warnings };

    case "node_downstream": {
      if (!has(scope.nodeId)) {
        warnings.push(`node ${scope.nodeId} not found; running the full canvas`);
        return { graph, warnings };
      }
      // Consumers downstream of the node, plus whatever upstream chain those
      // consumers need (which includes the node itself).
      const descendants = withDescendants(graph, scope.nodeId);
      return { graph: subgraphOf(graph, withAncestors(graph, descendants)), warnings };
    }

    case "selection_with_upstream": {
      const present = scope.nodeIds.filter(has);
      for (const id of scope.nodeIds) {
        if (!present.includes(id)) warnings.push(`selected node ${id} not found; ignored`);
      }
      if (present.length === 0) {
        warnings.push("selection is empty; running the full canvas");
        return { graph, warnings };
      }
      return { graph: subgraphOf(graph, withAncestors(graph, present)), warnings };
    }

    case "selection_only": {
      const present = new Set(scope.nodeIds.filter(has));
      for (const id of scope.nodeIds) {
        if (!present.has(id)) warnings.push(`selected node ${id} not found; ignored`);
      }
      if (present.size === 0) {
        warnings.push("selection is empty; running the full canvas");
        return { graph, warnings };
      }
      for (const edge of graph.edges) {
        if (present.has(edge.target) && !present.has(edge.source)) {
          warnings.push(
            `${edge.target}: input "${edge.targetPort}" comes from ${edge.source} outside the selection and will be missing`,
          );
        }
      }
      return { graph: subgraphOf(graph, present), warnings };
    }

    case "card":
      // A card run is the card plus its upstream chain; enabled-row narrowing
      // lands with the card/row execution steps of the plan.
      if (!has(scope.nodeId)) {
        warnings.push(`card ${scope.nodeId} not found; running the full canvas`);
        return { graph, warnings };
      }
      return { graph: ancestorSubgraph(graph, scope.nodeId), warnings };

    case "card_row":
      // Row-scoped narrowing (plan step 3) is not implemented yet: resolve to
      // the owning card's upstream chain and say so.
      if (!has(scope.nodeId)) {
        warnings.push(`card ${scope.nodeId} not found; running the full canvas`);
        return { graph, warnings };
      }
      warnings.push(
        `row-scoped execution is not implemented yet; running card ${scope.nodeId} with upstream`,
      );
      return { graph: ancestorSubgraph(graph, scope.nodeId), warnings };
  }
}
