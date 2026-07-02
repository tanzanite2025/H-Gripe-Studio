// Preview mirror of the Rust grade kernel (`crates/hgripe-grade`). Pure f32
// blend + compositing maths, no DOM. This is NOT kept in sync by comment
// discipline: both implementations are pinned to the same golden vectors in
// `crates/hgripe-grade/goldens/`, executed here by `gradeKernel.golden.test.ts`
// and in Rust by `cargo test -p hgripe-grade`. See docs/design/grade-kernel.md.

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
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      throw new Error(`${mode} is non-separable; use blendRgb`);
  }
}

type Rgb = [number, number, number];

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

export type CurveChannel = "master" | "red" | "green" | "blue";

export type GradeOp =
  | { type: "exposure"; ev: number }
  | { type: "white_balance"; temp: number; tint: number }
  | { type: "levels"; in_black: number; in_white: number; gamma: number; out_black: number; out_white: number }
  | { type: "curves"; channel: CurveChannel; points: [number, number][] }
  | { type: "saturation"; amount: number }
  | { type: "lift_gamma_gain"; lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] }
  | { type: "hsl_adjust"; hue: number; saturation: number; lightness: number }
  | { type: "lut3d"; size: number; table: number[] }
  | { type: "hue_vs_hue"; points: [number, number][] }
  | { type: "hue_vs_sat"; points: [number, number][] }
  | { type: "lum_vs_sat"; points: [number, number][] }
  | { type: "sat_vs_sat"; points: [number, number][] }
  | {
      type: "log_wheels";
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
      low_pivot: number;
      high_pivot: number;
    }
  | { type: "contrast"; amount: number; pivot: number }
  | { type: "soft_clip"; high_start: number; low_start: number }
  | { type: "white_balance_k"; temp_k: number; tint: number };

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

// Decode RGB to linear light, run `f`, re-encode (alpha untouched). The
// scene-referred linear space passes values through unclamped and unbounded.
function forEachRgbLinear(surface: GradeSurface, f: (rgb: [number, number, number]) => void): void {
  const n = surface.w * surface.h;
  const load = surface.space === "linear_rec709" ? (v: number) => v : clamp01;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const rgb: [number, number, number] = [
      trcDecode(surface.space, load(surface.data[i])),
      trcDecode(surface.space, load(surface.data[i + 1])),
      trcDecode(surface.space, load(surface.data[i + 2])),
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
    case "lift_gamma_gain": {
      const invGamma = op.gamma.map((g) => 1 / Math.max(g, 1e-6));
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) {
          const v = Math.max((rgb[c] + op.lift[c] * (1 - rgb[c])) * op.gain[c], 0);
          rgb[c] = Math.pow(v, invGamma[c]);
        }
      });
      break;
    }
    case "hsl_adjust": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        const [h, s, l] = rgbToHsl([
          clamp01(surface.data[i]),
          clamp01(surface.data[i + 1]),
          clamp01(surface.data[i + 2]),
        ]);
        const out = hslToRgb(
          (((h + op.hue) % 360) + 360) % 360,
          clamp01(s * (1 + op.saturation)),
          clamp01(l * (1 + op.lightness)),
        );
        surface.data[i] = out[0];
        surface.data[i + 1] = out[1];
        surface.data[i + 2] = out[2];
      }
      break;
    }
    case "hue_vs_hue": {
      const curve = periodicSpline(op.points, 0);
      forEachHsl(surface, (h, s, l) => [(((h + curve(h)) % 360) + 360) % 360, s, l]);
      break;
    }
    case "hue_vs_sat": {
      const curve = periodicSpline(op.points, 1);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(h)), l]);
      break;
    }
    case "lum_vs_sat": {
      const curve = multiplierSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(l)), l]);
      break;
    }
    case "sat_vs_sat": {
      const curve = multiplierSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(s)), l]);
      break;
    }
    case "log_wheels": {
      const low = Math.max(op.low_pivot, 1e-6);
      const highSpan = Math.max(1 - op.high_pivot, 1e-6);
      const zones = [op.shadows, op.midtones, op.highlights];
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01(surface.data[i + c]);
          const ws = 1 - smoothstep(v / low);
          const wh = smoothstep((v - op.high_pivot) / highSpan);
          const wm = Math.max(1 - ws - wh, 0);
          surface.data[i + c] = clamp01(v + ws * zones[0][c] + wm * zones[1][c] + wh * zones[2][c]);
        }
      }
      break;
    }
    case "contrast": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01(surface.data[i + c]);
          surface.data[i + c] = clamp01(op.pivot + (v - op.pivot) * op.amount);
        }
      }
      break;
    }
    case "lut3d": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        const out = lut3dSample(op.size, op.table, [
          clamp01(surface.data[i]),
          clamp01(surface.data[i + 1]),
          clamp01(surface.data[i + 2]),
        ]);
        surface.data[i] = out[0];
        surface.data[i + 1] = out[1];
        surface.data[i + 2] = out[2];
      }
      break;
    }
    case "soft_clip": {
      const hs = Math.min(Math.max(op.high_start, 0), 1 - 1e-4);
      const ls = Math.min(Math.max(op.low_start, 0), hs);
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] = softClip(rgb[c], hs, ls);
      });
      break;
    }
    case "white_balance_k": {
      const gains = planckianGains(op.temp_k, op.tint);
      forEachRgbLinear(surface, (rgb) => {
        for (let c = 0; c < 3; c++) rgb[c] *= gains[c];
      });
      break;
    }
  }
}

