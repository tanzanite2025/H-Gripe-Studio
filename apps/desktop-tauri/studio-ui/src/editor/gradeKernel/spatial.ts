// Spatial ops (mirror Rust `ops/spatial.rs`): sharpen / denoise read
// neighbouring pixels, film grain reads the pixel's frame position — so
// they are only correct over a full frame. All three work on the encoded
// signal, clamped to `0..=1`.

import { clamp01, type GradeSurface } from "./types";

// 3×3 neighbourhood of (x, y) with coordinates clamped to the frame edges,
// yielding the pixel index of each tap.
function taps3x3(x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ty = Math.min(Math.max(y + dy, 0), h - 1);
      const tx = Math.min(Math.max(x + dx, 0), w - 1);
      out.push(ty * w + tx);
    }
  }
  return out;
}

// Unsharp mask on encoded values: `out = v + amount × (v − blur3×3(v))`,
// clamped to `0..=1` (mirrors Rust `sharpen`).
export function sharpen(surface: GradeSurface, amount: number): void {
  const a = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 10) : 0;
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  const src = Float32Array.from(surface.data, clamp01);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const taps = taps3x3(x, y, w, h);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const t of taps) sum += src[t * 4 + c];
        const blur = Math.fround(sum / 9);
        const v = src[i + c];
        surface.data[i + c] = clamp01(v + a * (v - blur));
      }
    }
  }
}

// Binomial 3×3 spatial weights (1-2-1 ⊗ 1-2-1), row-major like `taps3x3`.
const BILATERAL_SPATIAL = [1, 2, 1, 2, 4, 2, 1, 2, 1];

// Edge-preserving 3×3 bilateral denoise on encoded values, per channel
// (mirrors Rust `denoise`; σ = 0.1 range Gaussian × binomial spatial kernel).
export function denoise(surface: GradeSurface, amount: number): void {
  const a = Number.isFinite(amount) ? clamp01(amount) : 0;
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  const SIGMA = 0.1;
  const src = Float32Array.from(surface.data, clamp01);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const taps = taps3x3(x, y, w, h);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        let sum = 0;
        let weight = 0;
        for (let k = 0; k < 9; k++) {
          const u = src[taps[k] * 4 + c];
          const d = (u - v) / SIGMA;
          const wgt = BILATERAL_SPATIAL[k] * Math.exp(-d * d);
          sum += wgt * u;
          weight += wgt;
        }
        const filtered = sum / weight;
        surface.data[i + c] = clamp01(v + a * (filtered - v));
      }
    }
  }
}

// Integer position hash (lowbias32-style avalanche over x, y and the seed):
// pure 32-bit integer maths, bit-identical to Rust `grain_hash`.
export function grainHash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

// Monochrome film grain on encoded values: deterministic per-pixel noise in
// [-1, 1) from `grainHash(x, y, seed)`, scaled by `amount` and added to all
// three channels (mirrors Rust `film_grain`).
export function filmGrain(surface: GradeSurface, amount: number, seed: number): void {
  const a = Number.isFinite(amount) ? clamp01(amount) : 0;
  const { w, h } = surface;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const noise = Math.fround((grainHash(x, y, seed) / 4294967296) * 2 - 1);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = clamp01(surface.data[i + c]);
        surface.data[i + c] = clamp01(v + a * noise);
      }
    }
  }
}
