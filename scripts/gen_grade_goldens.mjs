// Generator for crates/hgripe-grade/goldens/*.json — the shared golden
// vectors both the Rust kernel and the studio-ui mirror are pinned to.
// Expected values are computed in float64 from the W3C compositing-1 spec
// formulas; both f32 (Rust) and float64 (TS) runners assert within each
// case's tolerance. Rerun with `node scripts/gen_grade_goldens.mjs` only
// when *adding* vectors; regenerating existing ones is a spec change and
// must be called out in review.

import { writeFileSync } from "node:fs";

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

const MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color_dodge", "color_burn", "hard_light", "soft_light",
  "difference", "exclusion", "linear_dodge", "linear_burn",
];
const NON_SEPARABLE = ["hue", "saturation", "color", "luminosity"];

function blend(mode, cb, cs) {
  switch (mode) {
    case "normal": return cs;
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "overlay": return blend("hard_light", cs, cb);
    case "darken": return Math.min(cb, cs);
    case "lighten": return Math.max(cb, cs);
    case "color_dodge":
      if (cb <= 0) return 0;
      if (cs >= 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case "color_burn":
      if (cb >= 1) return 1;
      if (cs <= 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case "hard_light":
      return cs <= 0.5 ? blend("multiply", cb, 2 * cs) : blend("screen", cb, 2 * cs - 1);
    case "soft_light": {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case "difference": return Math.abs(cb - cs);
    case "exclusion": return cb + cs - 2 * cb * cs;
    case "linear_dodge": return Math.min(1, cb + cs);
    case "linear_burn": return Math.max(0, cb + cs - 1);
  }
}

// W3C compositing-1 non-separable helpers.
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const satOf = (c) => Math.max(...c) - Math.min(...c);
function clipColor(c) {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return out;
}
const setLum = (c, l) => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};
function setSat(c, s) {
  const [lo, mid, hi] = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const out = [0, 0, 0];
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    out[hi] = s;
  }
  return out;
}
function blendRgb(mode, cb, cs) {
  switch (mode) {
    case "hue": return setLum(setSat(cs, satOf(cb)), lum(cb));
    case "saturation": return setLum(setSat(cb, satOf(cs)), lum(cb));
    case "color": return setLum(cs, lum(cb));
    case "luminosity": return setLum(cb, lum(cs));
    default: return [blend(mode, cb[0], cs[0]), blend(mode, cb[1], cs[1]), blend(mode, cb[2], cs[2])];
  }
}

function composite(backdrop, source, mode, opacity, mask) {
  const out = backdrop.data.slice();
  const n = backdrop.w * backdrop.h;
  // Scene-referred linear + Normal passes values through unclamped.
  const load = backdrop.space === "linear_rec709" && mode === "normal" ? (v) => v : clamp01;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const gate = mask ? clamp01(mask[px]) : 1;
    const sa = clamp01(source.data[i + 3]) * clamp01(opacity) * gate;
    const ba = clamp01(backdrop.data[i + 3]);
    const oa = sa + ba * (1 - sa);
    const cb = [0, 1, 2].map((c) => load(backdrop.data[i + c]));
    const cs = [0, 1, 2].map((c) => load(source.data[i + c]));
    const blended = blendRgb(mode, cb, cs);
    for (let c = 0; c < 3; c++) {
      out[i + c] = oa === 0 ? 0 : (sa * (1 - ba) * cs[c] + sa * ba * blended[c] + (1 - sa) * ba * cb[c]) / oa;
    }
    out[i + 3] = oa;
  }
  return out;
}

// ---- G2 op maths (float64 spec mirrors of crates/hgripe-grade/src/ops.rs) ----

const trcDecode = (space, c) =>
  space === "linear_rec709"
    ? c
    : space === "srgb"
      ? c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      : c < 0.03125 ? c / 16 : Math.pow(c, 1.8);
const trcEncode = (space, l) => {
  if (space === "linear_rec709") return l;
  const v = clamp01(l);
  return space === "srgb"
    ? v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    : v < 0.001953125 ? 16 * v : Math.pow(v, 1 / 1.8);
};

const LUMA = [0.2126, 0.7152, 0.0722];

