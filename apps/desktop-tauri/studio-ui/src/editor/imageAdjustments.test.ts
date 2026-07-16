import { describe, expect, it } from "vitest";
import { adjustmentToGradeOps, canLowerAdjustmentToGrade } from "./imageAdjustments";
import { applyOp, isGradeOpType } from "./gradeKernel";
import type { GradeSurface } from "./gradeKernel";
import { adjustmentToneMapper } from "./maskMorphology";
import { type LayerAdjustment } from "../contracts/imageEditorDocument";

// A 256×1 grayscale ramp surface: pixel i holds level i/255 on all channels.
function rampSurface(): GradeSurface {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  return { w: 256, h: 1, data, space: "srgb" };
}

// Exact lowerings must agree with the image executor's direct tone map.
function expectMatchesImageToneMap(adj: LayerAdjustment) {
  const surface = rampSurface();
  for (const op of adjustmentToGradeOps(adj)) applyOp(surface, op);
  const mapValue = adjustmentToneMapper(adj);
  for (let i = 0; i < 256; i++) {
    const got = surface.data[i * 4] * 255;
    const want = mapValue(i);
    expect(Math.abs(got - want), `level ${i}: ${got} vs ${want}`).toBeLessThanOrEqual(0.5 + 1e-3);
  }
}

describe("adjustmentToGradeOps", () => {
  it("rejects operation kinds outside the current grade vocabulary", () => {
    expect(isGradeOpType("levels")).toBe(true);
    expect(isGradeOpType("retired_external_transform")).toBe(false);
  });

  it("levels lowers to the grade levels op with identical shape", () => {
    expectMatchesImageToneMap({ type: "levels", in_black: 20, in_white: 235, gamma: 1.4, out_black: 10, out_white: 245 });
    expectMatchesImageToneMap({ type: "levels" });
  });

  it("keeps tone maps without an exact grade op on the image executor", () => {
    expect(canLowerAdjustmentToGrade({ type: "curve" })).toBe(false);
    expect(canLowerAdjustmentToGrade({ type: "brightness_contrast" })).toBe(false);
    expect(canLowerAdjustmentToGrade({ type: "levels" })).toBe(true);
  });

  it("identity adjustments lower to no ops", () => {
    expect(adjustmentToGradeOps({ type: "curve" })).toEqual([]);
    expect(adjustmentToGradeOps({ type: "brightness_contrast" })).toEqual([]);
    expect(adjustmentToGradeOps({ type: "color_ranges" })).toEqual([]);
    expect(adjustmentToGradeOps({ type: "color_ranges", ranges: [{ range: "reds" }] })).toEqual([]);
    expect(adjustmentToGradeOps({ type: "channel_mixer" })).toEqual([]);
    expect(
      adjustmentToGradeOps({ type: "channel_mixer", red: [100, 0, 0], green: [0, 100, 0], blue: [0, 0, 100] }),
    ).toEqual([]);
  });

  it("color_ranges lowers UI units (degrees / percent) to the grade op", () => {
    expect(
      adjustmentToGradeOps({
        type: "color_ranges",
        ranges: [
          { range: "reds", hue: 30, saturation: -50 },
          { range: "blues", lightness: 20 },
        ],
        monochrome: false,
      }),
    ).toEqual([
      {
        type: "color_ranges",
        ranges: [
          { range: "reds", hue: 30, saturation: -0.5, lightness: 0 },
          { range: "blues", hue: 0, saturation: 0, lightness: 0.2 },
        ],
        monochrome: false,
      },
    ]);
    expect(adjustmentToGradeOps({ type: "color_ranges", monochrome: true })).toEqual([
      { type: "color_ranges", ranges: [], monochrome: true },
    ]);
  });

  it("replace_color lowers hex colors and percents to the grade op", () => {
    expect(
      adjustmentToGradeOps({
        type: "replace_color",
        from_color: "#ff0000",
        to_color: "#0000ff",
        fuzziness: 40,
        strength: 50,
      }),
    ).toEqual([
      {
        type: "replace_color",
        from: [1, 0, 0],
        to: [0, 0, 1],
        fuzziness: 0.4,
        amount: 0.5,
      },
    ]);
    // Identity until both colours are picked or when strength is zero.
    expect(adjustmentToGradeOps({ type: "replace_color" })).toEqual([]);
    expect(adjustmentToGradeOps({ type: "replace_color", from_color: "#ff0000" })).toEqual([]);
    expect(
      adjustmentToGradeOps({ type: "replace_color", from_color: "#ff0000", to_color: "#0000ff", strength: 0 }),
    ).toEqual([]);
    expect(
      adjustmentToGradeOps({ type: "replace_color", from_color: "bogus", to_color: "#0000ff" }),
    ).toEqual([]);
  });

  it("channel_mixer lowers percent weights to the rgb_mixer op", () => {
    expect(
      adjustmentToGradeOps({ type: "channel_mixer", red: [50, 50, 0] }),
    ).toEqual([
      {
        type: "rgb_mixer",
        red: [0.5, 0.5, 0],
        green: [0, 1, 0],
        blue: [0, 0, 1],
        monochrome: false,
      },
    ]);
  });
});
