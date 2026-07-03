// Graph lowering: expands integrated production cards into the hidden
// internal leaf nodes that actually execute (see
// docs/plans/active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md, "Runtime Contract":
// visible production card -> optional lowering to hidden primitive nodes).
//
// The only lowered kind today is `imageProcessing`: each semantic row
// (layerSplit / enhance / grade / crop / mask / repair) becomes one leaf node
// when the graph actually wires that row, and the card's `row.in` / `row.out`
// edges are rewritten onto the leaf's real ports. Both runtimes consume the
// lowered graph (the browser-preview DAG and the Rust `run_studio_graph`
// backend), so neither needs to know about the card kind.

import type { GraphEdge, GraphNode, WorkflowGraph } from "./model";

export const IMAGE_PROCESSING_KIND = "imageProcessing";

/** Separator between a card id and its lowered row node id. */
const ROW_ID_SEP = "::";

interface RowDef {
  /** Semantic row prefix used by the card's port ids and param namespace. */
  row: string;
  /** Internal leaf node kind the row lowers to. */
  kind: string;
  /** Card input port id -> leaf input port id. */
  inputs: Record<string, string>;
  /** Card output port id -> leaf output port id. */
  outputs: Record<string, string>;
}

export const IMAGE_PROCESSING_ROWS: RowDef[] = [
  {
    row: "layerSplit",
    kind: "smartLayerSplit",
    inputs: { "layerSplit.in": "image" },
    outputs: { "layerSplit.out": "layered_asset" },
  },
  {
    row: "enhance",
    kind: "imageEnhance",
    inputs: { "enhance.in": "image" },
    outputs: { "enhance.out": "enhanced_image" },
  },
  {
    row: "grade",
    kind: "imageGrade",
    inputs: { "grade.in": "image" },
    outputs: { "grade.out": "image" },
  },
  {
    row: "crop",
    kind: "crop",
    inputs: { "crop.in": "image" },
    outputs: { "crop.out": "image" },
  },
  {
    row: "mask",
    kind: "subjectMask",
    inputs: { "mask.in": "image" },
    outputs: { "mask.out": "mask" },
  },
  {
    row: "repair",
    kind: "detailRepaint",
    inputs: { "repair.in": "image", "repair.report": "quality_report" },
    outputs: { "repair.out": "fixed_image" },
  },
];

const ROW_BY_INPUT = new Map<string, RowDef>();
const ROW_BY_OUTPUT = new Map<string, RowDef>();
for (const def of IMAGE_PROCESSING_ROWS) {
  for (const id of Object.keys(def.inputs)) ROW_BY_INPUT.set(id, def);
  for (const id of Object.keys(def.outputs)) ROW_BY_OUTPUT.set(id, def);
}

function rowNodeId(cardId: string, row: string): string {
  return `${cardId}${ROW_ID_SEP}${row}`;
}

/** Params namespaced `<row>.<key>` on the card, un-prefixed for the leaf. */
function rowParams(cardParams: Record<string, unknown>, row: string): Record<string, unknown> {
  const prefix = `${row}.`;
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cardParams)) {
    if (key.startsWith(prefix)) params[key.slice(prefix.length)] = value;
  }
  return params;
}

export interface LoweredGraph {
  graph: WorkflowGraph;
  /** Lowered (hidden) node id -> the visible card node id it came from. */
  origin: Map<string, string>;
}

/** Map a run-time node id back to its visible card id (identity when not lowered). */
export function originNodeId(origin: Map<string, string>, nodeId: string): string {
  return origin.get(nodeId) ?? nodeId;
}

/**
 * Lower every `imageProcessing` card into one hidden leaf node per row that
 * the graph actually uses (a row is used when any edge touches one of its
 * ports). Edges on `row.in` / `row.out` are rewritten onto the leaf node's
 * real ports; everything else passes through untouched.
 */
export function lowerWorkflowGraph(graph: WorkflowGraph): LoweredGraph {
  const origin = new Map<string, string>();
  const cards = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.kind === IMAGE_PROCESSING_KIND) cards.set(node.id, node);
  }
  if (cards.size === 0) return { graph, origin };

  // card id -> rows referenced by at least one edge.
  const usedRows = new Map<string, Set<RowDef>>();
  const markRow = (cardId: string, def: RowDef | undefined) => {
    if (!def) return;
    let set = usedRows.get(cardId);
    if (!set) usedRows.set(cardId, (set = new Set()));
    set.add(def);
  };
  for (const edge of graph.edges) {
    if (cards.has(edge.target)) markRow(edge.target, ROW_BY_INPUT.get(edge.targetPort));
    if (cards.has(edge.source)) markRow(edge.source, ROW_BY_OUTPUT.get(edge.sourcePort));
  }

  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== IMAGE_PROCESSING_KIND) {
      nodes.push(node);
      continue;
    }
    for (const def of usedRows.get(node.id) ?? []) {
      const id = rowNodeId(node.id, def.row);
      origin.set(id, node.id);
      nodes.push({
        id,
        kind: def.kind,
        position: node.position,
        params: rowParams(node.params, def.row),
      });
    }
  }

  const edges: GraphEdge[] = graph.edges.map((edge) => {
    let next = edge;
    if (cards.has(next.target)) {
      const def = ROW_BY_INPUT.get(next.targetPort);
      if (!def) return next;
      next = {
        ...next,
        target: rowNodeId(next.target, def.row),
        targetPort: def.inputs[next.targetPort],
      };
    }
    if (cards.has(next.source)) {
      const def = ROW_BY_OUTPUT.get(next.sourcePort);
      if (!def) return next;
      next = {
        ...next,
        source: rowNodeId(next.source, def.row),
        sourcePort: def.outputs[next.sourcePort],
      };
    }
    return next;
  });

  return { graph: { ...graph, nodes, edges }, origin };
}
