// Graph lowering: expands integrated production cards into the hidden
// internal leaf nodes that actually execute (see
// docs/plans/active/NODE_CARD_PRODUCT_BOUNDARY_PLAN.md, "Runtime Contract":
// visible production card -> optional lowering to hidden primitive nodes).
//
// Lowering is data-driven: `LOWERED_CARD_ROWS` maps each integrated card kind
// to its row definitions (semantic row -> leaf node kind + port maps). Each
// row becomes one leaf node when the graph actually wires that row, and the
// card's `row.in` / `row.out` edges are rewritten onto the leaf's real ports.
// Both runtimes consume the lowered graph (the browser-preview DAG and the
// Rust `run_studio_graph` backend), so neither needs to know about the card
// kinds. New integrated cards (audio processing, grading, …) only need a
// NodeSpec with `row.`-prefixed port/param ids plus one entry in this table.

import type { GraphEdge, GraphNode, WorkflowGraph } from "./model";

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

const IMAGE_PROCESSING_ROWS: RowDef[] = [
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
    row: "repair",
    kind: "detailRepaint",
    inputs: { "repair.in": "image", "repair.report": "quality_report" },
    outputs: { "repair.out": "fixed_image" },
  },
];

const VIDEO_PROCESSING_ROWS: RowDef[] = [
  {
    row: "assemble",
    kind: "videoAssemble",
    inputs: { "assemble.in": "frames" },
    outputs: { "assemble.out": "video" },
  },
  {
    row: "trim",
    kind: "videoTrim",
    inputs: { "trim.in": "video" },
    outputs: { "trim.out": "video" },
  },
];

/** Integrated card kind -> the semantic rows it lowers to. */
export const LOWERED_CARD_ROWS: Record<string, RowDef[]> = {
  imageProcessing: IMAGE_PROCESSING_ROWS,
  videoProcessing: VIDEO_PROCESSING_ROWS,
};

interface RowLookup {
  byInput: Map<string, RowDef>;
  byOutput: Map<string, RowDef>;
}

const ROW_LOOKUP = new Map<string, RowLookup>();
for (const [cardKind, rows] of Object.entries(LOWERED_CARD_ROWS)) {
  const lookup: RowLookup = { byInput: new Map(), byOutput: new Map() };
  for (const def of rows) {
    for (const id of Object.keys(def.inputs)) lookup.byInput.set(id, def);
    for (const id of Object.keys(def.outputs)) lookup.byOutput.set(id, def);
  }
  ROW_LOOKUP.set(cardKind, lookup);
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
 * Lower every integrated card (see `LOWERED_CARD_ROWS`) into one hidden leaf
 * node per row that the graph actually uses (a row is used when any edge
 * touches one of its ports). Edges on `row.in` / `row.out` are rewritten onto
 * the leaf node's real ports; everything else passes through untouched.
 */
export function lowerWorkflowGraph(graph: WorkflowGraph): LoweredGraph {
  const origin = new Map<string, string>();
  const cards = new Map<string, RowLookup>();
  for (const node of graph.nodes) {
    const lookup = ROW_LOOKUP.get(node.kind);
    if (lookup) cards.set(node.id, lookup);
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
    markRow(edge.target, cards.get(edge.target)?.byInput.get(edge.targetPort));
    markRow(edge.source, cards.get(edge.source)?.byOutput.get(edge.sourcePort));
  }

  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (!cards.has(node.id)) {
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
    const targetLookup = cards.get(next.target);
    if (targetLookup) {
      const def = targetLookup.byInput.get(next.targetPort);
      if (!def) return next;
      next = {
        ...next,
        target: rowNodeId(next.target, def.row),
        targetPort: def.inputs[next.targetPort],
      };
    }
    const sourceLookup = cards.get(next.source);
    if (sourceLookup) {
      const def = sourceLookup.byOutput.get(next.sourcePort);
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
