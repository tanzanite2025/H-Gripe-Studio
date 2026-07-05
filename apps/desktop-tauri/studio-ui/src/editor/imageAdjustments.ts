// Mask-adjustment → grade-op lowering (image-kernel K2,
// docs/design/image-kernel.md §4).
//
// A bridged adjustment layer carries the mask editor's u8 tone map
// (`LayerAdjustment`). Rendering the image workspace through the grade
// kernel needs that tone map expressed as `GradeOp`s. The lowering keeps
// the u8 semantics on the f32 core:
//
// - `levels` maps parameter-for-parameter (both kernels use the same
//   input-span / inverse-gamma / output-span formula on encoded values;
//   only the 0..255 → 0..1 scale changes).
// - `curve` (piecewise-linear, 0..255 control points) and
//   `brightness_contrast` become a 256-entry `lut1d`: the grade kernel's
//   1D LUT interpolates linearly between samples, so a 256-sample table
//   reproduces the mask LUT exactly at every u8 level — unlike `curves`
//   (monotone spline) or `contrast` (pivot scale without the brightness
//   shift), which would change the shape.
//
// `imageAdjustments.test.ts` asserts each lowering agrees with
// `adjustmentLut` within u8 rounding at all 256 levels.

import type { GradeOp } from "./gradeKernel";
import type { LayerAdjustment } from "../types/production";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** A 256-sample grayscale `lut1d` op from a per-level transfer function. */
function lut1dOf(f: (v01: number) => number): GradeOp {
  const size = 256;
  const table: number[] = new Array(size * 3);
  for (let i = 0; i < size; i++) {
    const y = clamp(f(i / (size - 1)), 0, 1);
    table[i * 3] = y;
    table[i * 3 + 1] = y;
    table[i * 3 + 2] = y;
  }
  return { type: "lut1d", size, table };
}

/**
 * Lower one mask adjustment layer's tone map to the grade ops that
 * reproduce it on the f32 kernel.
 */
export function adjustmentToGradeOps(adj: LayerAdjustment): GradeOp[] {
  if (adj.type === "levels") {
    return [
      {
        type: "levels",
        in_black: clamp(adj.in_black ?? 0, 0, 255) / 255,
        in_white: clamp(adj.in_white ?? 255, 0, 255) / 255,
        gamma: Math.max(adj.gamma ?? 1, 1e-6),
        out_black: clamp(adj.out_black ?? 0, 0, 255) / 255,
        out_white: clamp(adj.out_white ?? 255, 0, 255) / 255,
      },
    ];
  }
  if (adj.type === "curve") {
    const pts = [...(adj.points ?? [])]
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return [];
    return [
      lut1dOf((v01) => {
        const v = v01 * 255;
        if (v <= pts[0][0]) return clamp(pts[0][1], 0, 255) / 255;
        if (v >= pts[pts.length - 1][0]) return clamp(pts[pts.length - 1][1], 0, 255) / 255;
        let i = 1;
        while (pts[i][0] < v) i++;
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const t = (v - x0) / Math.max(x1 - x0, 1e-6);
        return clamp(y0 + t * (y1 - y0), 0, 255) / 255;
      }),
    ];
  }
  // brightness_contrast: scale about the midpoint, then shift.
  const brightness = clamp(adj.brightness ?? 0, -100, 100) / 100;
  const slope = 1 + clamp(adj.contrast ?? 0, -100, 100) / 100;
  if (brightness === 0 && slope === 1) return [];
  return [lut1dOf((v01) => (v01 - 0.5) * slope + 0.5 + brightness)];
}
