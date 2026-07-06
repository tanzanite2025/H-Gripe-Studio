import { useCallback, useEffect, useRef } from "react";
import {
  HgripeFlow,
  MiniMap,
  addHgripeDataEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type IsValidConnection,
  type Viewport,
} from "@hgripe/flow";
import "@hgripe/flow/style.css";

import { useGraphEdges, useGraphHelperLines, useGraphNodes } from "./graphStore";
import { HgripeNode, type HgripeNodeData } from "./HgripeNode";
import { GroupNode } from "./GroupNode";
import { HelperLineOverlay } from "./HelperLineOverlay";
import { miniMapColor } from "./minimap";
import { DND_NODE_KIND } from "./Palette";
import { nodeSpec } from "../graph/nodeSpecs";
import { arePortsCompatible } from "../graph/model";
import { toWorkflowGraph } from "./adapter";
import { wouldCreateCycle } from "../runtime/dag";

interface FlowCanvasProps {
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  onSelect: (nodeId: string | null) => void;
  /** Create a node of `kind` at a flow-space position. */
  onAddNode: (kind: string, position: { x: number; y: number }) => void;
  /** Called right before a new edge is created, so the host can snapshot. */
  onBeforeConnect?: () => void;
  /** Called after a node finishes dragging, so the host can (re)assign groups. */
  onNodeDragStop?: (node: Node) => void;
  /** Called when a pane pan/zoom settles, with the resulting viewport. */
  onViewportChange?: (viewport: Viewport) => void;
  /** Identity of the shown canvas document; on change, `viewport` is restored. */
  viewportKey?: string;
  /** The viewport to restore when `viewportKey` changes (tab switch). */
  viewport?: Viewport;
  /** Snap node positions to a grid while dragging. */
  snapToGrid?: boolean;
  /** Whether to render the minimap. */
  showMinimap?: boolean;
  /** Right-click on a node (screen coords + node id). */
  onNodeContextMenu?: (nodeId: string, at: { x: number; y: number }) => void;
  /** Right-click on empty canvas (screen coords). */
  onPaneContextMenu?: (at: { x: number; y: number }) => void;
}

const SNAP_GRID: [number, number] = [16, 16];
const NODE_TYPES = { hgripe: HgripeNode, group: GroupNode };

export function FlowCanvas({
  onNodesChange,
  onEdgesChange,
  setEdges,
  onSelect,
  onAddNode,
  onBeforeConnect,
  onNodeDragStop,
  onViewportChange,
  viewportKey,
  viewport,
  snapToGrid = false,
  showMinimap = true,
  onNodeContextMenu,
  onPaneContextMenu,
}: FlowCanvasProps) {
  const { screenToFlowPosition, setViewport } = useReactFlow();
  // The canvas layer subscribes to the graph store directly, so drag /
  // connection frames re-render this subtree only, not the app tree above.
  const nodes = useGraphNodes();
  const edges = useGraphEdges();
  const helperLines = useGraphHelperLines();

  // Restore the pane viewport when the shown canvas document changes (tab
  // switch). Skips the initial mount so `fitView` keeps framing the graph.
  const lastViewportKey = useRef(viewportKey);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  useEffect(() => {
    if (viewportKey === lastViewportKey.current) return;
    lastViewportKey.current = viewportKey;
    if (viewportRef.current) void setViewport(viewportRef.current);
  }, [viewportKey, setViewport]);

  const portType = useCallback(
    (nodeId: string | null, handleId: string | null | undefined, dir: "in" | "out") => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return undefined;
      const spec = nodeSpec((node.data as { kind: string }).kind);
      const ports = dir === "in" ? spec.inputs : spec.outputs;
      return ports.find((p) => p.id === handleId)?.type;
    },
    [nodes],
  );

  // Typed-port + acyclic connection validation.
  const isValidConnection: IsValidConnection = useCallback(
    (c: Connection | Edge) => {
      const sourceType = portType(c.source, c.sourceHandle, "out");
      const targetType = portType(c.target, c.targetHandle, "in");
      if (!sourceType || !targetType) return false;
      if (!arePortsCompatible(sourceType, targetType)) return false;
      if (c.source && c.target && wouldCreateCycle(toWorkflowGraph(nodes, edges), c.source, c.target)) {
        return false;
      }
      return true;
    },
    [nodes, edges, portType],
  );

  const onConnect: OnConnect = useCallback(
    (params) => {
      onBeforeConnect?.();
      setEdges((eds) => addHgripeDataEdge(params, eds));
    },
    [setEdges, onBeforeConnect],
  );

  // Minimap fill: run status (progress/failures) over a per-category fallback;
  // group frames get a neutral tone since they are not catalogue nodes.
  const miniColor = useCallback((n: Node) => {
    if (n.type === "group") return "#3a3d47";
    const data = n.data as HgripeNodeData;
    return miniMapColor(data.status, nodeSpec(data.kind).category);
  }, []);

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      onNodeContextMenu?.(node.id, { x: e.clientX, y: e.clientY });
    },
    [onNodeContextMenu],
  );
  const handlePaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      onPaneContextMenu?.({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
    },
    [onPaneContextMenu],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleNodeDragStop = useCallback(
    (_: unknown, node: Node) => onNodeDragStop?.(node),
    [onNodeDragStop],
  );
  const handleMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => onViewportChange?.(vp),
    [onViewportChange],
  );
  const handleSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: Node[] }) => onSelect(sel[0]?.id ?? null),
    [onSelect],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DND_NODE_KIND);
      if (!kind) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onAddNode(kind, position);
    },
    [screenToFlowPosition, onAddNode],
  );

  return (
    <HgripeFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeContextMenu={handleNodeContextMenu}
      onPaneContextMenu={handlePaneContextMenu}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={handleNodeDragStop}
      onMoveEnd={handleMoveEnd}
      snapToGrid={snapToGrid}
      snapGrid={SNAP_GRID}
      isValidConnection={isValidConnection}
      onSelectionChange={handleSelectionChange}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onlyRenderVisibleElements
      deleteKeyCode={["Backspace", "Delete"]}
      proOptions={{ hideAttribution: true }}
      fitView
    >
      {showMinimap && (
        <MiniMap
          className="flow-minimap"
          pannable
          zoomable
          nodeColor={miniColor}
          nodeStrokeWidth={3}
          maskColor="rgba(14, 15, 19, 0.66)"
          bgColor="#11131a"
        />
      )}
      <HelperLineOverlay horizontal={helperLines.horizontal} vertical={helperLines.vertical} />
    </HgripeFlow>
  );
}
