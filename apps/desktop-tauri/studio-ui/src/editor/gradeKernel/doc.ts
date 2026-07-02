// The document model: layers, the qualifier gate, compositing and
// `applyDoc` (mirror Rust `doc.rs`, `qualifier.rs`, `composite.rs`).

import { blendRgb } from "./blend";
import { rgbToHsl } from "./hsl";
import { applyOp, type GradeOp } from "./ops";
import { clamp01, smoothstep, type GradeBlendMode, type GradeSurface, type Rgb } from "./types";

/**
 * HSL qualifier: a per-pixel gate computed from the layer's input (hue band
 * with circular falloff, sat/lum bands with falloff), multiplied with the
 * static mask — the secondary-grading model (mirrors Rust `HslQualifier`).
 */
export interface HslQualifier {
  hue_center: number;
  hue_range: number;
  hue_soft: number;
  sat_range: [number, number];
  sat_soft: number;
  lum_range: [number, number];
  lum_soft: number;
  invert?: boolean;
}

export interface GradeLayer {
  blend: GradeBlendMode;
  opacity: number;
  visible: boolean;
  mask: number[] | null;
  qualifier?: HslQualifier | null;
  ops: GradeOp[];
}

export interface GradeDoc {
  layers: GradeLayer[];
}

/**
 * Run a whole grade document over `surface` in place: each visible layer
 * grades a copy of the accumulated result and composites it back per
 * blend + opacity + mask (mirrors Rust `apply`).
 */
export function applyDoc(doc: GradeDoc, surface: GradeSurface): void {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    let mask = layer.mask ? Float32Array.from(layer.mask) : null;
    if (layer.qualifier) {
      const gate = qualifierGate(layer.qualifier, surface);
      if (mask) for (let px = 0; px < gate.length; px++) gate[px] *= clamp01(mask[px]);
      mask = gate;
    }
    const graded: GradeSurface = { ...surface, data: surface.data.slice() };
    for (const op of layer.ops) applyOp(graded, op);
    compositeOver(surface, graded, layer.blend, layer.opacity, mask);
  }
}

// 1 inside [lo, hi], smoothstep falloff over `soft` outside, 0 beyond.
function bandWeight(v: number, lo: number, hi: number, soft: number): number {
  if (v >= lo && v <= hi) return 1;
  if (soft <= 0) return 0;
  const d = v < lo ? lo - v : v - hi;
  return 1 - smoothstep(d / soft);
}

/** The qualifier's per-pixel gate over a surface (mirrors Rust `HslQualifier::gate`). */
export function qualifierGate(q: HslQualifier, surface: GradeSurface): Float32Array {
  const n = surface.w * surface.h;
  const gate = new Float32Array(n);
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const [h, s, l] = rgbToHsl([clamp01(surface.data[i]), clamp01(surface.data[i + 1]), clamp01(surface.data[i + 2])]);
    let d = (((h - q.hue_center) % 360) + 360) % 360;
    d = Math.min(d, 360 - d);
    const hueW = d <= q.hue_range ? 1 : q.hue_soft <= 0 ? 0 : 1 - smoothstep((d - q.hue_range) / q.hue_soft);
    const w = hueW * bandWeight(s, q.sat_range[0], q.sat_range[1], q.sat_soft) * bandWeight(l, q.lum_range[0], q.lum_range[1], q.lum_soft);
    gate[px] = q.invert ? 1 - w : w;
  }
  return gate;
}

/**
 * Composite `src` over `dst` in place (straight-alpha W3C simple alpha
 * compositing with a blend mode). `mask`, when present, is a `w*h` grayscale
 * gate scaling the source alpha. Mirrors Rust `composite_over`.
 */
export function compositeOver(
  dst: GradeSurface,
  src: GradeSurface,
  mode: GradeBlendMode,
  opacity: number,
  mask?: Float32Array | null,
): void {
  if (dst.w !== src.w || dst.h !== src.h) throw new Error("surface dimensions");
  if (dst.space !== src.space) throw new Error("surface space");
  if (mask && mask.length !== dst.w * dst.h) throw new Error("mask length");
  const op = clamp01(opacity);
  // The blend-mode formulas are defined on 0..=1 values. In the
  // scene-referred linear space, Normal passes values through unclamped so
  // HDR headroom and negatives survive across layers; every other mode
  // still works on the clamped display window.
  const load = dst.space === "linear_rec709" && mode === "normal" ? (v: number) => v : clamp01;

  for (let px = 0; px < dst.w * dst.h; px++) {
    const i = px * 4;
    const gate = mask ? clamp01(mask[px]) : 1;
    const sa = clamp01(src.data[i + 3]) * op * gate;
    const ba = clamp01(dst.data[i + 3]);
    const oa = sa + ba * (1 - sa);
    const cb: Rgb = [load(dst.data[i]), load(dst.data[i + 1]), load(dst.data[i + 2])];
    const cs: Rgb = [load(src.data[i]), load(src.data[i + 1]), load(src.data[i + 2])];
    const blended = blendRgb(mode, cb, cs);
    for (let c = 0; c < 3; c++) {
      dst.data[i + c] = oa === 0 ? 0 : (sa * (1 - ba) * cs[c] + sa * ba * blended[c] + (1 - sa) * ba * cb[c]) / oa;
    }
    dst.data[i + 3] = oa;
  }
}
