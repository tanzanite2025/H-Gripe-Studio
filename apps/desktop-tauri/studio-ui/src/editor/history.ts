// Renderer-agnostic undo/redo stack for the node graph. Kept as a plain
// factory (no React) so the logic is unit-testable on its own; `useHistory`
// wraps it for the editor.

import type { Edge, Node } from "@xyflow/react";

export interface GraphSnapshot {
  nodes: Node[];
  edges: Edge[];
}

export interface HistoryStack {
  /** Record `current` as a restore point. Clears the redo stack. */
  push(current: GraphSnapshot): void;
  /** Move back one step: returns the state to restore (and stashes `current`
   *  for redo), or `null` when there is nothing to undo. */
  undo(current: GraphSnapshot): GraphSnapshot | null;
  /** Move forward one step, or `null` when there is nothing to redo. */
  redo(current: GraphSnapshot): GraphSnapshot | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Drop all history (e.g. after a load/clear that should not be undoable). */
  clear(): void;
}

// Graph data boundary: node data must hold only light references — paths,
// ids, protocol objects. Heavy payloads (base64 previews, raw pixels, big
// logs) belong in caches/files keyed by reference; anything stored on a node
// is multiplied by the history depth. `findHeavyGraphData` flags violations
// so they surface as a console warning the moment they are introduced.
const HEAVY_STRING_CHARS = 64 * 1024;

/** Returns a description of the first heavy value found in node data, or null. */
export function findHeavyGraphData(snapshot: GraphSnapshot): string | null {
  for (const node of snapshot.nodes) {
    const seen = new Set<object>();
    const stack: unknown[] = [node.data];
    while (stack.length > 0) {
      const v = stack.pop();
      if (typeof v === "string") {
        if (v.startsWith("data:") && v.length > 1024) {
          return `node ${node.id} (${String((node.data as { kind?: unknown })?.kind ?? "?")}): data: URI in node data`;
        }
        if (v.length > HEAVY_STRING_CHARS) {
          return `node ${node.id} (${String((node.data as { kind?: unknown })?.kind ?? "?")}): string over ${HEAVY_STRING_CHARS} chars in node data`;
        }
      } else if (typeof v === "object" && v !== null && !seen.has(v)) {
        seen.add(v);
        stack.push(...Object.values(v));
      }
    }
  }
  return null;
}

export function createHistoryStack(limit = 100): HistoryStack {
  let past: GraphSnapshot[] = [];
  let future: GraphSnapshot[] = [];

  return {
    push(current) {
      const heavy = findHeavyGraphData(current);
      if (heavy) {
        console.warn(`[history] heavy graph data — keep node data to light refs: ${heavy}`);
      }
      past.push(current);
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(current) {
      const prev = past.pop();
      if (!prev) return null;
      future.push(current);
      return prev;
    },
    redo(current) {
      const next = future.pop();
      if (!next) return null;
      past.push(current);
      return next;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    clear() {
      past = [];
      future = [];
    },
  };
}