function monotoneSpline(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  const tg = new Array(n).fill(0);
  if (n >= 2) {
    const d = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - x, 1e-6));
    tg[0] = d[0];
    tg[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) tg[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { tg[i] = 0; tg[i + 1] = 0; continue; }
      const a = tg[i] / d[i], b = tg[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); tg[i] = t * a * d[i]; tg[i + 1] = t * b * d[i]; }
    }
  }
  return (x) => {
    if (n === 0) return x;
    if (n === 1 || x <= xs[0]) return x <= xs[0] ? ys[0] : ys[n - 1];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i + 2 < n && x >= xs[i + 1]) i++;
    const h = Math.max(xs[i + 1] - xs[i], 1e-6);
    const t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * tg[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * tg[i + 1];
  };
}

function forEachRgbLinear(surface, f) {
  const load = surface.space === "linear_rec709" ? (v) => v : clamp01;
  for (let px = 0; px < surface.w * surface.h; px++) {
    const i = px * 4;
    const rgb = [0, 1, 2].map((c) => trcDecode(surface.space, load(surface.data[i + c])));
    f(rgb);
    for (let c = 0; c < 3; c++) surface.data[i + c] = trcEncode(surface.space, rgb[c]);
  }
}

function applyOp(surface, op) {
  const n = surface.w * surface.h;
  switch (op.type) {
    case "exposure": {
      const gain = Math.pow(2, op.ev);
      forEachRgbLinear(surface, (rgb) => { for (let c = 0; c < 3; c++) rgb[c] *= gain; });
      break;
    }
    case "white_balance": {
      const gains = [Math.pow(2, op.temp), Math.pow(2, op.tint), Math.pow(2, -op.temp)];
      forEachRgbLinear(surface, (rgb) => { for (let c = 0; c < 3; c++) rgb[c] *= gains[c]; });
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
        const [h, s, l] = rgbToHsl([0, 1, 2].map((c) => clamp01(surface.data[i + c])));
        const out = hslToRgb(
          (((h + op.hue) % 360) + 360) % 360,
          clamp01(s * (1 + op.saturation)),
          clamp01(l * (1 + op.lightness)),
        );
        for (let c = 0; c < 3; c++) surface.data[i + c] = out[c];
      }
      break;
    }
    case "lut3d": {
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        const out = lut3dSample(op.size, op.table, [0, 1, 2].map((c) => clamp01(surface.data[i + c])));
        for (let c = 0; c < 3; c++) surface.data[i + c] = out[c];
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
      const curve = op.points.length === 0 ? () => 1 : monotoneSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(l)), l]);
      break;
    }
    case "sat_vs_sat": {
      const curve = op.points.length === 0 ? () => 1 : monotoneSpline(op.points);
      forEachHsl(surface, (h, s, l) => [h, clamp01(s * curve(s)), l]);
      break;
    }
    case "log_wheels": {
      const low = Math.max(op.low_pivot, 1e-6);
      const highSpan = Math.max(1 - op.high_pivot, 1e-6);
      for (let px = 0; px < n; px++) {
        const i = px * 4;
        for (let c = 0; c < 3; c++) {
          const v = clamp01(surface.data[i + c]);
          const ws = 1 - smoothstep(v / low);
          const wh = smoothstep((v - op.high_pivot) / highSpan);
          const wm = Math.max(1 - ws - wh, 0);
          surface.data[i + c] = clamp01(v + ws * op.shadows[c] + wm * op.midtones[c] + wh * op.highlights[c]);
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
      forEachRgbLinear(surface, (rgb) => { for (let c = 0; c < 3; c++) rgb[c] *= gains[c]; });
      break;
    }
    case "rgb_mixer": {
      const sane = (w) => w.map((v) => (Number.isFinite(v) ? v : 0));
      const rows = op.monochrome
        ? [sane(op.red), sane(op.red), sane(op.red)]
        : [sane(op.red), sane(op.green), sane(op.blue)];
      forEachRgbLinear(surface, (rgb) => {
        const src = [rgb[0], rgb[1], rgb[2]];
        for (let c = 0; c < 3; c++) {
          rgb[c] = rows[c][0] * src[0] + rows[c][1] * src[1] + rows[c][2] * src[2];
        }
      });
      break;
    }
  }
}

