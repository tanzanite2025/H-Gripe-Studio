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
  JSON.stringify({ cases }, null, 2) + "\n",
);
console.log(`wrote ${cases.length} cases`);
