// Spatial ops (mirror Rust `ops/spatial.rs`): sharpen / denoise read
// neighbouring pixels, film grain reads the pixel's frame position — so
// they are only correct over a full frame. All three work on the encoded
// signal, clamped to `0..=1`.

import { clamp01, smoothstep, type GradeSurface } from "./types";

/** Largest supported kernel radius (7×7); radii clamp to `1..=MAX_RADIUS`. */
export const MAX_RADIUS = 3;

function clampRadius(radius: number): number {
  return Number.isFinite(radius) ? Math.min(Math.max(Math.trunc(radius), 1), MAX_RADIUS) : 1;
}

// (2r+1)×(2r+1) neighbourhood of (x, y) with coordinates clamped to the
// frame edges, yielding the pixel index of each tap in row-major order.
function taps(x: number, y: number, w: number, h: number, r: number): number[] {
  const out: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const ty = Math.min(Math.max(y + dy, 0), h - 1);
      const tx = Math.min(Math.max(x + dx, 0), w - 1);
      out.push(ty * w + tx);
    }
  }
  return out;
}

// C(n, k) — the binomial spatial weights for the bilateral kernel (row 2r
// of Pascal's triangle; 1-2-1 at radius 1, 1-4-6-4-1 at radius 2). Mirrors
// Rust `binomial`.
function binomial(n: number, k: number): number {
  let out = 1;
  for (let j = 0; j < k; j++) out = (out * (n - j)) / (j + 1);
  return Math.fround(out);
}

// Unsharp mask on encoded values: `out = v + amount × (v − blur(v))` with a
// (2×radius+1)² box-mean blur, clamped to `0..=1` (mirrors Rust `sharpen`;
// radius clamps to `1..=3`).
export function sharpen(surface: GradeSurface, amount: number, radius = 1): void {
  const a = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 10) : 0;
  const r = clampRadius(radius);
  const count = (2 * r + 1) * (2 * r + 1);
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  const src = Float32Array.from(surface.data, clamp01);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ts = taps(x, y, w, h, r);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const t of ts) sum += src[t * 4 + c];
        const blur = Math.fround(sum / count);
        const v = src[i + c];
        surface.data[i + c] = clamp01(v + a * (v - blur));
      }
    }
  }
}

// Edge-preserving bilateral denoise on encoded values, per channel, over
// the (2×radius+1)² neighbourhood (mirrors Rust `denoise`; σ = 0.1 range
// Gaussian × binomial spatial kernel, radius clamps to `1..=3`).
export function denoise(surface: GradeSurface, amount: number, radius = 1): void {
  const a = Number.isFinite(amount) ? clamp01(amount) : 0;
  const r = clampRadius(radius);
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  const SIGMA = 0.1;
  const spatial: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      spatial.push(binomial(2 * r, r + dx) * binomial(2 * r, r + dy));
    }
  }
  const src = Float32Array.from(surface.data, clamp01);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ts = taps(x, y, w, h, r);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        let sum = 0;
        let weight = 0;
        for (let k = 0; k < ts.length; k++) {
          const u = src[ts[k] * 4 + c];
          const d = (u - v) / SIGMA;
          const wgt = spatial[k] * Math.exp(-d * d);
          sum += wgt * u;
          weight += wgt;
        }
        const filtered = sum / weight;
        surface.data[i + c] = clamp01(v + a * (filtered - v));
      }
    }
  }
}

/**
 * Largest supported Gaussian blur sigma, in pixels; sigmas clamp to
 * `0..=MAX_BLUR_SIGMA` and the kernel radius is `ceil(3σ)`.
 */
export const MAX_BLUR_SIGMA = 32;

