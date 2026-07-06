// The active canvas's graph (nodes + edges) as an external store, outside the
// App-layer React state. FlowCanvas subscribes to every change (it must render
// each drag frame), while the rest of the app subscribes through a drag-aware
// view (`useGraphView`) that skips frames where only in-drag node positions
// moved — so dragging a node re-renders the canvas layer only, not the whole
// tree. The drag-end frame (dragging: false) does propagate, so autosave,
// undo, and the multi-canvas park/restore always see final positions.
// Framework-free core (subscribe/getState/set) mirroring productionStore.

import { useSyncExternalStore } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from "@hgripe/flow";

export interface HelperLineState {
  horizontal?: number;
  vertical?: number;
}

interface GraphState {
  nodes: Node[];
  edges: Edge[];
  helperLines: HelperLineState;
}

let state: GraphState = { nodes: [], edges: [], helperLines: {} };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const graphStore = {
  getState: () => state,
  subscribe,
};

/** Replace the whole graph (canvas mount / tab switch / restore). */
export function seedGraph(nodes: Node[], edges: Edge[]): void {
  state = { ...state, nodes, edges };
  emit();
}

export type GraphUpdater<T> = T[] | ((current: T[]) => T[]);

export function setGraphNodes(update: GraphUpdater<Node>): void {
  const nodes = typeof update === "function" ? update(state.nodes) : update;
  if (nodes === state.nodes) return;
  state = { ...state, nodes };
  emit();
}

export function setGraphEdges(update: GraphUpdater<Edge>): void {
  const edges = typeof update === "function" ? update(state.edges) : update;
  if (edges === state.edges) return;
  state = { ...state, edges };
  emit();
}

export const onGraphNodesChange: OnNodesChange = (changes) => {
  setGraphNodes((nodes) => applyNodeChanges(changes, nodes));
};

export const onGraphEdgesChange: OnEdgesChange = (changes) => {
  setGraphEdges((edges) => applyEdgeChanges(changes, edges));
};

/** Alignment-guide lines for the current drag frame (canvas overlay only). */
export function setGraphHelperLines(lines: HelperLineState): void {
  const prev = state.helperLines;
  if (prev.horizontal === lines.horizontal && prev.vertical === lines.vertical) return;
  state = { ...state, helperLines: lines };
  emit();
}

/** Per-frame node subscription — the canvas layer. */
export function useGraphNodes(): Node[] {
  return useSyncExternalStore(subscribe, () => state.nodes);
}

/** Per-frame edge subscription — the canvas layer. */
export function useGraphEdges(): Edge[] {
  return useSyncExternalStore(subscribe, () => state.edges);
}

export function useGraphHelperLines(): HelperLineState {
  return useSyncExternalStore(subscribe, () => state.helperLines);
}

// A node array counts as unchanged when every difference is confined to nodes
// currently being dragged (position/measured churn); anything structural —
// ids, data, selection, parenting, or a node that stopped dragging — counts
// as a change.
function nodesEqualIgnoringDragFrames(a: Node[], b: Node[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const prev = a[i];
    const next = b[i];
    if (prev === next) continue;
    if (!next.dragging) return false;
    if (
      prev.id !== next.id ||
      prev.type !== next.type ||
      prev.data !== next.data ||
      prev.selected !== next.selected ||
      prev.parentId !== next.parentId ||
      prev.hidden !== next.hidden
    ) {
      return false;
    }
  }
  return true;
}

export interface GraphView {
  nodes: Node[];
  edges: Edge[];
}

let cachedView: GraphView = { nodes: state.nodes, edges: state.edges };

function getViewSnapshot(): GraphView {
  const { nodes, edges } = state;
  if (cachedView.edges === edges && nodesEqualIgnoringDragFrames(cachedView.nodes, nodes)) {
    return cachedView;
  }
  cachedView = { nodes, edges };
  return cachedView;
}

/**
 * Drag-aware graph view for the app layer: referentially stable across drag
 * frames (in-drag position-only updates), so subscribers don't re-render
 * while a node is being dragged; structural changes and the drag-end frame
 * propagate normally.
 */
export function useGraphView(): GraphView {
  return useSyncExternalStore(subscribe, getViewSnapshot);
}
