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

/** Decode a gamma-encoded sample (`0..=1`) to linear light (mirrors Rust `trc_decode`). */
export function trcDecode(space: GradeSpace, c: number): number {
  if (space === "srgb") return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return c < 0.03125 ? c / 16 : Math.pow(c, 1.8);
}

/** Encode linear light back to a gamma-encoded sample, clamping to `0..=1`. */
export function trcEncode(space: GradeSpace, l: number): number {
  const v = clamp01(l);
  if (space === "srgb") return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return v < 0.001953125 ? 16 * v : Math.pow(v, 1 / 1.8);
}

export type CurveChannel = "master" | "red" | "green" | "blue";

export type GradeOp =
  | { type: "exposure"; ev: number }
  | { type: "white_balance"; temp: number; tint: number }
  | { type: "levels"; in_black: number; in_white: number; gamma: number; out_black: number; out_white: number }
  | { type: "curves"; channel: CurveChannel; points: [number, number][] }
  | { type: "saturation"; amount: number };

export interface GradeLayer {
  blend: GradeBlendMode;
  opacity: number;
  visible: boolean;
  mask: number[] | null;
  ops: GradeOp[];
}

export interface GradeDoc {
  layers: GradeLayer[];
}

const LUMA = [0.2126, 0.7152, 0.0722]; // Rec.709

/**
 * Fritsch–Carlson monotone piecewise-cubic through the control points:
 * no overshoot, flat outside the endpoints (mirrors Rust `MonotoneSpline`).
 */
export function monotoneSpline(points: [number, number][]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  const tangents = new Array<number>(n).fill(0);
  if (n >= 2) {
    const d = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - x, 1e-6));
    tangents[0] = d[0];
    tangents[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) tangents[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        tangents[i] = 0;
        tangents[i + 1] = 0;
      } else {
        const a = tangents[i] / d[i];
        const b = tangents[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
          const t = 3 / Math.sqrt(s);
          tangents[i] = t * a * d[i];
          tangents[i + 1] = t * b * d[i];
        }
      }
    }
  }
  return (x: number) => {
    if (n === 0) return x;
    if (n === 1 || x <= xs[0]) return x <= xs[0] ? ys[0] : ys[n - 1];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i + 2 < n && x >= xs[i + 1]) i++;
    const h = Math.max(xs[i + 1] - xs[i], 1e-6);
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * tangents[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * tangents[i + 1]
    );
  };
}

// Decode RGB to linear light, run `f`, re-encode (alpha untouched).
function forEachRgbLinear(surface: GradeSurface, f: (rgb: [number, number, number]) => void): void {
  const n = surface.w * surface.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const rgb: [number, number, number] = [
      trcDecode(surface.space, clamp01(surface.data[i])),
      trcDecode(surface.space, clamp01(surface.data[i + 1])),
      trcDecode(surface.space, clamp01(surface.data[i + 2])),
    ];
    f(rgb);
    surface.data[i] = trcEncode(surface.space, rgb[0]);
    surface.data[i + 1] = trcEncode(surface.space, rgb[1]);
    surface.data[i + 2] = trcEncode(surface.space, rgb[2]);
  }
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
  }
}

/**
 * Run a whole grade document over `surface` in place: each visible layer
 * grades a copy of the accumulated result and composites it back per
 * blend + opacity + mask (mirrors Rust `apply`).
 */
export function applyDoc(doc: GradeDoc, surface: GradeSurface): void {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const graded: GradeSurface = { ...surface, data: surface.data.slice() };
    for (const op of layer.ops) applyOp(graded, op);
    compositeOver(surface, graded, layer.blend, layer.opacity, layer.mask ? Float32Array.from(layer.mask) : null);
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
