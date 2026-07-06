export const EDGE_STROKE_WIDTH = 2;
export const EDGE_STROKE_WIDTH_SELECTED = 3;
export const EDGE_ARROW_MARKER = {
  viewBox: "0 0 10 10",
  refX: 8,
  refY: 5,
  markerWidth: 7,
  markerHeight: 7,
};

export function edgeMarkerId(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
