import { describe, expect, it } from "vitest";
import { EXEC_LANES } from "./execLanes";
import {
  DEFAULT_TOOL_ID,
  MASK_TOOLS,
  MASK_TOOL_GROUPS,
  PLANNED_TOOLS,
  READY_TOOLS,
  maskTool,
  shapeVertices,
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

  it("ships move / crop as ready M5 tools", () => {
    const move = maskTool("move");
    expect(move?.status).toBe("ready");
    expect(move?.kind).toBe("transform");
    const crop = maskTool("crop");
    expect(crop?.status).toBe("ready");
    expect(crop?.kind).toBe("marquee");
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

  it("toolbar groups cover every tool exactly once (PS layout)", () => {
    const grouped = MASK_TOOL_GROUPS.flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(MASK_TOOLS.map((t) => t.id).sort());
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
    for (const id of ["invert", "fill_holes", "smooth", "grow", "shrink", "feather", "move", "crop"]) {
      expect(maskTool(id)?.lane, id).toBe("preview");
    }
  });

  it("routes model / real-pixel tools to the render lane", () => {
    for (const id of ["point", "wand", "matting"]) {
      expect(maskTool(id)?.lane, id).toBe("render");
    }
  });

  it("ships the shape tool as a ready interactive tool (M15)", () => {
    const shape = maskTool("shape");
    expect(shape?.status).toBe("ready");
    expect(shape?.kind).toBe("shape");
    expect(shape?.lane).toBe("interactive");
  });
});

describe("shapeVertices", () => {
  const box: [number, number, number, number] = [0, 0, 100, 50];

  it("builds a triangle inscribed in the drag box", () => {
    const pts = shapeVertices("triangle", box, 5);
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(50); // apex at top centre
    expect(pts[0][1]).toBeCloseTo(0);
  });

  it("builds a regular n-gon with the requested side count", () => {
    expect(shapeVertices("polygon", box, 6)).toHaveLength(6);
    expect(shapeVertices("polygon", box, 2)).toHaveLength(3); // clamped to >= 3
  });

  it("builds a star with interleaved inner points", () => {
    const pts = shapeVertices("star", box, 5);
    expect(pts).toHaveLength(10);
    const cx = 50;
    const cy = 25;
    const r = (p: [number, number]) => Math.hypot((p[0] - cx) / 50, (p[1] - cy) / 25);
    expect(r(pts[0])).toBeCloseTo(1);
    expect(r(pts[1])).toBeCloseTo(0.5);
  });

  it("builds a line as a thin rectangle along the drag vector", () => {
    const pts = shapeVertices("line", [0, 0, 100, 0], 5, 10);
    expect(pts).toHaveLength(4);
    expect(pts[0][1]).toBeCloseTo(5);
    expect(pts[3][1]).toBeCloseTo(-5);
  });

  it("returns no vertices for a degenerate drag", () => {
    expect(shapeVertices("polygon", [10, 10, 10, 40], 5)).toHaveLength(0);
    expect(shapeVertices("line", [10, 10, 10, 10], 5)).toHaveLength(0);
  });
});
