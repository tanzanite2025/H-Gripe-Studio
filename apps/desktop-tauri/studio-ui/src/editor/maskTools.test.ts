import { describe, expect, it } from "vitest";
import { EXEC_LANES } from "./execLanes";
import {
  DEFAULT_TOOL_ID,
  MASK_TOOLS,
  PLANNED_TOOLS,
  READY_TOOLS,
  maskTool,
  toolTargets,
} from "./maskTools";

describe("mask tool registry", () => {
  it("has unique ids", () => {
    const ids = MASK_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships pen / lasso as ready path tools", () => {
    for (const id of ["pen", "lasso"]) {
      expect(maskTool(id)?.status, id).toBe("ready");
      expect(maskTool(id)?.kind, id).toBe("path");
    }
  });

  it("ships brush / eraser / point / wand / morphology / matting as ready", () => {
    for (const id of ["brush", "eraser", "point", "wand", "rect", "ellipse", "invert", "fill_holes", "smooth", "grow", "shrink", "feather", "matting"]) {
      expect(maskTool(id)?.status, id).toBe("ready");
    }
  });

  it("exposes the matting tool as a trimap-band paint tool", () => {
    const matting = maskTool("matting");
    expect(matting?.status).toBe("ready");
    expect(matting?.kind).toBe("matte");
  });

  it("exposes the SAM 2 point-prompt tool", () => {
    const point = maskTool("point");
    expect(point?.status).toBe("ready");
    expect(point?.kind).toBe("point");
  });

  it("partitions ready vs planned and orders ready first", () => {
    expect(READY_TOOLS.every((t) => t.status === "ready")).toBe(true);
    expect(PLANNED_TOOLS.every((t) => t.status === "planned")).toBe(true);
    expect(READY_TOOLS.length + PLANNED_TOOLS.length).toBe(MASK_TOOLS.length);
    const firstPlanned = MASK_TOOLS.findIndex((t) => t.status === "planned");
    if (firstPlanned !== -1) {
      const lastReady = MASK_TOOLS.map((t) => t.status).lastIndexOf("ready");
      expect(lastReady).toBeLessThan(firstPlanned);
    }
  });

  it("the default tool is ready and selectable", () => {
    expect(maskTool(DEFAULT_TOOL_ID)?.status).toBe("ready");
    expect(DEFAULT_TOOL_ID).toBe("brush");
  });

  it("paint tools carry an add/subtract mode", () => {
    expect(maskTool("brush")?.mode).toBe("add");
    expect(maskTool("eraser")?.mode).toBe("subtract");
  });

  it("decouples paint tools from a single target (M4)", () => {
    expect(toolTargets(maskTool("brush")!)).toEqual(["layer", "matte"]);
    expect(toolTargets(maskTool("eraser")!)).toEqual(["layer"]);
    expect(toolTargets(maskTool("matting")!)).toEqual(["matte"]);
    expect(toolTargets(maskTool("pen")!)).toEqual(["layer"]);
  });

  it("tags every tool with an execution lane", () => {
    const lanes = new Set(EXEC_LANES);
    for (const tool of MASK_TOOLS) {
      expect(lanes.has(tool.lane), tool.id).toBe(true);
    }
  });

  it("routes paint / marquee / path tools to the interactive lane", () => {
    for (const id of ["brush", "eraser", "rect", "ellipse", "pen", "lasso"]) {
      expect(maskTool(id)?.lane, id).toBe("interactive");
    }
  });

  it("routes geometry / morphology tools to the preview lane", () => {
    for (const id of ["invert", "fill_holes", "smooth", "grow", "shrink", "feather"]) {
      expect(maskTool(id)?.lane, id).toBe("preview");
    }
  });

  it("routes model / real-pixel tools to the render lane", () => {
    for (const id of ["point", "wand", "matting"]) {
      expect(maskTool(id)?.lane, id).toBe("render");
    }
  });
});