// The separable Gaussian kernel for `sigma`: `[radius, weights]` with
// weights normalised (computed in f64, rounded to f32 — mirrors Rust
// `gaussian_weights`), or null when the clamped sigma rounds to radius 0.
function gaussianWeights(sigma: number): [number, Float32Array] | null {
  const s = Number.isFinite(sigma) ? Math.min(Math.max(sigma, 0), MAX_BLUR_SIGMA) : 0;
  const r = Math.ceil(3 * s);
  if (r === 0) return null;
  const s2 = 2 * s * s;
  const raw: number[] = [];
  for (let k = -r; k <= r; k++) raw.push(Math.exp(-(k * k) / s2));
  const sum = raw.reduce((acc, w) => acc + w, 0);
  return [r, Float32Array.from(raw, (w) => w / sum)];
}

// Separable large-radius Gaussian blur on encoded values: two 1D passes
// (horizontal, then vertical) over the normalised kernel with edge-clamped
// taps (mirrors Rust `gaussian_blur`; sigma clamps to `0..=32`, neutral 0).
export function gaussianBlur(surface: GradeSurface, sigma: number): void {
  const kernel = gaussianWeights(sigma);
  if (!kernel) return;
  const [r, weights] = kernel;
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  const src = Float32Array.from(surface.data, clamp01);
  const tmp = Float32Array.from(src);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
          const tx = Math.min(Math.max(x + k - r, 0), w - 1);
          sum = Math.fround(sum + Math.fround(weights[k] * src[(y * w + tx) * 4 + c]));
        }
        tmp[i + c] = sum;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
          const ty = Math.min(Math.max(y + k - r, 0), h - 1);
          sum = Math.fround(sum + Math.fround(weights[k] * tmp[(ty * w + x) * 4 + c]));
        }
        surface.data[i + c] = clamp01(sum);
      }
    }
  }
}

// Parametric vignette on encoded values: a radial gain over the frame's
// centred ellipse — with the corner distance normalised to 1, each channel
// scales by `1 + amount × smoothstep((d − midpoint) / feather)`, clamped
// (mirrors Rust `vignette`; amount clamps to `−1..=1`, midpoint to `0..=1`,
// feather to `1e-3..=1`).
export function vignette(surface: GradeSurface, amount: number, midpoint: number, feather: number): void {
  const a = Number.isFinite(amount) ? Math.min(Math.max(amount, -1), 1) : 0;
  const m = Number.isFinite(midpoint) ? clamp01(midpoint) : 0.5;
  const f = Number.isFinite(feather) ? Math.min(Math.max(feather, 1e-3), 1) : 0.5;
  const { w, h } = surface;
  if (w === 0 || h === 0) return;
  for (let y = 0; y < h; y++) {
    const ny = Math.fround(((y + 0.5) / h) * 2 - 1);
    for (let x = 0; x < w; x++) {
      const nx = Math.fround(((x + 0.5) / w) * 2 - 1);
      const d = Math.fround(Math.sqrt(nx * nx + ny * ny) / Math.SQRT2);
      const gain = 1 + a * smoothstep((d - m) / f);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        surface.data[i + c] = clamp01(clamp01(surface.data[i + c]) * gain);
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

/**
 * Motion-adaptive temporal denoise for video (mirrors Rust
 * `temporal_denoise`): blend the current frame toward the previous graded
 * frame per channel, weighted by a Gaussian range term
 * `exp(−((u − v)/σ)²)` (σ = 0.1) so large frame-to-frame differences
 * (motion) keep the current value: `out = v + amount × w × (u − v)`. Not a
 * GradeOp — run it after `applyDoc`, feeding its output back as `prev`.
 * Mismatched shapes/spaces are a no-op; alpha is untouched.
 */
export function temporalDenoise(current: GradeSurface, prev: GradeSurface, amount: number): void {
  const a = Number.isFinite(amount) ? clamp01(amount) : 0;
  if (
    current.w !== prev.w ||
    current.h !== prev.h ||
    current.space !== prev.space ||
    current.data.length !== prev.data.length
  ) {
    return;
  }
  const SIGMA = 0.1;
  for (let i = 0; i < current.data.length; i++) {
    if (i % 4 === 3) continue;
    const v = clamp01(current.data[i]);
    const u = clamp01(prev.data[i]);
    const d = (u - v) / SIGMA;
    const w = Math.exp(-d * d);
    current.data[i] = clamp01(v + a * w * (u - v));
  }
}