function softClip(v, hs, ls) {
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

// Planckian-locus white balance gains (Kim et al. CCT→xy fit, xy→XYZ→Rec.709,
// relative to the 6504 K neutral, Rec.709-luma-normalised).
function planckianGains(tempK, tint) {
  const ref = planckianRgb(6504, 0);
  const target = planckianRgb(tempK, tint);
  const raw = [target[0] / ref[0], target[1] / ref[1], target[2] / ref[2]];
  const luma = LUMA[0] * raw[0] + LUMA[1] * raw[1] + LUMA[2] * raw[2];
  return raw.map((g) => g / luma);
}

function planckianRgb(tempK, tint) {
  const t = Number.isFinite(tempK) ? Math.min(Math.max(tempK, 1667), 25000) : 6504;
  const x = t <= 4000
    ? -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.17991
    : -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039;
  const yLocus = t <= 2222
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

const smoothstep = (t) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

function forEachHsl(surface, f) {
  for (let px = 0; px < surface.w * surface.h; px++) {
    const i = px * 4;
    const [h, s, l] = rgbToHsl([0, 1, 2].map((c) => clamp01(surface.data[i + c])));
    const out = hslToRgb(...f(h, s, l));
    for (let c = 0; c < 3; c++) surface.data[i + c] = out[c];
  }
}

// Hue-domain curve (period 360): points replicated one period below/above.
function periodicSpline(points, neutral) {
  if (points.length === 0) return () => neutral;
  const base = points.map(([x, y]) => [((x % 360) + 360) % 360, y]).sort((a, b) => a[0] - b[0]);
  const wrapped = [-360, 0, 360].flatMap((shift) => base.map(([x, y]) => [x + shift, y]));
  const spline = monotoneSpline(wrapped);
  return (hue) => spline(((hue % 360) + 360) % 360);
}

function rgbToHsl(rgb) {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d <= 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rgb[0]) h = 60 * (((((rgb[1] - rgb[2]) / d) % 6) + 6) % 6);
  else if (max === rgb[1]) h = 60 * ((rgb[2] - rgb[0]) / d + 2);
  else h = 60 * ((rgb[0] - rgb[1]) / d + 4);
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((((hp % 2) + 2) % 2) - 1));
  const seg = Math.min(Math.floor(hp), 5);
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

// Tetrahedral sampling — the design doc's single LUT-sampling definition.
function lut3dSample(size, table, rgb) {
  const nMax = size - 1;
  const pos = rgb.map((v) => v * nMax);
  const i0 = pos.map((p) => Math.min(Math.floor(p), size - 2));
  const [fr, fg, fb] = pos.map((p, c) => p - i0[c]);
  const v = (dr, dg, db) => {
    const e = (((i0[2] + db) * size + (i0[1] + dg)) * size + (i0[0] + dr)) * 3;
    return [table[e], table[e + 1], table[e + 2]];
  };
  let w1, e1, w2, e2, w3, e3;
  if (fr > fg) {
    if (fg > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fg, v(1, 1, 0), fb, v(1, 1, 1)];
    else if (fr > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fb, v(1, 0, 1), fg, v(1, 1, 1)];
    else [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fr, v(1, 0, 1), fg, v(1, 1, 1)];
  } else if (fb > fg) [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fg, v(0, 1, 1), fr, v(1, 1, 1)];
  else if (fb > fr) [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fb, v(0, 1, 1), fr, v(1, 1, 1)];
  else [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fr, v(1, 1, 0), fb, v(1, 1, 1)];
  const e0 = v(0, 0, 0);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = e0[c] + w1 * (e1[c] - e0[c]) + w2 * (e2[c] - e1[c]) + w3 * (e3[c] - e2[c]);
  }
  return out;
}

// 1 inside [lo, hi], smoothstep falloff over `soft` outside, 0 beyond.
function bandWeight(v, lo, hi, soft) {
  if (v >= lo && v <= hi) return 1;
  if (soft <= 0) return 0;
  const d = v < lo ? lo - v : v - hi;
  return 1 - smoothstep(d / soft);
}

// The HSL qualifier's per-pixel gate over a surface.
function qualifierGate(q, surface) {
  const n = surface.w * surface.h;
  const gate = new Array(n);
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const [h, s, l] = rgbToHsl([0, 1, 2].map((c) => clamp01(surface.data[i + c])));
    let d = (((h - q.hue_center) % 360) + 360) % 360;
    d = Math.min(d, 360 - d);
    const hueW = d <= q.hue_range ? 1 : q.hue_soft <= 0 ? 0 : 1 - smoothstep((d - q.hue_range) / q.hue_soft);
    const w = hueW * bandWeight(s, q.sat_range[0], q.sat_range[1], q.sat_soft) * bandWeight(l, q.lum_range[0], q.lum_range[1], q.lum_soft);
    gate[px] = q.invert ? 1 - w : w;
  }
  return gate;
}

