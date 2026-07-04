// Project manifest (multi-canvas workspace plan, Phase 4): the persisted list
// of open canvas documents — per-canvas graph, file binding, selection, and
// viewport — so the tab set survives a reload. The manifest lives next to the
// legacy single-graph autosave (which keeps being written for backward
// compatibility); when a manifest exists it wins on restore.

import { type WorkflowGraph } from "../graph/model";
import { DEFAULT_CANVAS_VIEWPORT, type CanvasViewport } from "./canvasDocument";

/** One canvas document's persisted state inside the manifest. */
export interface ProjectCanvasState {
  id: string;
  path: string | null;
  dirty: boolean;
  selectedNodeId: string | null;
  viewport: CanvasViewport;
  graph: WorkflowGraph;
}

export interface ProjectManifest {
  version: 1;
  activeCanvasId: string;
  canvases: ProjectCanvasState[];
}

// Browser-preview manifest key. Desktop builds persist through the Rust
// backend (`read/write_studio_project_manifest`); localStorage is the
// vite-dev/tests fallback. Bump the suffix on incompatible shape changes.
const STORAGE_KEY = "hgripe.studio.project.v1";

export function serializeProjectManifest(manifest: ProjectManifest): string {
  return JSON.stringify(manifest);
}

function isViewport(v: unknown): v is CanvasViewport {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === "number" && typeof o.y === "number" && typeof o.zoom === "number";
}

function parseCanvas(raw: unknown): ProjectCanvasState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  const graph = o.graph as WorkflowGraph | undefined;
  if (typeof graph !== "object" || graph === null) return null;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  return {
    id: o.id,
    path: typeof o.path === "string" ? o.path : null,
    dirty: o.dirty === true,
    selectedNodeId: typeof o.selectedNodeId === "string" ? o.selectedNodeId : null,
    viewport: isViewport(o.viewport) ? o.viewport : DEFAULT_CANVAS_VIEWPORT,
    graph,
  };
}

/** Parse a persisted manifest, or null when absent/corrupt/incompatible. */
export function parseProjectManifest(text: string | null): ProjectManifest | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || raw.version !== 1) return null;
    if (!Array.isArray(raw.canvases)) return null;
    const canvases = raw.canvases
      .map(parseCanvas)
      .filter((c): c is ProjectCanvasState => c !== null);
    if (canvases.length === 0) return null;
    const activeCanvasId =
      typeof raw.activeCanvasId === "string" &&
      canvases.some((c) => c.id === raw.activeCanvasId)
        ? raw.activeCanvasId
        : canvases[0].id;
    return { version: 1, activeCanvasId, canvases };
  } catch {
    return null;
  }
}

/** Restore the browser-preview manifest, or null if none / unreadable. */
export function loadLocalProjectManifest(): ProjectManifest | null {
  try {
    return parseProjectManifest(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persist the manifest to browser localStorage (best-effort). */
export function saveLocalProjectManifest(manifest: ProjectManifest): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeProjectManifest(manifest));
  } catch {
    // Quota exceeded / storage disabled — persistence is best-effort.
  }
}

export function clearLocalProjectManifest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
