// Canvas document shell (multi-canvas workspace plan, Phase 2): the graph the
// editor shows is one document inside a project, not the app's whole state.
// Wrapping the current single canvas in a `CanvasDocument` gives tabs (Phase 3)
// and the project manifest (Phase 4) a stable shape without changing the
// persisted workflow format.

import type { Edge, Node } from "@xyflow/react";

/** React Flow pane viewport (flow-space translate + zoom). */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export type CanvasRunState = "idle" | "running" | "failed" | "complete";

/** One canvas tab: a workflow graph plus its own view/selection/file state. */
export interface CanvasDocument {
  id: string;
  /** Display title: the backing file's base name, or the untitled label. */
  title: string;
  /** On-disk workflow backing the canvas (null = untitled). */
  path: string | null;
  kind: "workflow";
  nodes: Node[];
  edges: Edge[];
  /** Unsaved edits against `path` (separate from workspace autosave). */
  dirty: boolean;
  selectedNodeId: string | null;
  viewport: CanvasViewport;
  /** Undo/snapshot scope key so one canvas never overwrites another's stack. */
  historyScopeId: string;
  runState: CanvasRunState;
}

export function newCanvasDocumentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The document's display title: `path` base name, else the untitled label. */
export function canvasDocumentTitle(path: string | null, untitledLabel: string): string {
  if (!path) return untitledLabel;
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || untitledLabel;
}
