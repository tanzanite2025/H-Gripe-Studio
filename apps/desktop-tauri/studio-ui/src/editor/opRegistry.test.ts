import { describe, expect, it } from "vitest";
import {
  GRADE_OPS,
  MASK_ADJUSTMENTS,
  MASK_OPS,
  MASK_OP_TYPES,
  gradeOpMeta,
  maskOpMeta,
} from "./opRegistry";
import type { EditOp } from "../types/production";

describe("opRegistry", () => {
  it("mask op types are unique and all registered in the mask kernel", () => {
    expect(new Set(MASK_OP_TYPES).size).toBe(MASK_OP_TYPES.length);
    for (const type of MASK_OP_TYPES) {
      expect(MASK_OPS[type]).toEqual({ kernel: "mask", adjustment: false });
    }
  });

  it("looks up recorded mask-document ops, rejecting unknown kinds", () => {
    const brush = { type: "brush", points: [], size: 10, mode: "add" } as unknown as EditOp;
    expect(maskOpMeta(brush)?.kernel).toBe("mask");
    const feather = { type: "feather", amount: 3 } as EditOp;
    expect(maskOpMeta(feather)?.kernel).toBe("mask");
    const bogus = { type: "not_an_op" } as EditOp;
    expect(maskOpMeta(bogus)).toBeNull();
  });

  it("adjustment layers are parameter-only; tone maps on the mask kernel, colour on grade", () => {
    for (const [type, meta] of Object.entries(MASK_ADJUSTMENTS)) {
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
    const overlap = MASK_OP_TYPES.filter((t) => t in GRADE_OPS);
    expect(overlap).toEqual([]);
    const adjOverlap = Object.keys(MASK_ADJUSTMENTS).filter((t) => t in GRADE_OPS);
    expect(adjOverlap).toEqual(["levels", "color_ranges", "replace_color"]);
  });
});