function applyDoc(doc, input) {
  const surface = { ...input, data: input.data.slice() };
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    let gate = layer.mask;
    if (layer.qualifier) {
      gate = qualifierGate(layer.qualifier, surface);
      if (layer.mask) gate = gate.map((g, px) => g * clamp01(layer.mask[px]));
    }
    const graded = { ...surface, data: surface.data.slice() };
    for (const op of layer.ops) applyOp(graded, op);
    const out = composite({ ...surface }, graded, layer.blend, layer.opacity, gate);
    surface.data = out;
  }
  return surface.data;
}

// A 3x2 pixel set exercising branch points: dodge/burn extremes, the
// hard/soft-light cs=0.5 split, the soft-light cb<=0.25 polynomial branch,
// partial alphas, and a fully transparent backdrop pixel.
const backdrop = {
  w: 3, h: 2, space: "srgb",
  data: [
    0.0, 0.25, 0.5, 1.0,
    1.0, 0.75, 0.2, 1.0,
    0.5, 0.5, 0.5, 0.5,
    0.25, 0.1, 0.9, 0.8,
    0.6, 0.4, 0.0, 0.25,
    0.3, 0.7, 0.15, 0.0,
  ],
};
const source = {
  w: 3, h: 2, space: "srgb",
  data: [
    1.0, 0.5, 0.25, 1.0,
    0.0, 1.0, 0.5, 0.5,
    0.5, 0.49999997, 0.75, 1.0,
    0.9, 0.5, 0.1, 0.25,
    0.2, 0.8, 1.0, 0.0,
    0.65, 0.35, 0.5, 1.0,
  ],
};
const mask = [1.0, 0.5, 0.0, 0.25, 1.0, 0.75];

const cases = [];
for (const mode of [...MODES, ...NON_SEPARABLE]) {
  cases.push({
    name: `${mode}: full opacity, no mask`,
    mode, opacity: 1.0, mask: null, backdrop, source,
    expected: composite(backdrop, source, mode, 1.0, null),
    tolerance: 5e-6,
  });
}
cases.push({
  name: "multiply: half opacity",
  mode: "multiply", opacity: 0.5, mask: null, backdrop, source,
  expected: composite(backdrop, source, "multiply", 0.5, null),
  tolerance: 5e-6,
});
cases.push({
  name: "normal: per-pixel mask gates the source alpha",
  mode: "normal", opacity: 1.0, mask, backdrop, source,
  expected: composite(backdrop, source, "normal", 1.0, mask),
  tolerance: 5e-6,
});
cases.push({
  name: "screen: mask and opacity stack",
  mode: "screen", opacity: 0.6, mask, backdrop, source,
  expected: composite(backdrop, source, "screen", 0.6, mask),
  tolerance: 5e-6,
});

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/blend_separable.json", import.meta.url),
  JSON.stringify({ kind: "composite", cases }, null, 2) + "\n",
);
console.log(`wrote ${cases.length} composite cases`);

// ---- G2 doc/op cases: full GradeDoc applied to an input surface ----

const opsInput = {
  w: 3, h: 2, space: "srgb",
  data: [
    0.0, 0.25, 0.5, 1.0,
    1.0, 0.75, 0.2, 1.0,
    0.5, 0.5, 0.5, 0.5,
    0.02, 0.001, 0.98, 0.8, // near the sRGB linear-toe threshold
    0.6, 0.4, 0.0, 0.25,
    0.3, 0.7, 0.15, 1.0,
  ],
};
const opsInputPro = { ...opsInput, space: "pro_photo" };

const layer = (ops, extra = {}) => ({ blend: "normal", opacity: 1.0, visible: true, mask: null, ops, ...extra });
const docCase = (name, doc, input, tolerance = 2e-5) => ({
  name, doc, input, expected: applyDoc(doc, input), tolerance,
});

const sCurve = [[0.0, 0.0], [0.25, 0.15], [0.75, 0.85], [1.0, 1.0]];

