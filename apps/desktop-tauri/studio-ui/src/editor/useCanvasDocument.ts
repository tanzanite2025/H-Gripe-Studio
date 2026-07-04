// Owns one canvas document's live editor state (multi-canvas workspace plan,
// Phase 2): graph, selection, and pane viewport, wrapped so the app holds a
// document shell rather than loose state hooks. File path / dirty / run state
// stay owned by their controllers and fold in through `describe`, keeping
// persistence and behavior unchanged while giving Phase 3 tabs one object to
// hold per canvas.

import { useCallback, useMemo, useRef, useState } from "react";
import { useEdgesState, useNodesState, type Edge, type Node } from "@xyflow/react";

import {
  canvasDocumentTitle,
  DEFAULT_CANVAS_VIEWPORT,
  newCanvasDocumentId,
  type CanvasDocument,
  type CanvasRunState,
  type CanvasViewport,
} from "./canvasDocument";

export interface UseCanvasDocument {
  nodes: Node[];
  setNodes: ReturnType<typeof useNodesState>[1];
  onNodesChange: ReturnType<typeof useNodesState>[2];
  edges: Edge[];
  setEdges: ReturnType<typeof useEdgesState>[1];
  onEdgesChange: ReturnType<typeof useEdgesState>[2];
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  viewport: CanvasViewport;
  setViewport: (viewport: CanvasViewport) => void;
  /** Stable document identity; also the undo/snapshot scope key. */
  documentId: string;
  /** Assemble the full document with controller-owned file/run state. */
  describe: (state: {
    path: string | null;
    dirty: boolean;
    runState: CanvasRunState;
    untitledLabel: string;
  }) => CanvasDocument;
}

export function useCanvasDocument(initial: { nodes: Node[]; edges: Edge[] }): UseCanvasDocument {
  const documentId = useRef(newCanvasDocumentId()).current;
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_CANVAS_VIEWPORT);

  const describe = useCallback(
    ({
      path,
      dirty,
      runState,
      untitledLabel,
    }: {
      path: string | null;
      dirty: boolean;
      runState: CanvasRunState;
      untitledLabel: string;
    }): CanvasDocument => ({
      id: documentId,
      title: canvasDocumentTitle(path, untitledLabel),
      path,
      kind: "workflow",
      nodes,
      edges,
      dirty,
      selectedNodeId: selectedId,
      viewport,
      historyScopeId: documentId,
      runState,
    }),
    [documentId, nodes, edges, selectedId, viewport],
  );

  return useMemo(
    () => ({
      nodes,
      setNodes,
      onNodesChange,
      edges,
      setEdges,
      onEdgesChange,
      selectedId,
      setSelectedId,
      viewport,
      setViewport,
      documentId,
      describe,
    }),
    [
      nodes,
      setNodes,
      onNodesChange,
      edges,
      setEdges,
      onEdgesChange,
      selectedId,
      viewport,
      documentId,
      describe,
    ],
  );
}
