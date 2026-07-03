// The grading operations (mirror Rust `ops/mod.rs`): the `GradeOp` union
// and `applyOp` dispatch, plus the per-pixel traversal helpers.

import { hslToRgb, rgbToHsl } from "./hsl";
import { lut1dSample, lut3dSample } from "./lut";
import { denoise, filmGrain, gaussianBlur, sharpen, vignette } from "./spatial";
import { monotoneSpline, multiplierSpline, periodicSpline } from "./spline";
import { trcDecode, trcEncode } from "./trc";
import { clamp01, LUMA, smoothstep, type GradeSurface, type Rgb } from "./types";
import { planckianGains } from "./wb";

export type CurveChannel = "master" | "red" | "green" | "blue";

export type GradeOp =
  | { type: "exposure"; ev: number }
  | { type: "white_balance"; temp: number; tint: number }
  | { type: "levels"; in_black: number; in_white: number; gamma: number; out_black: number; out_white: number }
  | { type: "curves"; channel: CurveChannel; points: [number, number][] }
  | { type: "saturation"; amount: number }
  | { type: "lift_gamma_gain"; lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] }
  | { type: "hsl_adjust"; hue: number; saturation: number; lightness: number }
  | { type: "lut3d"; size: number; table: number[] }
  | { type: "lut1d"; size: number; table: number[] }
  | { type: "hue_vs_hue"; points: [number, number][] }
  | { type: "hue_vs_sat"; points: [number, number][] }
  | { type: "lum_vs_sat"; points: [number, number][] }
  | { type: "sat_vs_sat"; points: [number, number][] }
  | {
      type: "log_wheels";
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
      low_pivot: number;
      high_pivot: number;
    }
  | { type: "contrast"; amount: number; pivot: number }
  | { type: "soft_clip"; high_start: number; low_start: number }
  | { type: "white_balance_k"; temp_k: number; tint: number }
  | {
      type: "rgb_mixer";
      red: [number, number, number];
      green: [number, number, number];
      blue: [number, number, number];
      monochrome: boolean;
    }
  | { type: "color_warper"; points: WarpPoint[] }
  | { type: "sharpen"; amount: number; radius?: number }
  | { type: "denoise"; amount: number; radius?: number }
  | { type: "film_grain"; amount: number; seed: number }
  | { type: "blur"; sigma: number }
  | { type: "vignette"; amount: number; midpoint?: number; feather?: number };

/** One colour-warper control point (mirrors Rust `WarpPoint`). */
export interface WarpPoint {
  hue: number;
  sat: number;
  hue_shift: number;
  sat_scale: number;
  hue_radius: number;
  sat_radius: number;
}

/**
 * Whether the op reads beyond the pixel being written — neighbouring pixels
 * (sharpen / denoise) or the pixel's frame position (film grain), so it is
 * only correct over a full frame (mirrors Rust `GradeOp::is_spatial`).
 */
export function isSpatialOp(op: GradeOp): boolean {
  return (
    op.type === "sharpen" ||
    op.type === "denoise" ||
    op.type === "film_grain" ||
    op.type === "blur" ||
    op.type === "vignette"
  );
}

// Decode RGB to linear light, run `f`, re-encode (alpha untouched). The
// scene-referred linear space passes values through unclamped and unbounded.
function forEachRgbLinear(surface: GradeSurface, f: (rgb: [number, number, number]) => void): void {
  const n = surface.w * surface.h;
  const load = surface.space === "linear_rec709" ? (v: number) => v : clamp01;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const rgb: [number, number, number] = [
      trcDecode(surface.space, load(surface.data[i])),
      trcDecode(surface.space, load(surface.data[i + 1])),
      trcDecode(surface.space, load(surface.data[i + 2])),
    ];
    f(rgb);
    surface.data[i] = trcEncode(surface.space, rgb[0]);
    surface.data[i + 1] = trcEncode(surface.space, rgb[1]);
    surface.data[i + 2] = trcEncode(surface.space, rgb[2]);
  }
}

