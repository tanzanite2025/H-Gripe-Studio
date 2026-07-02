// W3C compositing-1 blend modes (mirror Rust `blend.rs`).

import type { GradeBlendMode, Rgb } from "./types";

/** `B(Cb, Cs)` per the W3C compositing-1 separable definitions. */
export function blendChannel(mode: GradeBlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "normal":
      return cs;
    case "multiply":
      return cb * cs;
    case "screen":
      return cb + cs - cb * cs;
    case "overlay":
      return blendChannel("hard_light", cs, cb);
    case "darken":
      return Math.min(cb, cs);
    case "lighten":
      return Math.max(cb, cs);
    case "color_dodge":
      if (cb <= 0) return 0;
      if (cs >= 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case "color_burn":
      if (cb >= 1) return 1;
      if (cs <= 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case "hard_light":
      return cs <= 0.5 ? blendChannel("multiply", cb, 2 * cs) : blendChannel("screen", cb, 2 * cs - 1);
    case "soft_light": {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case "difference":
      return Math.abs(cb - cs);
    case "exclusion":
      return cb + cs - 2 * cb * cs;
    case "linear_dodge":
      return Math.min(1, cb + cs);
    case "linear_burn":
      return Math.max(0, cb + cs - 1);
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      throw new Error(`${mode} is non-separable; use blendRgb`);
  }
}

// W3C compositing-1 non-separable helpers (mirror Rust `blend.rs`).
const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const satOf = (c: Rgb) => Math.max(...c) - Math.min(...c);

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb;
  return out;
}

const setLum = (c: Rgb, l: number): Rgb => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};

function setSat(c: Rgb, s: number): Rgb {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = idx;
  const out: Rgb = [0, 0, 0];
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    out[hi] = s;
  }
  return out;
}

/** `B(Cb, Cs)` over the whole RGB triple (mirrors Rust `blend_rgb`). */
export function blendRgb(mode: GradeBlendMode, cb: Rgb, cs: Rgb): Rgb {
  switch (mode) {
    case "hue":
      return setLum(setSat(cs, satOf(cb)), lum(cb));
    case "saturation":
      return setLum(setSat(cb, satOf(cs)), lum(cb));
    case "color":
      return setLum(cs, lum(cb));
    case "luminosity":
      return setLum(cb, lum(cs));
    default:
      return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}
