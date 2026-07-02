// Planckian-locus white balance maths (mirror Rust `ops/wb.rs`).

import { LUMA, type Rgb } from "./types";

// Planckian-locus white balance gains (Kim et al. CCT→xy fit,
// xy→XYZ→Rec.709, relative to the 6504 K neutral, luma-normalised;
// mirrors Rust `planckian_gains`).
export function planckianGains(tempK: number, tint: number): Rgb {
  const ref = planckianRgb(6504, 0);
  const target = planckianRgb(tempK, tint);
  const raw: Rgb = [target[0] / ref[0], target[1] / ref[1], target[2] / ref[2]];
  const luma = LUMA[0] * raw[0] + LUMA[1] * raw[1] + LUMA[2] * raw[2];
  return [raw[0] / luma, raw[1] / luma, raw[2] / luma];
}

function planckianRgb(tempK: number, tint: number): Rgb {
  const t = Number.isFinite(tempK) ? Math.min(Math.max(tempK, 1667), 25000) : 6504;
  const x =
    t <= 4000
      ? -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039;
  const yLocus =
    t <= 2222
      ? ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683
      : t <= 4000
        ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
        : ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  const tt = Number.isFinite(tint) ? Math.min(Math.max(tint, -1), 1) : 0;
  const y = Math.max(yLocus + 0.05 * tt, 1e-4);
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  const r = 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ;
  const g = -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ;
  const b = 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ;
  return [Math.max(r, 1e-4), Math.max(g, 1e-4), Math.max(b, 1e-4)];
}