const docCases = [
  docCase("exposure +1 EV", { layers: [layer([{ type: "exposure", ev: 1.0 }])] }, opsInput),
  docCase("exposure -1.5 EV in ProPhoto", { layers: [layer([{ type: "exposure", ev: -1.5 }])] }, opsInputPro),
  docCase("white balance warm + green tint", { layers: [layer([{ type: "white_balance", temp: 0.3, tint: -0.2 }])] }, opsInput),
  docCase("levels: crush + gamma + output range", {
    layers: [layer([{ type: "levels", in_black: 0.1, in_white: 0.9, gamma: 1.2, out_black: 0.05, out_white: 0.95 }])],
  }, opsInput),
  docCase("curves: master S-curve", {
    layers: [layer([{ type: "curves", channel: "master", points: sCurve }])],
  }, opsInput),
  docCase("curves: red channel only", {
    layers: [layer([{ type: "curves", channel: "red", points: [[0.0, 0.1], [0.5, 0.4], [1.0, 0.9]] }])],
  }, opsInput),
  docCase("saturation -0.5", { layers: [layer([{ type: "saturation", amount: -0.5 }])] }, opsInput),
  docCase("saturation -1 is grayscale", { layers: [layer([{ type: "saturation", amount: -1.0 }])] }, opsInput),
  docCase("op chain in one layer: exposure then curves then saturation", {
    layers: [layer([
      { type: "exposure", ev: 0.5 },
      { type: "curves", channel: "master", points: sCurve },
      { type: "saturation", amount: 0.4 },
    ])],
  }, opsInput),
  docCase("two layers: soft_light exposure at 0.7 with mask, then saturation", {
    layers: [
      layer([{ type: "exposure", ev: 1.0 }], { blend: "soft_light", opacity: 0.7, mask }),
      layer([{ type: "saturation", amount: 0.25 }]),
    ],
  }, opsInput),
  docCase("hidden layer is skipped", {
    layers: [
      layer([{ type: "exposure", ev: 3.0 }], { visible: false }),
      layer([{ type: "levels", in_black: 0.0, in_white: 1.0, gamma: 0.8, out_black: 0.0, out_white: 1.0 }]),
    ],
  }, opsInput),
];

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/ops_core.json", import.meta.url),
  JSON.stringify({ kind: "doc", cases: docCases }, null, 2) + "\n",
);
console.log(`wrote ${docCases.length} doc cases`);

// ---- G3 video-op cases ----

// A warm-shift LUT (size 2): lifts red, drops blue at the corners.
const warmLut = { type: "lut3d", size: 2, table: [] };
for (let b = 0; b < 2; b++) {
  for (let g = 0; g < 2; g++) {
    for (let r = 0; r < 2; r++) {
      warmLut.table.push(Math.min(r + 0.1, 1), g, Math.max(b - 0.1, 0));
    }
  }
}

const videoCases = [
  docCase("lift_gamma_gain: neutral is a no-op", {
    layers: [layer([{ type: "lift_gamma_gain", lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] }])],
  }, opsInput),
  docCase("lift_gamma_gain: warm shadows, cool gain, mid gamma", {
    layers: [layer([{ type: "lift_gamma_gain", lift: [0.05, 0.0, -0.05], gamma: [1.1, 1.0, 0.9], gain: [1.1, 1.0, 0.9] }])],
  }, opsInput),
  docCase("hsl_adjust: hue +90", { layers: [layer([{ type: "hsl_adjust", hue: 90, saturation: 0, lightness: 0 }])] }, opsInput),
  docCase("hsl_adjust: desaturate and lighten", {
    layers: [layer([{ type: "hsl_adjust", hue: 0, saturation: -0.4, lightness: 0.2 }])],
  }, opsInput),
  docCase("lut3d: warm-shift 2^3 LUT", { layers: [layer([warmLut])] }, opsInput),
  docCase("non-separable blend: color grade layer over backdrop", {
    layers: [layer([{ type: "hsl_adjust", hue: 180, saturation: 0.3, lightness: 0 }], { blend: "color", opacity: 0.8 })],
  }, opsInput),
  docCase("non-separable blend: luminosity with mask", {
    layers: [layer([{ type: "exposure", ev: 1.2 }], { blend: "luminosity", mask })],
  }, opsInput),
];

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/ops_video.json", import.meta.url),
  JSON.stringify({ kind: "doc", cases: videoCases }, null, 2) + "\n",
);
console.log(`wrote ${videoCases.length} video-op cases`);

