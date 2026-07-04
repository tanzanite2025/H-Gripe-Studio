// Owns the canvas documents' live editor state (multi-canvas workspace plan,
// Phase 2/3): the active canvas's graph, selection, and pane viewport live in
// the React Flow hooks; inactive canvases are parked in an in-memory store and
// swapped in on tab activation. File path / dirty stay owned by the file
// controller and are rebound through a registered bridge on each switch, so
// persistence and the on-disk workflow format are unchanged.

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

/** Parked (inactive) canvas state, restored verbatim on tab activation. */
interface StoredCanvas {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  viewport: CanvasViewport;
  path: string | null;
  dirty: boolean;
}

/** Tab-row entry; the active tab's path/dirty come live from the controller. */
export interface CanvasTabInfo {
  id: string;
  path: string | null;
  dirty: boolean;
}

/** Lets tab switches read/rebind the controller-owned file state. */
export interface CanvasFileBridge {
  get: () => { path: string | null; dirty: boolean };
  set: (path: string | null, dirty: boolean) => void;
}

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
  /** The active document's identity; also the undo/snapshot scope key. */
  documentId: string;
  /** Tab row (order preserved); active tab's file state is stale here. */
  tabs: CanvasTabInfo[];
  /** Register the file-state bridge once the file controller exists. */
  registerFileBridge: (bridge: CanvasFileBridge) => void;
  /** Park the active canvas and open a fresh, empty, untitled one. */
  openNewCanvas: () => void;
  /** Park the active canvas and swap the given one in. */
  activateCanvas: (id: string) => void;
  /** Close a canvas; when the last one closes, a fresh one replaces it. */
  closeCanvas: (id: string) => void;
  /** Assemble the full document with controller-owned file/run state. */
  describe: (state: {
    path: string | null;
    dirty: boolean;
    runState: CanvasRunState;
    untitledLabel: string;
  }) => CanvasDocument;
}

export function useCanvasDocument(initial: { nodes: Node[]; edges: Edge[] }): UseCanvasDocument {
  const initialId = useRef(newCanvasDocumentId()).current;
  const [documentId, setDocumentId] = useState(initialId);
  const [tabs, setTabs] = useState<CanvasTabInfo[]>([{ id: initialId, path: null, dirty: false }]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_CANVAS_VIEWPORT);

  // Parked state of inactive canvases, keyed by document id.
  const store = useRef(new Map<string, StoredCanvas>());
  const fileBridge = useRef<CanvasFileBridge | null>(null);

  // Live values in refs so tab operations read fresh state from stable
  // callbacks (switches happen from user events, not during render).
  const live = useRef({ documentId, nodes, edges, selectedId, viewport });
  live.current = { documentId, nodes, edges, selectedId, viewport };
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const registerFileBridge = useCallback((bridge: CanvasFileBridge) => {
    fileBridge.current = bridge;
  }, []);

  // Park the active canvas (graph + selection + viewport + file state).
  const parkActive = useCallback(() => {
    const { documentId: id, nodes, edges, selectedNodeId, viewport } = {
      ...live.current,
      selectedNodeId: live.current.selectedId,
    };
    const file = fileBridge.current?.get() ?? { path: null, dirty: false };
    store.current.set(id, { nodes, edges, selectedNodeId, viewport, path: file.path, dirty: file.dirty });
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...file } : t)));
  }, []);

  // Swap a canvas's state into the live editor without dirty-marking it.
  const loadCanvas = useCallback(
    (id: string, state: StoredCanvas) => {
      fileBridge.current?.set(state.path, state.dirty);
      setNodes(state.nodes);
      setEdges(state.edges);
      setSelectedId(state.selectedNodeId);
      setViewport(state.viewport);
      setDocumentId(id);
    },
    [setNodes, setEdges],
  );

  const openNewCanvas = useCallback(() => {
    parkActive();
    const id = newCanvasDocumentId();
    setTabs((list) => [...list, { id, path: null, dirty: false }]);
    loadCanvas(id, {
      nodes: [],
      edges: [],
      selectedNodeId: null,
      viewport: DEFAULT_CANVAS_VIEWPORT,
      path: null,
      dirty: false,
    });
  }, [parkActive, loadCanvas]);

  const activateCanvas = useCallback(
    (id: string) => {
      if (id === live.current.documentId) return;
      const parked = store.current.get(id);
      if (!parked) return;
      parkActive();
      store.current.delete(id);
      loadCanvas(id, parked);
    },
    [parkActive, loadCanvas],
  );

  const closeCanvas = useCallback(
    (id: string) => {
      const closingActive = id === live.current.documentId;
      store.current.delete(id);
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      setTabs(remaining);
      if (!closingActive) return;
      const next = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      const parked = next ? store.current.get(next.id) : undefined;
      if (next && parked) {
        store.current.delete(next.id);
        loadCanvas(next.id, parked);
      } else {
        // Last tab closed: replace it with a fresh untitled canvas.
        const freshId = newCanvasDocumentId();
        setTabs([...remaining, { id: freshId, path: null, dirty: false }]);
        loadCanvas(freshId, {
          nodes: [],
          edges: [],
          selectedNodeId: null,
          viewport: DEFAULT_CANVAS_VIEWPORT,
          path: null,
          dirty: false,
        });
      }
    },
    [loadCanvas],
  );

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
      tabs,
      registerFileBridge,
      openNewCanvas,
      activateCanvas,
      closeCanvas,
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
      tabs,
      registerFileBridge,
      openNewCanvas,
      activateCanvas,
      closeCanvas,
      describe,
    ],
  );
}
