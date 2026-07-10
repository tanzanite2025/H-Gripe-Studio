import { memo, useRef } from "react";
import {
  addEdge,
  BaseEdge,
  ReactFlow,
  useReactFlow,
  useStore,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import { cachedRoutedEdgePath, portedChamferPath, type Pt } from "./edgeRouting";
import {
  EDGE_ARROW_MARKER,
  EDGE_STROKE_WIDTH,
  EDGE_STROKE_WIDTH_SELECTED,
  edgeMarkerId,
  hgripeEdgeVisualState,
  isEdgeLodActive,
  type HgripeEdgeData,
  type HgripeEdgeVisualState,
} from "./edgeVisual";

// Boolean zoom selector: edges re-render only when crossing the LOD
// threshold, not on every zoom tick.
const selectEdgeLod = (s: { transform: [number, number, number] }) =>
  isEdgeLodActive(s.transform[2]);

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
const RUNNING_STROKE = "#4cc9f0";
const RUNNING_STROKE_SELECTED = "#7bdff2";
const ERROR_STROKE = "#ff6b6b";
const ERROR_STROKE_SELECTED = "#ff9191";
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
const RUNNING_ARROW_ID = "hgripe-edge-arrow-running";
const RUNNING_ARROW_SELECTED_ID = "hgripe-edge-arrow-running-selected";
const ERROR_ARROW_ID = "hgripe-edge-arrow-error";
const ERROR_ARROW_SELECTED_ID = "hgripe-edge-arrow-error-selected";
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
        <ArrowMarker id={RUNNING_ARROW_ID} fill={RUNNING_STROKE} />
        <ArrowMarker id={RUNNING_ARROW_SELECTED_ID} fill={RUNNING_STROKE_SELECTED} />
        <ArrowMarker id={ERROR_ARROW_ID} fill={ERROR_STROKE} />
        <ArrowMarker id={ERROR_ARROW_SELECTED_ID} fill={ERROR_STROKE_SELECTED} />
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

function edgeStroke(
  kind: "data" | "binding",
  state: HgripeEdgeVisualState,
  selected: boolean | undefined,
) {
  if (state === "running") return selected ? RUNNING_STROKE_SELECTED : RUNNING_STROKE;
  if (state === "error") return selected ? ERROR_STROKE_SELECTED : ERROR_STROKE;
  if (kind === "binding") return selected ? BINDING_STROKE_SELECTED : BINDING_STROKE;
  return selected ? EDGE_STROKE_SELECTED : EDGE_STROKE;
}

function edgeMarker(
  kind: "data" | "binding",
  state: HgripeEdgeVisualState,
  selected: boolean | undefined,
) {
  if (state === "running") return selected ? RUNNING_ARROW_SELECTED_ID : RUNNING_ARROW_ID;
  if (state === "error") return selected ? ERROR_ARROW_SELECTED_ID : ERROR_ARROW_ID;
  if (kind === "binding") return selected ? BINDING_ARROW_SELECTED_ID : BINDING_ARROW_ID;
  return selected ? DATA_ARROW_SELECTED_ID : DATA_ARROW_ID;
}

function edgePathClassName(state: HgripeEdgeVisualState, lod: boolean) {
  if (state === "running" && !lod) return "hgripe-edge-path-running";
  if (state === "error") return "hgripe-edge-path-error";
  return undefined;
}

function WaypointHandles({
  waypoints,
  selected,
  onDragStart,
  onChange,
  onRemove,
}: {
  waypoints: readonly Pt[];
  selected: boolean | undefined;
  onDragStart?: () => void;
  onChange?: (index: number, point: Pt) => void;
  onRemove?: (index: number) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const dragStarted = useRef(false);

  if (!selected || waypoints.length === 0) return null;

  return (
    <>
      {waypoints.map((point, index) => (
        <circle
          key={index}
          className="hgripe-edge-waypoint nodrag nopan"
          cx={point.x}
          cy={point.y}
          r={6}
          onPointerDown={(event) => {
            event.stopPropagation();
            dragStarted.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            if (!dragStarted.current) {
              dragStarted.current = true;
              onDragStart?.();
            }
            onChange?.(
              index,
              screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onRemove?.(index);
          }}
        >
          <title>Drag waypoint; double-click to remove</title>
        </circle>
      ))}
    </>
  );
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
  sourcePosition,
  targetPosition,
  selected,
  data,
  style,
}: EdgeProps<Edge<HgripeEdgeData>>) {
  const lod = useStore(selectEdgeLod) && !selected;
  const waypoints = data?.waypoints ?? [];
  const path = cachedRoutedEdgePath(
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    waypoints,
    { sourcePosition, targetPosition },
  );
  const state = hgripeEdgeVisualState(data);
  const customStroke = style?.stroke ? String(style.stroke) : undefined;
  const markerId = customStroke ? edgeMarkerId(DATA_ARROW_ID, id) : edgeMarker("data", state, selected);

  return (
    <>
      {customStroke && !lod ? (
        <defs>
          <ArrowMarker id={markerId} fill={customStroke} />
        </defs>
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        className={edgePathClassName(state, lod)}
        markerEnd={lod ? undefined : `url(#${markerId})`}
        style={{
          stroke: edgeStroke("data", state, selected),
          strokeWidth: selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeDasharray: state === "running" ? "8 5" : state === "error" ? "7 4" : undefined,
          ...style,
        }}
      />
      {waypoints.length > 0 ? (
        <WaypointHandles
          waypoints={waypoints}
          selected={selected}
          onDragStart={data?.onWaypointDragStart}
          onChange={data?.onWaypointChange}
          onRemove={data?.onWaypointRemove}
        />
      ) : null}
    </>
  );
});

export const BindingEdge = memo(function BindingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  style,
}: EdgeProps<Edge<HgripeEdgeData>>) {
  const lod = useStore(selectEdgeLod) && !selected;
  const waypoints = data?.waypoints ?? [];
  const path = cachedRoutedEdgePath(
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    waypoints,
    { sourcePosition, targetPosition },
  );
  const state = hgripeEdgeVisualState(data);
  const customStroke = style?.stroke ? String(style.stroke) : undefined;
  const markerId = customStroke
    ? edgeMarkerId(BINDING_ARROW_ID, id)
    : edgeMarker("binding", state, selected);

  return (
    <>
      {customStroke && !lod ? (
        <defs>
          <ArrowMarker id={markerId} fill={customStroke} />
        </defs>
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        className={edgePathClassName(state, lod)}
        markerEnd={lod ? undefined : `url(#${markerId})`}
        style={{
          stroke: edgeStroke("binding", state, selected),
          strokeWidth: selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeDasharray: state === "running" ? "8 5" : state === "error" ? "7 4" : "4 3",
          ...style,
        }}
      />
      {waypoints.length > 0 ? (
        <WaypointHandles
          waypoints={waypoints}
          selected={selected}
          onDragStart={data?.onWaypointDragStart}
          onChange={data?.onWaypointChange}
          onRemove={data?.onWaypointRemove}
        />
      ) : null}
    </>
  );
});

export function DragConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const valid = connectionStatus !== "invalid";
  const stroke = valid ? DRAG_STROKE_VALID : DRAG_STROKE_INVALID;
  const markerId = valid ? DRAG_ARROW_VALID_ID : DRAG_ARROW_INVALID_ID;
  const path = portedChamferPath(
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    { sourcePosition: fromPosition, targetPosition: toPosition },
  );

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