// Soft clip in linear light: asymptotic roll-off toward 1 above `hs` and
// toward 0 below `ls` (mirrors Rust `soft_clip`).
function softClip(v: number, hs: number, ls: number): number {
  if (v > hs) {
    const t = (v - hs) / (1 - hs);
    return hs + ((1 - hs) * t) / (1 + t);
  }
  if (v < ls) {
    if (ls <= 0) return 0;
    const t = (ls - v) / ls;
    return ls - (ls * t) / (1 + t);
  }
  return v;
}

// Planckian-locus white balance gains (Kim et al. CCT→xy fit,
// xy→XYZ→Rec.709, relative to the 6504 K neutral, luma-normalised;
// mirrors Rust `planckian_gains`).
export function planckianGains(tempK: number, tint: number): Rgb {
  const ref = planckianRgb(6504, 0);
  const target = planckianRgb(tempK, tint);
  const raw: Rgb = [target[0] / ref[0], target[1] / ref[1], target[2] / ref[2]];
  const luma = LUMA[0] * raw[0] + LUMA[1] * raw[1] + LUMA[2] * raw[2];
  return [raw[0] / luma, raw[1] / luma, raw[2] / luma];
}

function planckianRgb(tempK: number, tint: number): Rgb {
  const t = Number.isFinite(tempK) ? Math.min(Math.max(tempK, 1667), 25000) : 6504;
  const x =
    t <= 4000
      ? -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039;
  const yLocus =
    t <= 2222
      ? ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683
      : t <= 4000
        ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
        : ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  const tt = Number.isFinite(tint) ? Math.min(Math.max(tint, -1), 1) : 0;
  const y = Math.max(yLocus + 0.05 * tt, 1e-4);
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  const r = 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ;
  const g = -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ;
  const b = 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ;
  return [Math.max(r, 1e-4), Math.max(g, 1e-4), Math.max(b, 1e-4)];
}

const smoothstep = (t: number) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

// Convert each pixel to HSL, map it, convert back (alpha untouched).
function forEachHsl(surface: GradeSurface, f: (h: number, s: number, l: number) => [number, number, number]): void {
  const n = surface.w * surface.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const [h, s, l] = rgbToHsl([clamp01(surface.data[i]), clamp01(surface.data[i + 1]), clamp01(surface.data[i + 2])]);
    const out = hslToRgb(...f(h, s, l));
    surface.data[i] = out[0];
    surface.data[i + 1] = out[1];
    surface.data[i + 2] = out[2];
  }
}

