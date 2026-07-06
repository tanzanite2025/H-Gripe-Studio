// Canvas document identity and title helpers (multi-canvas workspace): each
// canvas tab carries a stable document id (also the undo/snapshot scope key)
// and a path-derived display title.

/** React Flow pane viewport (flow-space translate + zoom). */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

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
