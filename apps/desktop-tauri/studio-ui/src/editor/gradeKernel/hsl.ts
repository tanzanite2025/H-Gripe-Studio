// RGB ↔ HSL conversion (mirror Rust `ops/hsl.rs`).

import type { Rgb } from "./types";

/** RGB (`0..=1`) → HSL with hue in degrees (mirrors Rust `rgb_to_hsl`). */
export function rgbToHsl(rgb: Rgb): [number, number, number] {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d <= 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rgb[0]) h = 60 * ((((rgb[1] - rgb[2]) / d) % 6 + 6) % 6);
  else if (max === rgb[1]) h = 60 * ((rgb[2] - rgb[0]) / d + 2);
  else h = 60 * ((rgb[0] - rgb[1]) / d + 4);
  return [h, s, l];
}

/** HSL (hue in degrees) → RGB (mirrors Rust `hsl_to_rgb`). */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs(((hp % 2) + 2) % 2 - 1));
  const seg = Math.min(Math.floor(hp), 5);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}
