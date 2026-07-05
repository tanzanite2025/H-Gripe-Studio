import { describe, expect, it } from "vitest";
import { adjustmentToGradeOps } from "./imageAdjustments";
import { applyOp } from "./gradeKernel";
import type { GradeSurface } from "./gradeKernel";
import { adjustmentLut } from "./maskMorphology";
import type { LayerAdjustment } from "../types/production";

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

// The lowering must agree with the mask editor's u8 LUT at every level,
// within the LUT's own rounding (±0.5 of a u8 step).
function expectMatchesMaskLut(adj: LayerAdjustment) {
  const surface = rampSurface();
  for (const op of adjustmentToGradeOps(adj)) applyOp(surface, op);
  const lut = adjustmentLut(adj);
  for (let i = 0; i < 256; i++) {
    const got = surface.data[i * 4] * 255;
    expect(Math.abs(got - lut[i]), `level ${i}: ${got} vs ${lut[i]}`).toBeLessThanOrEqual(0.5 + 1e-3);
  }
}

describe("adjustmentToGradeOps", () => {
  it("levels lowers to the grade levels op with identical shape", () => {
    expectMatchesMaskLut({ type: "levels", in_black: 20, in_white: 235, gamma: 1.4, out_black: 10, out_white: 245 });
    expectMatchesMaskLut({ type: "levels" });
  });

  it("curve lowers to a 256-entry lut1d matching the piecewise-linear LUT", () => {
    expectMatchesMaskLut({
      type: "curve",
      points: [
        [0, 30],
        [64, 40],
        [128, 200],
        [255, 250],
      ],
    });
  });

  it("brightness_contrast lowers to a lut1d matching the midpoint formula", () => {
    expectMatchesMaskLut({ type: "brightness_contrast", brightness: 25, contrast: -40 });
    expectMatchesMaskLut({ type: "brightness_contrast", brightness: -60, contrast: 80 });
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