// ---- Pro cases: secondaries (qualifier), hue curves, log wheels, contrast ----

const redQualifier = {
  hue_center: 0, hue_range: 30, hue_soft: 30,
  sat_range: [0.15, 1], sat_soft: 0.1,
  lum_range: [0, 1], lum_soft: 0,
  invert: false,
};
const shadowQualifier = {
  hue_center: 0, hue_range: 180, hue_soft: 0,
  sat_range: [0, 1], sat_soft: 0,
  lum_range: [0, 0.35], lum_soft: 0.15,
  invert: false,
};

const proCases = [
  docCase("qualifier: desaturate reds only", {
    layers: [layer([{ type: "saturation", amount: -0.8 }], { qualifier: redQualifier })],
  }, opsInput),
  docCase("qualifier: inverted red selection", {
    layers: [layer([{ type: "exposure", ev: 0.8 }], { qualifier: { ...redQualifier, invert: true } })],
  }, opsInput),
  docCase("qualifier: shadows-only lift, stacked with mask", {
    layers: [layer([{ type: "exposure", ev: 1.0 }], { qualifier: shadowQualifier, mask })],
  }, opsInput),
  docCase("hue_vs_hue: push oranges toward red", {
    layers: [layer([{ type: "hue_vs_hue", points: [[0, 0], [30, -15], [120, 0], [240, 0]] }])],
  }, opsInput),
  docCase("hue_vs_hue: empty points is identity", {
    layers: [layer([{ type: "hue_vs_hue", points: [] }])],
  }, opsInput),
  docCase("hue_vs_sat: boost blues, mute greens", {
    layers: [layer([{ type: "hue_vs_sat", points: [[120, 0.4], [240, 1.6], [0, 1]] }])],
  }, opsInput),
  docCase("lum_vs_sat: desaturate shadows", {
    layers: [layer([{ type: "lum_vs_sat", points: [[0, 0.2], [0.5, 1], [1, 1]] }])],
  }, opsInput),
  docCase("sat_vs_sat: boost muted colours only", {
    layers: [layer([{ type: "sat_vs_sat", points: [[0, 1.5], [0.5, 1], [1, 1]] }])],
  }, opsInput),
  docCase("log_wheels: neutral is a no-op", {
    layers: [layer([{ type: "log_wheels", shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], low_pivot: 0.33, high_pivot: 0.55 }])],
  }, opsInput),
  docCase("log_wheels: cool shadows, warm highlights", {
    layers: [layer([{ type: "log_wheels", shadows: [-0.05, 0, 0.05], midtones: [0.02, 0, 0], highlights: [0.06, 0.02, -0.04], low_pivot: 0.33, high_pivot: 0.55 }])],
  }, opsInput),
  docCase("contrast: 1.3 about Resolve's default pivot", {
    layers: [layer([{ type: "contrast", amount: 1.3, pivot: 0.435 }])],
  }, opsInput),
  docCase("contrast: flatten to the pivot", {
    layers: [layer([{ type: "contrast", amount: 0.5, pivot: 0.5 }])],
  }, opsInputPro),
];

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/ops_pro.json", import.meta.url),
  JSON.stringify({ kind: "doc", cases: proCases }, null, 2) + "\n",
);
console.log(`wrote ${proCases.length} pro cases`);

// ---- HDR / scene-referred cases: unbounded linear working space ----

// Scene-referred linear input with HDR headroom and a negative excursion.
const hdrInput = {
  w: 3, h: 2, space: "linear_rec709",
  data: [
    0.0, 0.18, 0.5, 1.0,
    4.0, 2.5, 1.2, 1.0, // HDR highlights
    -0.1, 0.05, 0.95, 0.5, // negative excursion
    12.0, 8.0, 6.0, 0.8, // speculars
    0.6, 0.4, 0.0, 0.25,
    1.0, 1.0, 1.0, 1.0,
  ],
};

