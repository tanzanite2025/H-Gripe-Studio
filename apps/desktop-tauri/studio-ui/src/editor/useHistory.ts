// Thin React wrapper around the pure `HistoryStack`. Exposes stable
// callbacks plus `canUndo`/`canRedo` flags that re-render the toolbar.

import { useCallback, useReducer, useRef } from "react";
import type { Edge, Node } from "@hgripe/flow";
import { createHistoryStack, type GraphSnapshot } from "./history";

interface UseHistoryArgs {
  nodes: Node[];
  edges: Edge[];
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  limit?: number;
  /** Undo scope key: each scope (canvas document) gets its own stack. */
  scopeId?: string;
}

export interface History {
  /** Capture the current graph as a restore point. Call *before* mutating. */
  takeSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory({ nodes, edges, setNodes, setEdges, limit, scopeId }: UseHistoryArgs): History {
  // One stack per scope so one canvas never rewinds another's edits.
  const stacks = useRef(new Map<string, ReturnType<typeof createHistoryStack>>());
  const scope = useRef(scopeId ?? "");
  scope.current = scopeId ?? "";
  const limitRef = useRef(limit);
  const stackFor = useCallback(() => {
    let s = stacks.current.get(scope.current);
    if (!s) {
      s = createHistoryStack(limitRef.current);
      stacks.current.set(scope.current, s);
    }
    return s;
  }, []);
  // Latest graph in a ref so callbacks stay stable but read fresh state.
  const latest = useRef<GraphSnapshot>({ nodes, edges });
  latest.current = { nodes, edges };
  const [, force] = useReducer((x: number) => x + 1, 0);

  const current = (): GraphSnapshot => ({
    nodes: [...latest.current.nodes],
    edges: [...latest.current.edges],
  });

  const takeSnapshot = useCallback(() => {
    stackFor().push(current());
    force();
  }, [stackFor]);

  const undo = useCallback(() => {
    const prev = stackFor().undo(current());
    if (prev) {
      setNodes(prev.nodes);
      setEdges(prev.edges);
    }
    force();
  }, [stackFor, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = stackFor().redo(current());
    if (next) {
      setNodes(next.nodes);
      setEdges(next.edges);
    }
    force();
  }, [stackFor, setNodes, setEdges]);

  const active = stackFor();
  return {
    takeSnapshot,
    undo,
    redo,
    canUndo: active.canUndo(),
    canRedo: active.canRedo(),
  };
}
