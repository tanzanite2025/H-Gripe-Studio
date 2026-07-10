import type { CSSProperties } from "react";
import type { Edge, Node } from "@hgripe/flow";

import type { HgripeNodeData } from "./HgripeNode";
import { imageSourceSlotColorForPort } from "../domain/imageSourceSlots";

export function withImageSourceSlotEdgeColors(edges: Edge[], nodes: Node[]): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    const source = byId.get(edge.source);
    if (!source) return edge;
    const data = source.data as HgripeNodeData;
    if (data.kind !== "imageSource") return edge;
    const color = imageSourceSlotColorForPort(data.params, edge.sourceHandle);
    if (!color) return edge;
    const style: CSSProperties = { ...(edge.style ?? {}), stroke: color };
    return { ...edge, style };
  });
}
