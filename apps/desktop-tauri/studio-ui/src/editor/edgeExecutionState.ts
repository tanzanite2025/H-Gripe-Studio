import type {
  Edge,
  HgripeEdgeData,
  HgripeEdgeVisualState,
  Node,
} from "@hgripe/flow";
import type { NodeStatus } from "../runtime/dag";
import type { HgripeNodeData } from "./HgripeNode";

const ERROR_STATUSES = new Set<NodeStatus>(["failed", "cancelled"]);

export function edgeExecutionVisualState(
  sourceStatus: NodeStatus | undefined,
  targetStatus: NodeStatus | undefined,
): HgripeEdgeVisualState {
  if (
    (sourceStatus && ERROR_STATUSES.has(sourceStatus)) ||
    (targetStatus && ERROR_STATUSES.has(targetStatus))
  ) {
    return "error";
  }
  if (sourceStatus === "running" || targetStatus === "running") return "running";
  return "default";
}

export function withEdgeExecutionStates(edges: readonly Edge[], nodes: readonly Node[]): Edge[] {
  const statusByNode = new Map(
    nodes.map((node) => [node.id, (node.data as HgripeNodeData).status] as const),
  );

  return edges.map((edge) => {
    const data: HgripeEdgeData = {
      ...edge.data,
      hgripeVisualState: edgeExecutionVisualState(
        statusByNode.get(edge.source),
        statusByNode.get(edge.target),
      ),
    };
    return { ...edge, data };
  });
}
