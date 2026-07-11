import { describe, expect, it } from "vitest";
import {
  GRADE_OPS,
  IMAGE_EDITOR_ADJUSTMENTS,
  IMAGE_EDIT_OPS,
  IMAGE_EDIT_OP_TYPES,
  gradeOpMeta,
  imageEditOpMeta,
} from "./opRegistry";
import { type EditOp } from "../contracts/imageEditOps";

describe("opRegistry", () => {
  it("image edit op types are unique and all registered with their kernel", () => {
    expect(new Set(IMAGE_EDIT_OP_TYPES).size).toBe(IMAGE_EDIT_OP_TYPES.length);
    for (const type of IMAGE_EDIT_OP_TYPES) {
      const kernel = type === "source_image" ? "raster" : "mask";
      expect(IMAGE_EDIT_OPS[type]).toEqual({ kernel, adjustment: false });
    }
  });

  it("looks up recorded image edit ops, rejecting unknown kinds", () => {
    const brush = { type: "brush", points: [], size: 10, mode: "add" } as unknown as EditOp;
    expect(imageEditOpMeta(brush)?.kernel).toBe("mask");
    const feather = { type: "feather", amount: 3 } as EditOp;
    expect(imageEditOpMeta(feather)?.kernel).toBe("mask");
    expect(imageEditOpMeta({ type: "source_image" } as EditOp)?.kernel).toBe("raster");
    const bogus = { type: "not_an_op" } as EditOp;
    expect(imageEditOpMeta(bogus)).toBeNull();
  });

  it("adjustment layers are parameter-only; tone maps on the mask kernel, colour on grade", () => {
    for (const [type, meta] of Object.entries(IMAGE_EDITOR_ADJUSTMENTS)) {
      const kernel =
        type === "color_ranges" || type === "channel_mixer" || type === "replace_color"
          ? "grade"
          : "mask";
      expect(meta, type).toEqual({ kernel, adjustment: true });
    }
  });

  it("every grade op is a shared adjustment in the grade kernel", () => {
    for (const [type, meta] of Object.entries(GRADE_OPS)) {
      expect(meta, type).toEqual({ kernel: "grade", adjustment: true });
    }
    expect(gradeOpMeta({ type: "exposure", ev: 1 })).toEqual({ kernel: "grade", adjustment: true });
  });

  it("mask and grade vocabularies only overlap on levels and color_ranges", () => {
    const overlap = IMAGE_EDIT_OP_TYPES.filter((t) => t in GRADE_OPS);
    expect(overlap).toEqual([]);
    const adjOverlap = Object.keys(IMAGE_EDITOR_ADJUSTMENTS).filter((t) => t in GRADE_OPS);
    expect(adjOverlap).toEqual(["levels", "color_ranges", "replace_color"]);
  });
});
