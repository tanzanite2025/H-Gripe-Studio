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
// The image-workspace colour adjustments (`color_ranges`, `channel_mixer`,
// `replace_color`) have no u8 counterpart — they lower straight to their
// grade ops (`color_ranges`, `rgb_mixer`, `replace_color`), converting UI
// units (hex colours / degrees / percent) to op units.
//
// `imageAdjustments.test.ts` asserts each tone-map lowering agrees with
// `adjustmentLut` within u8 rounding at all 256 levels.

import type { GradeOp } from "./gradeKernel";
import { type LayerAdjustment } from "../contracts/maskDocument";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Parse `#rrggbb` to 0..1 RGB; null when malformed. */
function hexToRgb01(hex: string | undefined): [number, number, number] | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

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
  if (adj.type === "color_ranges") {
    const ranges = (adj.ranges ?? [])
      .map((r) => ({
        range: r.range,
        hue: r.hue ?? 0,
        saturation: (r.saturation ?? 0) / 100,
        lightness: (r.lightness ?? 0) / 100,
      }))
      .filter((r) => r.hue !== 0 || r.saturation !== 0 || r.lightness !== 0);
    if (ranges.length === 0 && !adj.monochrome) return [];
    return [{ type: "color_ranges", ranges, monochrome: adj.monochrome ?? false }];
  }
  if (adj.type === "channel_mixer") {
    const row = (w: [number, number, number] | undefined, dflt: [number, number, number]) =>
      (w ?? dflt).map((v) => v / 100) as [number, number, number];
    const red = row(adj.red, [100, 0, 0]);
    const green = row(adj.green, [0, 100, 0]);
    const blue = row(adj.blue, [0, 0, 100]);
    const identity =
      !adj.monochrome &&
      red.join() === "1,0,0" &&
      green.join() === "0,1,0" &&
      blue.join() === "0,0,1";
    if (identity) return [];
    return [{ type: "rgb_mixer", red, green, blue, monochrome: adj.monochrome ?? false }];
  }
  if (adj.type === "replace_color") {
    const from = hexToRgb01(adj.from_color);
    const to = hexToRgb01(adj.to_color);
    const amount = clamp(adj.strength ?? 100, 0, 100) / 100;
    if (!from || !to || amount === 0) return [];
    return [
      {
        type: "replace_color",
        from,
        to,
        fuzziness: clamp(adj.fuzziness ?? 40, 0, 100) / 100,
        amount,
      },
    ];
  }
  // brightness_contrast: scale about the midpoint, then shift.
  const brightness = clamp(adj.brightness ?? 0, -100, 100) / 100;
  const slope = 1 + clamp(adj.contrast ?? 0, -100, 100) / 100;
  if (brightness === 0 && slope === 1) return [];
  return [lut1dOf((v01) => (v01 - 0.5) * slope + 0.5 + brightness)];
}
