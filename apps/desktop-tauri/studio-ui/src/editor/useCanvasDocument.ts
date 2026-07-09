// Owns the canvas documents' live editor state (multi-canvas workspace plan,
// Phase 2/3): the active canvas's graph lives in the external graph store
// (graphStore.ts) so drag frames re-render the canvas layer only; selection
// and pane viewport stay here; inactive canvases are parked in an in-memory
// store and swapped in on tab activation. File path / dirty stay owned by the file
// controller and are rebound through a registered bridge on each switch, so
// persistence and the on-disk workflow format are unchanged.

import { useCallback, useMemo, useRef, useState } from "react";
import type { Edge, Node, OnEdgesChange, OnNodesChange } from "@hgripe/flow";

import {
  graphStore,
  onGraphEdgesChange,
  onGraphNodesChange,
  seedGraph,
  setGraphEdges,
  setGraphNodes,
  useGraphView,
  type GraphUpdater,
} from "./graphStore";
import { DEFAULT_CANVAS_VIEWPORT, newCanvasDocumentId, type CanvasViewport } from "./canvasDocument";

export const MAX_CANVAS_TABS = 3;

export type OpenNewCanvasResult = "opened" | "limit";
export type OpenCanvasWithResult = "opened" | "activated" | "already-active" | "limit";

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
  /** User-set display name overriding the path-derived title. */
  name?: string | null;
}

/** One canvas's full editor state, as exported/restored for persistence. */
export interface CanvasSnapshotState {
  id: string;
  path: string | null;
  dirty: boolean;
  name?: string | null;
  selectedNodeId: string | null;
  viewport: CanvasViewport;
  nodes: Node[];
  edges: Edge[];
}

/** Lets tab switches read/rebind the controller-owned file state. */
export interface CanvasFileBridge {
  get: () => { path: string | null; dirty: boolean };
  set: (path: string | null, dirty: boolean) => void;
}

export interface UseCanvasDocument {
  /** Drag-aware graph view: stable across in-drag position-only frames. */
  nodes: Node[];
  setNodes: (update: GraphUpdater<Node>) => void;
  onNodesChange: OnNodesChange;
  edges: Edge[];
  setEdges: (update: GraphUpdater<Edge>) => void;
  onEdgesChange: OnEdgesChange;
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
  openNewCanvas: () => OpenNewCanvasResult;
  /**
   * Open a loaded workflow in a new tab (parking the active canvas). When
   * `path` is already open in another tab, that tab is activated instead.
   * Returns "opened", "activated", "already-active", or "limit".
   */
  openCanvasWith: (state: { nodes: Node[]; edges: Edge[]; path: string | null }) => OpenCanvasWithResult;
  /** Park the active canvas and swap the given one in. */
  activateCanvas: (id: string) => void;
  /** Close a canvas; when the last one closes, a fresh one replaces it. */
  closeCanvas: (id: string) => void;
  /** Set (or clear, with null) a canvas's user-facing display name. */
  renameCanvas: (id: string, name: string | null) => void;
  /** Export every open canvas (active first-hand, parked verbatim). */
  exportCanvases: (activeFile: { path: string | null; dirty: boolean }) => {
    activeCanvasId: string;
    canvases: CanvasSnapshotState[];
  };
  /** Replace all open canvases with a restored set (startup restore). */
  restoreCanvases: (activeCanvasId: string, canvases: CanvasSnapshotState[]) => void;
}