// Convert each pixel to HSL, map it, convert back (alpha untouched).
function forEachHsl(surface: GradeSurface, f: (h: number, s: number, l: number) => [number, number, number]): void {
  const n = surface.w * surface.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const [h, s, l] = rgbToHsl([clamp01(surface.data[i]), clamp01(surface.data[i + 1]), clamp01(surface.data[i + 2])]);
    const out = hslToRgb(...f(h, s, l));
    surface.data[i] = out[0];
    surface.data[i + 1] = out[1];
    surface.data[i + 2] = out[2];
  }
}

// Soft clip in linear light: asymptotic roll-off toward 1 above `hs` and
// toward 0 below `ls` (mirrors Rust `soft_clip`).
function softClip(v: number, hs: number, ls: number): number {
  if (v > hs) {
    const t = (v - hs) / (1 - hs);
    return hs + ((1 - hs) * t) / (1 + t);
  }
  if (v < ls) {
    if (ls <= 0) return 0;
    const t = (ls - v) / ls;
    return ls - (ls * t) / (1 + t);
  }
  return v;
}

/** Apply one grading op to every pixel's RGB (mirrors Rust `apply_op`). */
export function applyOp(surface: GradeSurface, op: GradeOp): void {
  const n = surface.w * surface.h;
  switch (op.type) {
    case "exposure": {
      const gain = Math.pow(2, op.ev);
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] *= gain;
      });
      break;
    }
    case "white_balance": {
      const gains = [Math.pow(2, op.temp), Math.pow(2, op.tint), Math.pow(2, -op.temp)];
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] *= gains[c];
      });
      break;
    }
    case "levels": {
      const span = Math.max(op.in_white - op.in_black, 1e-6);
      const invGamma = 1 / Math.max(op.gamma, 1e-6);
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01((clamp01(surface.data[i + c]) - op.in_black) / span);
          surface.data[i + c] = op.out_black + (op.out_white - op.out_black) * Math.pow(v, invGamma);
        }
      }
      break;
    }
    case "curves": {
      const spline = monotoneSpline(op.points);
      const channels = op.channel === "master" ? [0, 1, 2] : [{ red: 0, green: 1, blue: 2 }[op.channel]];
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (const c of channels) surface.data[i + c] = spline(clamp01(surface.data[i + c]));
      }
      break;
    }
    case "saturation": {
      const k = 1 + op.amount;
      forEachRgbLinear(surface, (rgb) => {
        const luma = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
        for (let c = 0; c < 3; c++) rgb[c] = luma + (rgb[c] - luma) * k;
      });
      break;
    }
    case "lift_gamma_gain": {
      const invGamma = op.gamma.map((g) => 1 / Math.max(g, 1e-6));
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) {
          const v = Math.max((rgb[c] + op.lift[c] * (1 - rgb[c])) * op.gain[c], 0);
          rgb[c] = Math.pow(v, invGamma[c]);
        }
      });
      break;
    }
    case "hsl_adjust": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        const [h, s, l] = rgbToHsl([
          clamp01(surface.data[i]),
          clamp01(surface.data[i + 1]),
          clamp01(surface.data[i + 2]),
        ]);
        const out = hslToRgb(
          (((h + op.hue) % 360) + 360) % 360,
          clamp01(s * (1 + op.saturation)),
          clamp01(l * (1 + op.lightness)),
        );
        surface.data[i] = out[0];
        surface.data[i + 1] = out[1];
        surface.data[i + 2] = out[2];
      }
      break;
    }
    case "hue_vs_hue": {
      const curve = periodicSpline(op.points, 0);
      forEachHsl(surface, (h, s, l) => [(((h + curve(h)) % 360) + 360) % 360, s, l]);
      break;
    }
    case "hue_vs_sat": {
      const curve = periodicSpline(op.points, 1);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(h)), l]);
      break;
    }
    case "lum_vs_sat": {
      const curve = multiplierSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(l)), l]);
      break;
    }
    case "sat_vs_sat": {
      const curve = multiplierSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(s)), l]);
      break;
    }
    case "log_wheels": {
      const low = Math.max(op.low_pivot, 1e-6);
      const highSpan = Math.max(1 - op.high_pivot, 1e-6);
      const zones = [op.shadows, op.midtones, op.highlights];
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01(surface.data[i + c]);
          const ws = 1 - smoothstep(v / low);
          const wh = smoothstep((v - op.high_pivot) / highSpan);
          const wm = Math.max(1 - ws - wh, 0);
          surface.data[i + c] = clamp01(v + ws * zones[0][c] + wm * zones[1][c] + wh * zones[2][c]);
        }
      }
      break;
    }
    case "contrast": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01(surface.data[i + c]);
          surface.data[i + c] = clamp01(op.pivot + (v - op.pivot) * op.amount);
        }
      }
      break;
    }
    case "lut1d": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          surface.data[i + c] = lut1dSample(op.size, op.table, c, clamp01(surface.data[i + c]));
        }
      }
      break;
    }
    case "lut3d": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        const out = lut3dSample(op.size, op.table, [
          clamp01(surface.data[i]),
          clamp01(surface.data[i + 1]),
          clamp01(surface.data[i + 2]),
        ]);
        surface.data[i] = out[0];
        surface.data[i + 1] = out[1];
        surface.data[i + 2] = out[2];
      }
      break;
    }
    case "soft_clip": {
      const hs = Math.min(Math.max(op.high_start, 0), 1 - 1e-4);
      const ls = Math.min(Math.max(op.low_start, 0), hs);
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] = softClip(rgb[c], hs, ls);
      });
      break;
    }
    case "white_balance_k": {
      const gains = planckianGains(op.temp_k, op.tint);
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] *= gains[c];
      });
      break;
    }
    case "rgb_mixer": {
      const sane = (w: [number, number, number]): Rgb => w.map((v) => (Number.isFinite(v) ? v : 0)) as Rgb;
      const rows: [Rgb, Rgb, Rgb] = op.monochrome
        ? [sane(op.red), sane(op.red), sane(op.red)]
        : [sane(op.red), sane(op.green), sane(op.blue)];
      forEachRgbLinear(surface, (rgb) => {
        const src: Rgb = [rgb[0], rgb[1], rgb[2]];
        for (let c = 0; c < 3; c++) {
          rgb[c] = rows[c][0] * src[0] + rows[c][1] * src[1] + rows[c][2] * src[2];
        }
      });
      break;
    }
    case "color_warper": {
      const points = op.points.filter((p) =>
        [p.hue, p.sat, p.hue_shift, p.sat_scale, p.hue_radius, p.sat_radius].every((v) => Number.isFinite(v)),
      );
      forEachHsl(surface, (h, s, l) => {
        let hueShift = 0;
        let satFactor = 1;
        for (const p of points) {
          const dRaw = (((h - p.hue) % 360) + 360) % 360;
          const dh = Math.min(dRaw, 360 - dRaw);
          const ds = s - clamp01(p.sat);
          const d = Math.sqrt(
            (dh / Math.max(p.hue_radius, 1e-3)) ** 2 + (ds / Math.max(p.sat_radius, 1e-3)) ** 2,
          );
          const w = smoothstep(1 - d);
          hueShift += w * p.hue_shift;
          satFactor *= 1 + w * (p.sat_scale - 1);
        }
        return [(((h + hueShift) % 360) + 360) % 360, clamp01(s * Math.max(satFactor, 0)), l];
      });
      break;
    }
    case "sharpen":
      sharpen(surface, op.amount, op.radius ?? 1);
      break;
    case "denoise":
      denoise(surface, op.amount, op.radius ?? 1);
      break;
    case "film_grain":
      filmGrain(surface, op.amount, op.seed);
      break;
    case "blur":
      gaussianBlur(surface, op.sigma);
      break;
    case "vignette":
      vignette(surface, op.amount, op.midpoint ?? 0.5, op.feather ?? 0.5);
      break;
  }
}
