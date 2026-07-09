export const EDGE_STROKE_WIDTH = 2;
export const EDGE_STROKE_WIDTH_SELECTED = 3;
export const EDGE_ARROW_MARKER = {
  viewBox: "0 0 10 10",
  refX: 8,
  refY: 5,
  markerWidth: 7,
  markerHeight: 7,
};

// Below this zoom, edges render in simplified form (no arrow marker) —
// arrowheads are unreadable that far out and markers are the costly part of
// SVG edge rendering. Matches the node-card LOD threshold so both layers
// simplify together. Selected edges keep full detail.
export const EDGE_LOD_ZOOM_THRESHOLD = 0.55;

export type HgripeEdgeVisualState = "default" | "running" | "error";

export interface HgripeEdgeData extends Record<string, unknown> {
  hgripeVisualState?: HgripeEdgeVisualState;
}

export function hgripeEdgeVisualState(
  data: Record<string, unknown> | undefined,
): HgripeEdgeVisualState {
  const state = data?.hgripeVisualState;
  return state === "running" || state === "error" ? state : "default";
}

/** Should an edge render in simplified (marker-less) form at this zoom? */
export function isEdgeLodActive(zoom: number, threshold = EDGE_LOD_ZOOM_THRESHOLD): boolean {
  return zoom < threshold;
}

export function edgeMarkerId(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
