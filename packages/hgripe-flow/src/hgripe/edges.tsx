import { memo } from "react";
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
import {
  EDGE_ARROW_MARKER,
  EDGE_STROKE_WIDTH,
  EDGE_STROKE_WIDTH_SELECTED,
  edgeMarkerId,
} from "./edgeVisual";

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
const EDGE_STROKE_SELECTED = "#8fb2ff";
const BINDING_STROKE = "#7c5cff";
const BINDING_STROKE_SELECTED = "#a58fff";
const DRAG_STROKE_VALID = "#8fb2ff";
const DRAG_STROKE_INVALID = "#ff6b6b";

// Default arrow markers are defined once per canvas and shared by every edge
// (SVG url(#id) references resolve document-wide). A per-edge marker is only
// rendered for edges with a custom stroke colour, so a large graph does not
// carry one <defs><marker> pair per wire.
const DATA_ARROW_ID = "hgripe-edge-arrow";
const DATA_ARROW_SELECTED_ID = "hgripe-edge-arrow-selected";
const BINDING_ARROW_ID = "hgripe-binding-arrow";
const BINDING_ARROW_SELECTED_ID = "hgripe-binding-arrow-selected";
const DRAG_ARROW_VALID_ID = "hgripe-drag-arrow-valid";
const DRAG_ARROW_INVALID_ID = "hgripe-drag-arrow-invalid";

function ArrowMarker({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      viewBox={EDGE_ARROW_MARKER.viewBox}
      refX={EDGE_ARROW_MARKER.refX}
      refY={EDGE_ARROW_MARKER.refY}
      markerWidth={EDGE_ARROW_MARKER.markerWidth}
      markerHeight={EDGE_ARROW_MARKER.markerHeight}
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} />
    </marker>
  );
}

const SharedEdgeMarkers = memo(function SharedEdgeMarkers() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden>
      <defs>
        <ArrowMarker id={DATA_ARROW_ID} fill={EDGE_STROKE} />
        <ArrowMarker id={DATA_ARROW_SELECTED_ID} fill={EDGE_STROKE_SELECTED} />
        <ArrowMarker id={BINDING_ARROW_ID} fill={BINDING_STROKE} />
        <ArrowMarker id={BINDING_ARROW_SELECTED_ID} fill={BINDING_STROKE_SELECTED} />
        <ArrowMarker id={DRAG_ARROW_VALID_ID} fill={DRAG_STROKE_VALID} />
        <ArrowMarker id={DRAG_ARROW_INVALID_ID} fill={DRAG_STROKE_INVALID} />
      </defs>
    </svg>
  );
});

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
  children,
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
    >
      <SharedEdgeMarkers />
      {children}
    </ReactFlow>
  );
}

export const ChamferEdge = memo(function ChamferEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  style,
}: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const customStroke = style?.stroke ? String(style.stroke) : undefined;
  const markerId = customStroke
    ? edgeMarkerId(DATA_ARROW_ID, id)
    : selected
      ? DATA_ARROW_SELECTED_ID
      : DATA_ARROW_ID;

  return (
    <>
      {customStroke ? (
        <defs>
          <ArrowMarker id={markerId} fill={customStroke} />
        </defs>
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke: selected ? EDGE_STROKE_SELECTED : EDGE_STROKE,
          strokeWidth: selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          ...style,
        }}
      />
    </>
  );
});

export const BindingEdge = memo(function BindingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  style,
}: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const customStroke = style?.stroke ? String(style.stroke) : undefined;
  const markerId = customStroke
    ? edgeMarkerId(BINDING_ARROW_ID, id)
    : selected
      ? BINDING_ARROW_SELECTED_ID
      : BINDING_ARROW_ID;

  return (
    <>
      {customStroke ? (
        <defs>
          <ArrowMarker id={markerId} fill={customStroke} />
        </defs>
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke: selected ? BINDING_STROKE_SELECTED : BINDING_STROKE,
          strokeWidth: selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeDasharray: "4 3",
          ...style,
        }}
      />
    </>
  );
});

export function DragConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  connectionStatus,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const valid = connectionStatus !== "invalid";
  const stroke = valid ? DRAG_STROKE_VALID : DRAG_STROKE_INVALID;
  const markerId = valid ? DRAG_ARROW_VALID_ID : DRAG_ARROW_INVALID_ID;
  const path = chamferPath({ x: fromX, y: fromY }, { x: toX, y: toY });

  return (
    <path
      d={path}
      fill="none"
      stroke={stroke}
      strokeWidth={EDGE_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      markerEnd={`url(#${markerId})`}
      style={connectionLineStyle}
    />
  );
}

export const HGRIPE_EDGE_TYPES = {
  [HGRIPE_DATA_EDGE_TYPE]: ChamferEdge,
  [HGRIPE_BINDING_EDGE_TYPE]: BindingEdge,
};
