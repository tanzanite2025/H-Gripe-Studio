import { describe, expect, it } from "vitest";
import {
  ASSISTED_SELECTION_TOOL_IDS,
  GEOMETRY_SELECTION_TOOL_IDS,
  isAssistedSelectionTool,
  isGeometrySelectionTool,
  usesSelectionAssistRead,
} from "./selectionToolProtocol";

describe("selection tool protocol", () => {
  it("keeps pure geometry tools separate from assisted selection tools", () => {
    expect(GEOMETRY_SELECTION_TOOL_IDS).toEqual(["rect", "ellipse", "polygon_lasso", "pen"]);
    expect(ASSISTED_SELECTION_TOOL_IDS).toEqual(["magnetic_lasso", "object_select", "quick_select", "wand", "point"]);

    for (const toolId of GEOMETRY_SELECTION_TOOL_IDS) {
      expect(isGeometrySelectionTool(toolId)).toBe(true);
      expect(isAssistedSelectionTool(toolId)).toBe(false);
      expect(usesSelectionAssistRead(toolId)).toBe(false);
    }
  });

  it("allows only wired assisted tools to trigger SelectionAssistReadSource", () => {
    expect(usesSelectionAssistRead("magnetic_lasso")).toBe(true);
    expect(isAssistedSelectionTool("magnetic_lasso")).toBe(true);

    for (const toolId of ["object_select", "quick_select", "wand", "point"]) {
      expect(isAssistedSelectionTool(toolId)).toBe(true);
      expect(usesSelectionAssistRead(toolId)).toBe(false);
    }
  });
});
