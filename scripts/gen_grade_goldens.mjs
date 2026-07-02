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

function composite(backdrop, source, mode, opacity, mask) {
  const out = backdrop.data.slice();
  const n = backdrop.w * backdrop.h;
  for (let px = 0; px < n; px++) {
    const i = px * 4;
    const gate = mask ? clamp01(mask[px]) : 1;
    const sa = clamp01(source.data[i + 3]) * clamp01(opacity) * gate;
    const ba = clamp01(backdrop.data[i + 3]);
    const oa = sa + ba * (1 - sa);
    for (let c = 0; c < 3; c++) {
      const cb = clamp01(backdrop.data[i + c]);
      const cs = clamp01(source.data[i + c]);
      out[i + c] = oa === 0 ? 0 : (sa * (1 - ba) * cs + sa * ba * blend(mode, cb, cs) + (1 - sa) * ba * cb) / oa;
    }
    out[i + 3] = oa;
  }
  return out;
}

// ---- G2 op maths (float64 spec mirrors of crates/hgripe-grade/src/ops.rs) ----

const trcDecode = (space, c) =>
  space === "srgb"
    ? c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    : c < 0.03125 ? c / 16 : Math.pow(c, 1.8);
const trcEncode = (space, l) => {
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
  for (let px = 0; px < surface.w * surface.h; px++) {
    const i = px * 4;
    const rgb = [0, 1, 2].map((c) => trcDecode(surface.space, clamp01(surface.data[i + c])));
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
  }
}

function applyDoc(doc, input) {
  const surface = { ...input, data: input.data.slice() };
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const graded = { ...surface, data: surface.data.slice() };
    for (const op of layer.ops) applyOp(graded, op);
    const out = composite({ ...surface }, graded, layer.blend, layer.opacity, layer.mask);
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
for (const mode of MODES) {
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