export function useCanvasDocument(initial: { nodes: Node[]; edges: Edge[] }): UseCanvasDocument {
  const initialId = useRef(newCanvasDocumentId()).current;
  const [documentId, setDocumentId] = useState(initialId);
  const [tabs, setTabs] = useState<CanvasTabInfo[]>([{ id: initialId, path: null, dirty: false }]);
  // Seed the external graph store with this document's graph before the
  // first canvas render (once per mount; a remount re-seeds).
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    seedGraph(initial.nodes, initial.edges);
  }
  const { nodes, edges } = useGraphView();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_CANVAS_VIEWPORT);

  // Parked state of inactive canvases, keyed by document id.
  const store = useRef(new Map<string, StoredCanvas>());
  const fileBridge = useRef<CanvasFileBridge | null>(null);

  // Live values in refs so tab operations read fresh state from stable
  // callbacks (switches happen from user events, not during render). The
  // graph itself is read from the store, which is always current.
  const live = useRef({ documentId, selectedId, viewport });
  live.current = { documentId, selectedId, viewport };
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const registerFileBridge = useCallback((bridge: CanvasFileBridge) => {
    fileBridge.current = bridge;
  }, []);

  // Park the active canvas (graph + selection + viewport + file state).
  const parkActive = useCallback(() => {
    const { documentId: id, selectedId: selectedNodeId, viewport } = live.current;
    const { nodes, edges } = graphStore.getState();
    const file = fileBridge.current?.get() ?? { path: null, dirty: false };
    store.current.set(id, { nodes, edges, selectedNodeId, viewport, path: file.path, dirty: file.dirty });
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...file } : t)));
  }, []);

  // Swap a canvas's state into the live editor without dirty-marking it.
  const loadCanvas = useCallback(
    (id: string, state: StoredCanvas) => {
      fileBridge.current?.set(state.path, state.dirty);
      seedGraph(state.nodes, state.edges);
      setSelectedId(state.selectedNodeId);
      setViewport(state.viewport);
      setDocumentId(id);
    },
    [],
  );

  const openNewCanvas = useCallback(() => {
    if (tabsRef.current.length >= MAX_CANVAS_TABS) return "limit" as const;
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
    return "opened" as const;
  }, [parkActive, loadCanvas]);

  const openCanvasWith = useCallback(
    (state: { nodes: Node[]; edges: Edge[]; path: string | null }) => {
      if (state.path) {
        const activePath = fileBridge.current?.get().path ?? null;
        if (state.path === activePath) return "already-active" as const;
        const existing = tabsRef.current.find(
          (t) => t.id !== live.current.documentId && store.current.get(t.id)?.path === state.path,
        );
        if (existing) {
          const parked = store.current.get(existing.id);
          if (parked) {
            parkActive();
            store.current.delete(existing.id);
            loadCanvas(existing.id, parked);
            return "activated" as const;
          }
        }
      }
      if (tabsRef.current.length >= MAX_CANVAS_TABS) return "limit" as const;
      parkActive();
      const id = newCanvasDocumentId();
      setTabs((list) => [...list, { id, path: state.path, dirty: false }]);
      loadCanvas(id, {
        nodes: state.nodes,
        edges: state.edges,
        selectedNodeId: null,
        viewport: DEFAULT_CANVAS_VIEWPORT,
        path: state.path,
        dirty: false,
      });
      return "opened" as const;
    },
    [parkActive, loadCanvas],
  );

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

  const renameCanvas = useCallback((id: string, name: string | null) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

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

  const exportCanvases = useCallback(
    (activeFile: { path: string | null; dirty: boolean }) => {
      const canvases = tabsRef.current.flatMap((tab): CanvasSnapshotState[] => {
        const name = tab.name ?? null;
        if (tab.id === live.current.documentId) {
          const { selectedId, viewport } = live.current;
          const { nodes, edges } = graphStore.getState();
          return [{ id: tab.id, ...activeFile, name, selectedNodeId: selectedId, viewport, nodes, edges }];
        }
        const parked = store.current.get(tab.id);
        return parked ? [{ id: tab.id, ...parked, name }] : [];
      });
      return { activeCanvasId: live.current.documentId, canvases };
    },
    [],
  );

  const restoreCanvases = useCallback(
    (activeCanvasId: string, canvases: CanvasSnapshotState[]) => {
      const limitedCanvases = canvases.slice(0, MAX_CANVAS_TABS);
      if (limitedCanvases.length === 0) return;
      store.current.clear();
      for (const c of limitedCanvases) {
        store.current.set(c.id, {
          nodes: c.nodes,
          edges: c.edges,
          selectedNodeId: c.selectedNodeId,
          viewport: c.viewport,
          path: c.path,
          dirty: c.dirty,
        });
      }
      const active = limitedCanvases.find((c) => c.id === activeCanvasId) ?? limitedCanvases[0];
      const parked = store.current.get(active.id);
      store.current.delete(active.id);
      setTabs(limitedCanvases.map((c) => ({ id: c.id, path: c.path, dirty: c.dirty, name: c.name ?? null })));
      if (parked) loadCanvas(active.id, parked);
    },
    [loadCanvas],
  );

  return useMemo(
    () => ({
      nodes,
      setNodes: setGraphNodes,
      onNodesChange: onGraphNodesChange,
      edges,
      setEdges: setGraphEdges,
      onEdgesChange: onGraphEdgesChange,
      selectedId,
      setSelectedId,
      viewport,
      setViewport,
      documentId,
      tabs,
      registerFileBridge,
      openNewCanvas,
      openCanvasWith,
      activateCanvas,
      closeCanvas,
      renameCanvas,
      exportCanvases,
      restoreCanvases,
    }),
    [
      nodes,
      edges,
      selectedId,
      viewport,
      documentId,
      tabs,
      registerFileBridge,
      openNewCanvas,
      openCanvasWith,
      activateCanvas,
      closeCanvas,
      renameCanvas,
      exportCanvases,
      restoreCanvases,
    ],
  );
}
