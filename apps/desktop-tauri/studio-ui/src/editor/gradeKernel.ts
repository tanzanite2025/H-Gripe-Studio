// Preview mirror of the Rust grade kernel (`crates/hgripe-grade`). Pure f32
// blend + compositing maths, no DOM. This is NOT kept in sync by comment
// discipline: both implementations are pinned to the same golden vectors in
// `crates/hgripe-grade/goldens/`, executed here by `gradeKernel.golden.test.ts`
// and in Rust by `cargo test -p hgripe-grade`. See docs/design/grade-kernel.md.

export type GradeSpace = "srgb" | "pro_photo";

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color_dodge",
  "color_burn",
  "hard_light",
  "soft_light",
  "difference",
  "exclusion",
  "linear_dodge",
  "linear_burn",
] as const;
export type GradeBlendMode = (typeof BLEND_MODES)[number];

/** An f32 RGBA surface: interleaved `[R,G,B,A]`, row-major, straight alpha. */
export interface GradeSurface {
  w: number;
  h: number;
  data: Float32Array;
  space: GradeSpace;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

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
  }
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

  for (let px = 0; px < dst.w * dst.h; px++) {
    const i = px * 4;
    const gate = mask ? clamp01(mask[px]) : 1;
    const sa = clamp01(src.data[i + 3]) * op * gate;
    const ba = clamp01(dst.data[i + 3]);
    const oa = sa + ba * (1 - sa);
    for (let c = 0; c < 3; c++) {
      const cb = clamp01(dst.data[i + c]);
      const cs = clamp01(src.data[i + c]);
      dst.data[i + c] =
        oa === 0 ? 0 : (sa * (1 - ba) * cs + sa * ba * blendChannel(mode, cb, cs) + (1 - sa) * ba * cb) / oa;
    }
    dst.data[i + 3] = oa;
  }
}
