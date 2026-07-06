import {
  addEdge,
  BaseEdge,
  ReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import { chamferPath } from "./edgeRouting";
import { EDGE_ARROW_MARKER, EDGE_STROKE_WIDTH, edgeMarkerId } from "./edgeVisual";

export const HGRIPE_DATA_EDGE_TYPE = "chamfer";
export const HGRIPE_BINDING_EDGE_TYPE = "binding";
export const HGRIPE_DEFAULT_EDGE_OPTIONS = { type: HGRIPE_DATA_EDGE_TYPE };
export const HGRIPE_CONNECTION_LINE_CONTAINER_STYLE = {
  zIndex: 1002,
  pointerEvents: "none" as const,
};

export type HgripeFlowProps<NodeType extends Node = Node, EdgeType extends Edge = Edge> = Omit<
  ReactFlowProps<NodeType, EdgeType>,
  "edgeTypes" | "defaultEdgeOptions" | "connectionLineComponent" | "connectionLineContainerStyle"
>;

const EDGE_STROKE = "#aeb4c2";
const BINDING_STROKE = "#7c5cff";
const DRAG_ARROW_ID = "hgripe-drag-connection-arrow";

export function normalizeHgripeEdges(edges: Edge[]): Edge[] {
  for (const edge of edges) {
    const type =
      edge.type === HGRIPE_BINDING_EDGE_TYPE ? HGRIPE_BINDING_EDGE_TYPE : HGRIPE_DATA_EDGE_TYPE;
    if (edge.type !== type) return edges.map(normalizeHgripeEdge);
  }
  return edges;
}

function normalizeHgripeEdge(edge: Edge): Edge {
  const type =
    edge.type === HGRIPE_BINDING_EDGE_TYPE ? HGRIPE_BINDING_EDGE_TYPE : HGRIPE_DATA_EDGE_TYPE;
  return edge.type === type ? edge : { ...edge, type };
}

export function withHgripeDataEdge<T extends Connection | Edge>(
  edge: T,
): T & { type: typeof HGRIPE_DATA_EDGE_TYPE } {
  return { ...edge, type: HGRIPE_DATA_EDGE_TYPE };
}

export function withHgripeBindingEdge<T extends Edge>(
  edge: T,
): T & { type: typeof HGRIPE_BINDING_EDGE_TYPE } {
  return { ...edge, type: HGRIPE_BINDING_EDGE_TYPE };
}

export function addHgripeDataEdge(edge: Connection | Edge, edges: Edge[]): Edge[] {
  return addEdge(withHgripeDataEdge(edge), edges);
}

export function HgripeFlow<NodeType extends Node = Node, EdgeType extends Edge = Edge>({
  edges,
  ...props
}: HgripeFlowProps<NodeType, EdgeType>) {
  const normalizedEdges = edges ? (normalizeHgripeEdges(edges as Edge[]) as EdgeType[]) : edges;

  return (
    <ReactFlow<NodeType, EdgeType>
      {...props}
      edges={normalizedEdges}
      edgeTypes={HGRIPE_EDGE_TYPES}
      connectionLineComponent={DragConnectionLine}
      connectionLineContainerStyle={HGRIPE_CONNECTION_LINE_CONTAINER_STYLE}
      defaultEdgeOptions={HGRIPE_DEFAULT_EDGE_OPTIONS}
    />
  );
}

export function ChamferEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const stroke = String(style?.stroke ?? EDGE_STROKE);
  const markerId = edgeMarkerId("hgripe-edge-arrow", id);

  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox={EDGE_ARROW_MARKER.viewBox}
          refX={EDGE_ARROW_MARKER.refX}
          refY={EDGE_ARROW_MARKER.refY}
          markerWidth={EDGE_ARROW_MARKER.markerWidth}
          markerHeight={EDGE_ARROW_MARKER.markerHeight}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke,
          strokeWidth: EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          ...style,
        }}
      />
    </>
  );
}

export function BindingEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const stroke = String(style?.stroke ?? BINDING_STROKE);
  const markerId = edgeMarkerId("hgripe-binding-arrow", id);

  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox={EDGE_ARROW_MARKER.viewBox}
          refX={EDGE_ARROW_MARKER.refX}
          refY={EDGE_ARROW_MARKER.refY}
          markerWidth={EDGE_ARROW_MARKER.markerWidth}
          markerHeight={EDGE_ARROW_MARKER.markerHeight}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke,
          strokeWidth: EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeDasharray: "4 3",
          ...style,
        }}
      />
    </>
  );
}

export function DragConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  connectionStatus,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const valid = connectionStatus !== "invalid";
  const stroke = valid ? "#8fb2ff" : "#ff6b6b";
  const path = chamferPath({ x: fromX, y: fromY }, { x: toX, y: toY });

  return (
    <>
      <defs>
        <marker
          id={DRAG_ARROW_ID}
          viewBox={EDGE_ARROW_MARKER.viewBox}
          refX={EDGE_ARROW_MARKER.refX}
          refY={EDGE_ARROW_MARKER.refY}
          markerWidth={EDGE_ARROW_MARKER.markerWidth}
          markerHeight={EDGE_ARROW_MARKER.markerHeight}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={EDGE_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#${DRAG_ARROW_ID})`}
        style={connectionLineStyle}
      />
    </>
  );
}

export const HGRIPE_EDGE_TYPES = {
  [HGRIPE_DATA_EDGE_TYPE]: ChamferEdge,
  [HGRIPE_BINDING_EDGE_TYPE]: BindingEdge,
};
