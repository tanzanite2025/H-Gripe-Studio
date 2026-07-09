import { describe, expect, it } from "vitest";
import { EXEC_LANES } from "./execLanes";
import {
  DEFAULT_TOOL_ID,
  MASK_OPS,
  MASK_TOOLS,
  MASK_TOOL_GROUPS,
  MASK_TOOL_SLOTS,
  PLANNED_TOOLS,
  PS_TOOL_SECTIONS,
  READY_TOOLS,
  maskTool,
  psSlotOf,
  shapeVertices,
  toolTargets,
} from "./maskTools";
import { hasToolIcon } from "./maskEditModal/toolIcons";

describe("mask tool registry", () => {
  it("has unique ids", () => {
    const ids = MASK_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships pen / magnetic lasso as ready path tools", () => {
    for (const id of ["pen", "magnetic_lasso"]) {
      expect(maskTool(id)?.status, id).toBe("ready");
      expect(maskTool(id)?.kind, id).toBe("path");
    }
  });

  it("does not expose the plain freehand lasso as a tool", () => {
    expect(maskTool("lasso")).toBeUndefined();
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

  it("toolbar groups cover every canvas tool exactly once (PS layout)", () => {
    const grouped = MASK_TOOL_GROUPS.flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    const canvasTools = MASK_TOOLS.filter((t) => t.kind !== "global").map((t) => t.id);
    expect([...grouped].sort()).toEqual(canvasTools.sort());
  });

  it("toolbar slots cover every canvas tool exactly once (PS flyout layout)", () => {
    const slotted = MASK_TOOL_SLOTS.flat(2);
    expect(new Set(slotted).size).toBe(slotted.length);
    const canvasTools = MASK_TOOLS.filter((t) => t.kind !== "global").map((t) => t.id);
    expect([...slotted].sort()).toEqual(canvasTools.sort());
  });

  it("mask ops cover every whole-mask operation, and none sits in the toolbar", () => {
    const globals = MASK_TOOLS.filter((t) => t.kind === "global").map((t) => t.id);
    expect([...MASK_OPS].sort()).toEqual(globals.sort());
    const slotted = new Set(MASK_TOOL_SLOTS.flat(2));
    for (const id of MASK_OPS) expect(slotted.has(id), id).toBe(false);
  });

  it("resolves each canvas tool to its owning PS slot", () => {
    expect(psSlotOf("brush")?.id).toBe("brush");
    expect(psSlotOf("pencil")?.id).toBe("brush");
    expect(psSlotOf("wand")?.id).toBe("selection");
    expect(psSlotOf("ellipse")?.id).toBe("marquee");
    expect(psSlotOf("invert")).toBeUndefined(); // mask op, not a toolbar tool
  });

  it("every registry tool has a dedicated toolbar glyph", () => {
    for (const t of MASK_TOOLS) expect(hasToolIcon(t.id), t.id).toBe(true);
  });

  it("ships the batch-2 kernel-aligned tools as ready (M14)", () => {
    const expected: Record<string, string> = {
      quick_select: "paint",
      background_eraser: "paint",
      magnetic_lasso: "path",
      sponge: "dodge",
      healing_brush: "heal",
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(maskTool(id)?.status, id).toBe("ready");
      expect(maskTool(id)?.kind, id).toBe(kind);
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
    for (const id of ["brush", "eraser", "rect", "ellipse", "pen", "magnetic_lasso"]) {
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

  it("assigns each PS slot its Photoshop shortcut letter", () => {
    const byId = new Map(PS_TOOL_SECTIONS.flat().map((s) => [s.id, s.shortcut]));
    const expected: Record<string, string> = {
      move: "V", marquee: "M", lasso: "L", selection: "W", crop: "C", sample: "I",
      repair: "J", brush: "B", stamp: "S", history: "Y", eraser: "E", fill: "G", dodge: "O",
      pen: "P", type: "T", path_select: "A", shape: "U",
      hand: "H", rotate_view: "R", zoom: "Z",
    };
    for (const [slot, letter] of Object.entries(expected)) {
      expect(byId.get(slot), slot).toBe(letter);
    }
  });

  it("gives every slot a unique id and shortcut", () => {
    const slots = PS_TOOL_SECTIONS.flat();
    const ids = slots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const shortcuts = slots.map((s) => s.shortcut).filter((s): s is string => s != null);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("every slot with a ready tool stays selectable (some variant is ready)", () => {
    const readySlots = PS_TOOL_SECTIONS.flat().filter((slot) =>
      slot.variants.some((id) => maskTool(id)?.status === "ready"),
    );
    // The pre-refactor toolbar had 15 usable slots; the PS re-slotting must
    // not lose any of them.
    expect(readySlots.length).toBeGreaterThanOrEqual(15);
  });

  it("ships the shape tool as a ready interactive tool (M15)", () => {
    const shape = maskTool("shape");
    expect(shape?.status).toBe("ready");
    expect(shape?.kind).toBe("shape");
    expect(shape?.lane).toBe("interactive");
  });

  it("ships the batch-4 kernel-aligned tools as ready (M16)", () => {
    const expected: Record<string, string> = {
      object_select: "marquee",
      remove: "heal",
      content_aware_move: "heal",
      pattern_stamp: "clone",
      art_history_brush: "history",
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(maskTool(id)?.status, id).toBe("ready");
      expect(maskTool(id)?.kind, id).toBe(kind);
    }
    // The tools with no kernel alignment (font rendering, colour semantics
    // on a grayscale mask) stay planned.
    for (const id of ["type_horizontal", "type_vertical", "color_replacement", "mixer_brush"]) {
      expect(maskTool(id)?.status, id).toBe("planned");
    }
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
