// Pre-execution run report (RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN, step 8):
// once a scope is resolved and lowered, summarise in the run log exactly what
// is about to execute — the scope, the node/row counts, which integrated-card
// rows run vs. are skipped, and the backend/device refs the nodes carry — so
// the user never has to infer run scope from wiring or from mid-run failures.
//
// Pure and renderer-agnostic (like runlog.ts): the controller feeds the
// resolved/lowered graphs in and logs the returned lines.

import { LOWERED_CARD_ROWS } from "../graph/lowering";
import type { WorkflowGraph } from "../graph/model";

/** Lowered row-leaf id -> its semantic row name (`card::row` -> `row`). */
function rowOfLeaf(leafId: string, cardId: string): string {
  return leafId.slice(cardId.length + "::".length);
}

function asRef(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Build the run-report lines for a resolved scope about to execute.
 *
 * - `scopeLabel`: human label from `describeRunScope`.
 * - `authored`: the resolved scope subgraph (visible cards, pre-lowering).
 * - `lowered` / `origin`: the executable graph from `lowerWorkflowGraph`.
 */
export function buildRunReport(opts: {
  scopeLabel: string;
  authored: WorkflowGraph;
  lowered: WorkflowGraph;
  origin: Map<string, string>;
}): string[] {
  const { scopeLabel, authored, lowered, origin } = opts;
  const lines: string[] = [];

  // Scope + counts: how many nodes execute, and how many of them are hidden
  // row leaves lowered out of integrated cards.
  const cardIds = new Set(origin.values());
  let head = `scope ${scopeLabel}: ${lowered.nodes.length} node(s) to execute`;
  if (origin.size > 0) {
    head += ` (${origin.size} row(s) from ${cardIds.size} integrated card(s))`;
  }
  lines.push(head);

  // Integrated cards: which semantic rows run and which are skipped. A row is
  // skipped when it has no leaf in the lowered graph (not wired, or outside
  // the scope for row-scoped runs).
  const rowsByCard = new Map<string, Set<string>>();
  for (const [leafId, cardId] of origin) {
    let set = rowsByCard.get(cardId);
    if (!set) rowsByCard.set(cardId, (set = new Set()));
    set.add(rowOfLeaf(leafId, cardId));
  }
  for (const node of authored.nodes) {
    const defs = LOWERED_CARD_ROWS[node.kind];
    if (!defs) continue;
    const running = rowsByCard.get(node.id) ?? new Set<string>();
    const skipped = defs.map((d) => d.row).filter((row) => !running.has(row));
    const ran = defs.map((d) => d.row).filter((row) => running.has(row));
    let line = `card ${node.id}: `;
    line += ran.length > 0 ? `runs ${ran.join(", ")}` : "no rows to run";
    if (skipped.length > 0) line += `; skips ${skipped.join(", ")}`;
    lines.push(line);
  }

  // Backend/device refs carried by the executing nodes (post-lowering, so row
  // params are already un-prefixed): which API profile / local model each node
  // will ask for, plus its device/precision policies where present.
  for (const node of lowered.nodes) {
    const api = asRef(node.params["api_profile_ref"]);
    const local = asRef(node.params["local_model_ref"]);
    if (!api && !local) continue;
    const parts: string[] = [];
    if (api) parts.push(`api profile "${api}"`);
    if (local) {
      const device = asRef(node.params["device"]);
      const precision = asRef(node.params["precision"]);
      const policies = [device && `device ${device}`, precision && `precision ${precision}`]
        .filter(Boolean)
        .join(", ");
      parts.push(`local model "${local}"${policies ? ` (${policies})` : ""}`);
    }
    lines.push(`backend ${node.id}: ${parts.join(", ")}`);
  }

  return lines;
}