// A hue-domain curve (period 360): points replicated one period below and
// above before building the spline so evaluation wraps seamlessly; no
// points evaluates to `neutral` (mirrors Rust `PeriodicSpline`).
function periodicSpline(points: [number, number][], neutral: number): (hue: number) => number {
  if (points.length === 0) return () => neutral;
  const base = points
    .map(([x, y]): [number, number] => [((x % 360) + 360) % 360, y])
    .sort((a, b) => a[0] - b[0]);
  const wrapped: [number, number][] = [-360, 0, 360].flatMap((shift) =>
    base.map(([x, y]): [number, number] => [x + shift, y]),
  );
  const spline = monotoneSpline(wrapped);
  return (hue) => spline(((hue % 360) + 360) % 360);
}

// A 0..=1-domain multiplier curve: no points is the identity multiplier 1
// (mirrors Rust `MultiplierSpline`).
function multiplierSpline(points: [number, number][]): (x: number) => number {
  if (points.length === 0) return () => 1;
  return monotoneSpline(points);
}

/** RGB (`0..=1`) → HSL with hue in degrees (mirrors Rust `rgb_to_hsl`). */
function rgbToHsl(rgb: Rgb): [number, number, number] {
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
function hslToRgb(h: number, s: number, l: number): Rgb {
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

// Tetrahedral 3D-LUT sample (the design doc's single LUT-sampling
// definition); `table` is size³ × 3 with red varying fastest (the .cube
// convention), mirroring Rust `Lut3d::sample`.
function lut3dSample(size: number, table: number[], rgb: Rgb): Rgb {
  const n = size - 1;
  const pos = rgb.map((v) => v * n);
  const i0 = pos.map((p) => Math.min(Math.floor(p), size - 2));
  const [fr, fg, fb] = pos.map((p, c) => p - i0[c]);
  const v = (dr: number, dg: number, db: number): Rgb => {
    const e = (((i0[2] + db) * size + (i0[1] + dg)) * size + (i0[0] + dr)) * 3;
    return [table[e], table[e + 1], table[e + 2]];
  };
  let w1: number, e1: Rgb, w2: number, e2: Rgb, w3: number, e3: Rgb;
  if (fr > fg) {
    if (fg > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fg, v(1, 1, 0), fb, v(1, 1, 1)];
    else if (fr > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fb, v(1, 0, 1), fg, v(1, 1, 1)];
    else [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fr, v(1, 0, 1), fg, v(1, 1, 1)];
  } else if (fb > fg) [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fg, v(0, 1, 1), fr, v(1, 1, 1)];
  else if (fb > fr) [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fb, v(0, 1, 1), fr, v(1, 1, 1)];
  else [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fr, v(1, 1, 0), fb, v(1, 1, 1)];
  const e0 = v(0, 0, 0);
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = e0[c] + w1 * (e1[c] - e0[c]) + w2 * (e2[c] - e1[c]) + w3 * (e3[c] - e2[c]);
  }
  return out;
}

/**
 * Parse a `.cube` 3D LUT into a `lut3d` op (mirrors Rust `parse_cube`).
 * Supports TITLE, LUT_3D_SIZE, the standard 0..1 DOMAIN, comments.
 */
export function parseCube(text: string): GradeOp {
  let size: number | null = null;
  const table: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const line = lines[lineno].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === "TITLE") continue;
    if (head === "LUT_3D_SIZE") {
      const v = Number(parts[1]);
      if (!Number.isInteger(v) || v < 2) throw new Error(`line ${lineno + 1}: bad LUT_3D_SIZE`);
      size = v;
    } else if (head === "DOMAIN_MIN" || head === "DOMAIN_MAX") {
      const want = head === "DOMAIN_MIN" ? 0 : 1;
      for (let k = 1; k <= 3; k++) {
        if (Number(parts[k]) !== want) throw new Error(`line ${lineno + 1}: only the standard 0..1 domain is supported`);
      }
    } else if (head === "LUT_1D_SIZE") {
      throw new Error(`line ${lineno + 1}: 1D LUTs are not supported`);
    } else {
      if (parts.length < 3) throw new Error(`line ${lineno + 1}: expected 3 values`);
      for (let k = 0; k < 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v)) throw new Error(`line ${lineno + 1}: bad value`);
        table.push(v);
      }
    }
  }
  if (size === null) throw new Error("missing LUT_3D_SIZE");
  if (table.length !== size * size * size * 3) {
    throw new Error(`expected ${size * size * size * 3} table values, got ${table.length}`);
  }
  return { type: "lut3d", size, table };
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
