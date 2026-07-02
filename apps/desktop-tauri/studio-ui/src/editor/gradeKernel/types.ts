// Shared types and small maths helpers for the grade kernel mirror.

export type GradeSpace = "srgb" | "pro_photo" | "linear_rec709";

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
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export type GradeBlendMode = (typeof BLEND_MODES)[number];

/** An f32 RGBA surface: interleaved `[R,G,B,A]`, row-major, straight alpha. */
export interface GradeSurface {
  w: number;
  h: number;
  data: Float32Array;
  space: GradeSpace;
}

export type Rgb = [number, number, number];

export const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

export const smoothstep = (t: number) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** Rec.709 luma weights (the design-doc choice for saturation). */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;