// HDR magnitudes (up to ~48 after +2 EV) need an absolute tolerance scaled
// for f32's relative precision.
const hdrCases = [
  docCase("linear: exposure +2 EV keeps HDR headroom unclamped", {
    layers: [layer([{ type: "exposure", ev: 2.0 }])],
  }, hdrInput, 5e-4),
  docCase("linear: exposure then saturation, negatives survive", {
    layers: [layer([{ type: "exposure", ev: -1.0 }, { type: "saturation", amount: 0.5 }])],
  }, hdrInput, 5e-4),
  docCase("linear: two normal layers keep headroom across compositing", {
    layers: [
      layer([{ type: "exposure", ev: 1.0 }], { opacity: 0.6, mask }),
      layer([{ type: "exposure", ev: 0.5 }]),
    ],
  }, hdrInput, 5e-4),
  docCase("soft_clip: rolls HDR into display range", {
    layers: [layer([{ type: "soft_clip", high_start: 0.8, low_start: 0.0 }])],
  }, hdrInput, 5e-4),
  docCase("soft_clip: shadow toe with low_start", {
    layers: [layer([{ type: "soft_clip", high_start: 0.9, low_start: 0.1 }])],
  }, hdrInput, 5e-4),
  docCase("soft_clip: neutral inside the knees", {
    layers: [layer([{ type: "soft_clip", high_start: 0.999, low_start: 0.0 }])],
  }, opsInput),
  docCase("white_balance_k: 6504 K is neutral", {
    layers: [layer([{ type: "white_balance_k", temp_k: 6504, tint: 0 }])],
  }, opsInput),
  docCase("white_balance_k: warm to 3200 K tungsten", {
    layers: [layer([{ type: "white_balance_k", temp_k: 3200, tint: 0 }])],
  }, opsInput),
  docCase("white_balance_k: cool to 10000 K with magenta tint", {
    layers: [layer([{ type: "white_balance_k", temp_k: 10000, tint: -0.3 }])],
  }, hdrInput),
  docCase("hdr chain: exposure, planckian warm, soft clip", {
    layers: [layer([
      { type: "exposure", ev: 1.5 },
      { type: "white_balance_k", temp_k: 4500, tint: 0.1 },
      { type: "soft_clip", high_start: 0.75, low_start: 0.02 },
    ])],
  }, hdrInput),
];

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/ops_hdr.json", import.meta.url),
  JSON.stringify({ kind: "doc", cases: hdrCases }, null, 2) + "\n",
);
console.log(`wrote ${hdrCases.length} hdr cases`);

// ---- Mixer cases: RGB channel mixer (wave 3) ----

const mixerCases = [
  docCase("rgb_mixer: identity matrix is a no-op", {
    layers: [layer([{ type: "rgb_mixer", red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], monochrome: false }])],
  }, opsInput),
  docCase("rgb_mixer: swap red and blue", {
    layers: [layer([{ type: "rgb_mixer", red: [0, 0, 1], green: [0, 1, 0], blue: [1, 0, 0], monochrome: false }])],
  }, opsInput),
  docCase("rgb_mixer: bleed green into red, boost blue", {
    layers: [layer([{ type: "rgb_mixer", red: [0.8, 0.3, -0.1], green: [0, 1, 0], blue: [0, -0.2, 1.2], monochrome: false }])],
  }, opsInput),
  docCase("rgb_mixer: monochrome uses the red row as a B&W mix", {
    layers: [layer([{ type: "rgb_mixer", red: [0.4, 0.5, 0.1], green: [0, 1, 0], blue: [0, 0, 1], monochrome: true }])],
  }, opsInput),
  docCase("rgb_mixer: pro_photo space", {
    layers: [layer([{ type: "rgb_mixer", red: [1.1, -0.05, -0.05], green: [-0.05, 1.1, -0.05], blue: [-0.05, -0.05, 1.1], monochrome: false }])],
  }, opsInputPro),
  docCase("rgb_mixer: scene-referred linear keeps headroom", {
    layers: [layer([{ type: "rgb_mixer", red: [0.9, 0.2, -0.1], green: [0.1, 0.8, 0.1], blue: [0, 0, 1], monochrome: false }])],
  }, hdrInput, 5e-4),
  docCase("rgb_mixer: stacked with exposure under color blend", {
    layers: [layer([
      { type: "exposure", ev: 0.4 },
      { type: "rgb_mixer", red: [1, 0.15, 0], green: [0, 1, 0], blue: [0, 0.1, 0.9], monochrome: false },
    ], { blend: "color", opacity: 0.7 })],
  }, opsInput),
];

writeFileSync(
  new URL("../crates/hgripe-grade/goldens/ops_mixer.json", import.meta.url),
  JSON.stringify({ kind: "doc", cases: mixerCases }, null, 2) + "\n",
);
console.log(`wrote ${mixerCases.length} mixer cases`);
