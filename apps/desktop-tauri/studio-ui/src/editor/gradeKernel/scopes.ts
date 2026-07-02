// Scopes: read-only analysers (mirror Rust `scopes.rs`).
// Scopes measure the encoded signal as displayed (values sanitised to the
// 0..=1 window; non-finite samples read as 0), never mutate the surface,
// and ignore alpha. All binning maths is f64 on both ends, so the integer
// counts are bit-identical and pinned exactly by `goldens/scopes.json`.

import { clamp01, type GradeSurface } from "./types";

/** Rec.709 luma weights (scope maths, f64 on both ends). */
const LUMA_SCOPE = [0.2126, 0.7152, 0.0722] as const;

/** Per-channel + luma histogram over `bins` buckets spanning 0..=1. */
export interface HistogramScope {
  bins: number;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
}

/**
 * Per-channel waveform: `cols × rows` counts, row 0 = signal 0, index
 * `row * cols + col`.
 */
export interface WaveformScope {
  cols: number;
  rows: number;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
}

/**
 * Vectorscope: `size × size` counts over the Rec.709 Cb–Cr plane, cell
 * `(ix, iy)` at `counts[iy * size + ix]`; neutral grays land in the centre.
 */
export interface VectorscopeScope {
  size: number;
  counts: Uint32Array;
}

// The displayed signal: non-finite samples read as 0, clamped to 0..=1.
const sane01 = (v: number) => (Number.isFinite(v) ? clamp01(v) : 0);

// Bucket index for `v` in 0..=1 over `k` buckets (`v = 1` lands in the last).
const bucket = (v: number, k: number) => Math.min(Math.floor(v * k), k - 1);

/** Histogram of the encoded signal (`bins` floored at 1; mirrors Rust `histogram`). */
export function histogramScope(surface: GradeSurface, bins: number): HistogramScope {
  const k = Math.max(Math.floor(bins), 1);
  const out: HistogramScope = {
    bins: k,
    r: new Uint32Array(k),
    g: new Uint32Array(k),
    b: new Uint32Array(k),
    luma: new Uint32Array(k),
  };
  const n = surface.w * surface.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const r = sane01(surface.data[i]);
    const g = sane01(surface.data[i + 1]);
    const b = sane01(surface.data[i + 2]);
    out.r[bucket(r, k)]++;
    out.g[bucket(g, k)]++;
    out.b[bucket(b, k)]++;
    const y = LUMA_SCOPE[0] * r + LUMA_SCOPE[1] * g + LUMA_SCOPE[2] * b;
    out.luma[bucket(y, k)]++;
  }
  return out;
}

/**
 * Waveform of the encoded signal over a `cols × rows` grid (both floored
 * at 1); image column `x` maps to scope column `x * cols / w`. Mirrors
 * Rust `waveform`.
 */
export function waveformScope(surface: GradeSurface, cols: number, rows: number): WaveformScope {
  const kc = Math.max(Math.floor(cols), 1);
  const kr = Math.max(Math.floor(rows), 1);
  const out: WaveformScope = {
    cols: kc,
    rows: kr,
    r: new Uint32Array(kc * kr),
    g: new Uint32Array(kc * kr),
    b: new Uint32Array(kc * kr),
  };
  if (surface.w === 0) return out;
  const planes = [out.r, out.g, out.b];
  for (let py = 0; py < surface.h; py++) {
    for (let px = 0; px < surface.w; px++) {
      const col = Math.floor((px * kc) / surface.w);
      const i = (py * surface.w + px) * 4;
      for (let c = 0; c < 3; c++) {
        planes[c][bucket(sane01(surface.data[i + c]), kr) * kc + col]++;
      }
    }
  }
  return out;
}

/** Vectorscope of the encoded signal (`size` floored at 1; mirrors Rust `vectorscope`). */
export function vectorscopeScope(surface: GradeSurface, size: number): VectorscopeScope {
  const k = Math.max(Math.floor(size), 1);
  const out: VectorscopeScope = { size: k, counts: new Uint32Array(k * k) };
  const n = surface.w * surface.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const r = sane01(surface.data[i]);
    const g = sane01(surface.data[i + 1]);
    const b = sane01(surface.data[i + 2]);
    const y = LUMA_SCOPE[0] * r + LUMA_SCOPE[1] * g + LUMA_SCOPE[2] * b;
    const cb = (b - y) / 1.8556;
    const cr = (r - y) / 1.5748;
    out.counts[bucket(cr + 0.5, k) * k + bucket(cb + 0.5, k)]++;
  }
  return out;
}
