// Transfer characteristics (mirror Rust `trc.rs`).

import { clamp01, type GradeSpace } from "./types";

/** Decode a gamma-encoded sample (`0..=1`) to linear light (mirrors Rust `trc_decode`). */
export function trcDecode(space: GradeSpace, c: number): number {
  if (space === "linear_rec709") return c;
  if (space === "srgb") return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return c < 0.03125 ? c / 16 : Math.pow(c, 1.8);
}

/**
 * Encode linear light back to a gamma-encoded sample, clamping to `0..=1` —
 * except the scene-referred linear space, which stays unbounded.
 */
export function trcEncode(space: GradeSpace, l: number): number {
  if (space === "linear_rec709") return l;
  const v = clamp01(l);
  if (space === "srgb") return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return v < 0.001953125 ? 16 * v : Math.pow(v, 1 / 1.8);
}
