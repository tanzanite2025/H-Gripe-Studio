export const GEOMETRY_SELECTION_TOOL_IDS = ["rect", "ellipse", "polygon_lasso", "pen"] as const;
export const ASSISTED_SELECTION_TOOL_IDS = ["magnetic_lasso", "object_select", "quick_select", "wand", "point"] as const;

export type GeometrySelectionToolId = (typeof GEOMETRY_SELECTION_TOOL_IDS)[number];
export type AssistedSelectionToolId = (typeof ASSISTED_SELECTION_TOOL_IDS)[number];

const GEOMETRY_SELECTION_TOOL_SET = new Set<string>(GEOMETRY_SELECTION_TOOL_IDS);
const ASSISTED_SELECTION_TOOL_SET = new Set<string>(ASSISTED_SELECTION_TOOL_IDS);

// Current implemented assist-read consumers. Other assisted tools stay here
// only after their pointer/model path is wired to SelectionAssistReadSource.
const SELECTION_ASSIST_READ_TOOL_SET = new Set<string>(["magnetic_lasso"]);

export function isGeometrySelectionTool(toolId: string): toolId is GeometrySelectionToolId {
  return GEOMETRY_SELECTION_TOOL_SET.has(toolId);
}

export function isAssistedSelectionTool(toolId: string): toolId is AssistedSelectionToolId {
  return ASSISTED_SELECTION_TOOL_SET.has(toolId);
}

export function usesSelectionAssistRead(toolId: string): boolean {
  return SELECTION_ASSIST_READ_TOOL_SET.has(toolId);
}
