// Front-end, best-effort mask morphology on a downscaled proxy buffer.
//
// The Mask-Edit modal records morphology as *intent* (`MaskOperation` entries)
// and the Rust backend rasterises the authoritative result on run — see the
// note on `MaskOperation` in `types/production.ts` about not re-implementing the
// exact Rust morphology so stored state can't drift. This module is deliberately
// the OTHER thing: a cheap, approximate **preview** of grow / shrink / feather /
// smooth on a small proxy alpha buffer, so a slider drag can show roughly what
// the op will do without a backend round-trip. It is the `preview` lane from
// `docs/cards/editor-resource-model.md` (§ "Four lanes") — advisory only, never
// committed. Nothing here is written back onto the node.
//
// Everything is pure (no canvas / DOM) so the geometry is unit-testable; the
// modal wraps a proxy build + `applyOp` in `PreviewLane` for latest-wins drags
// and does the canvas rasterisation of the result overlay separately.

import type {
  BrushStroke,
  EditOp,
  EditPath,
  LayerAdjustment,
  MaskDocument,
  MaskLayer,
  MaskOperation,
} from "../types/production";
import { isBrushOp, isPathOp } from "../types/production";

/** A single-channel alpha buffer (0..255), row-major `w * h`. */
export interface ProxyMask {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Morphology / filter op ids this module can preview (the amount-taking ones). */
export const PREVIEWABLE_OP_IDS = ["grow", "shrink", "feather", "smooth", "blur", "sharpen"] as const;
export type PreviewableOpId = (typeof PREVIEWABLE_OP_IDS)[number];

export function isPreviewableOp(id: string): id is PreviewableOpId {
  return (PREVIEWABLE_OP_IDS as readonly string[]).includes(id);
}

export function createProxyMask(w: number, h: number): ProxyMask {
  return { w: Math.max(1, w | 0), h: Math.max(1, h | 0), data: new Uint8Array(Math.max(1, w | 0) * Math.max(1, h | 0)) };
}

function cloneMask(mask: ProxyMask): ProxyMask {
  return { w: mask.w, h: mask.h, data: new Uint8Array(mask.data) };
}

const at = (mask: ProxyMask, x: number, y: number): number => mask.data[y * mask.w + x];

/** Stamp a filled disc of `value` (clamped to the buffer) centred at cx,cy. */
export function stampDisc(mask: ProxyMask, cx: number, cy: number, radius: number, value: number): void {
  const r = Math.max(0, radius);
  const r2 = (r + 0.5) * (r + 0.5);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) mask.data[y * mask.w + x] = value;
    }
  }
}

/**
 * Stamp a soft disc: full coverage inside `hardness * r`, falling linearly to
 * 0 at the rim, capped by `flow`. `subtract` multiplies the mask down by the
 * coverage; `add` max-composites it up (mirrors the Rust soft stamp).
 */
export function stampSoftDisc(
  mask: ProxyMask,
  cx: number,
  cy: number,
  radius: number,
  hardness: number,
  flow: number,
  subtract: boolean,
): void {
  const r = Math.max(0.5, radius);
  const hard = clamp(hardness, 0, 1) * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const falloff = d <= hard ? 1 : (r - d) / Math.max(r - hard, 1e-6);
      const cov = clamp(flow, 0, 1) * falloff;
      const idx = y * mask.w + x;
      const v = mask.data[idx];
      mask.data[idx] = subtract
        ? Math.round(v * (1 - cov))
        : Math.max(v, Math.round(cov * 255));
    }
  }
}

const isSoft = (s: BrushStroke): boolean => (s.hardness ?? 1) < 1 || (s.flow ?? 1) < 1;

/** Stamp discs along a polyline so a brush stroke reads as a continuous band. */
function stampStroke(mask: ProxyMask, stroke: BrushStroke, scale: number): void {
  const soft = isSoft(stroke);
  const value = stroke.mode === "subtract" ? 0 : 255;
  const radius = Math.max(1, Math.round(stroke.radius * scale));
  const hardness = clamp(stroke.hardness ?? 1, 0, 1);
  const flow = clamp(stroke.flow ?? 1, 0, 1);
  // Soft stamps step at the recorded spacing (fraction of the diameter);
  // hard stamps keep the legacy half-radius step.
  const step = soft
    ? Math.max(1, clamp(stroke.spacing ?? 0.25, 0.01, 1) * radius * 2)
    : Math.max(1, radius / 2);
  const stamp = (x: number, y: number) =>
    soft
      ? stampSoftDisc(mask, x, y, radius, hardness, flow, stroke.mode === "subtract")
      : stampDisc(mask, x, y, radius, value);
  const pts = stroke.points;
  if (pts.length === 0) return;
  if (pts.length === 1) {
    stamp(pts[0][0] * scale, pts[0][1] * scale);
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const x0 = ax * scale;
    const y0 = ay * scale;
    const x1 = bx * scale;
    const y1 = by * scale;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let s = 0; s <= steps; s++) {
      const tt = s / steps;
      stamp(x0 + (x1 - x0) * tt, y0 + (y1 - y0) * tt);
    }
  }
}

/** Fill a marquee `rect` / `ellipse` region (image-space `[x1,y1,x2,y2]`). */
function fillMarquee(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const region = op.region;
  if (!region || region.length < 4) return;
  const x1 = Math.min(region[0], region[2]) * scale;
  const y1 = Math.min(region[1], region[3]) * scale;
  const x2 = Math.max(region[0], region[2]) * scale;
  const y2 = Math.max(region[1], region[3]) * scale;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.max(0.5, (x2 - x1) / 2);
  const ry = Math.max(0.5, (y2 - y1) / 2);
  const px0 = Math.max(0, Math.floor(x1));
  const px1 = Math.min(mask.w - 1, Math.ceil(x2));
  const py0 = Math.max(0, Math.floor(y1));
  const py1 = Math.min(mask.h - 1, Math.ceil(y2));
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      if (op.type === "ellipse") {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) mask.data[y * mask.w + x] = 255;
      } else {
        mask.data[y * mask.w + x] = 255;
      }
    }
  }
}

/**
 * Composite a linear gradient ramp (M10): full selection at the drag start
 * fading to none at the end (image-space `region: [x1,y1,x2,y2]`). `add`
 * unions the ramp into the mask; `subtract` cuts it away. Mirrors the Rust
 * `fill_gradient`.
 */
function fillGradient(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const region = op.region;
  if (!region || region.length < 4) return;
  const ax = region[0] * scale;
  const ay = region[1] * scale;
  const dx = region[2] * scale - ax;
  const dy = region[3] * scale - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return;
  const subtract = op.mode === "subtract";
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const t = Math.min(Math.max(((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2, 0), 1);
      const ramp = Math.round(255 * (1 - t));
      const i = y * mask.w + x;
      mask.data[i] = subtract ? Math.max(mask.data[i] - ramp, 0) : Math.max(mask.data[i], ramp);
    }
  }
}

/**
 * Flood the whole layer at an opacity (M11 fill dialog): `add` lerps every
 * pixel toward 255 by `amount`% coverage, `subtract` scales it down by the
 * same coverage. At 100% these are select-all / delete, but recorded as a
 * revisable `fill` step. Mirrors the Rust `fill_coverage`.
 */
function fillCoverage(mask: ProxyMask, op: MaskOperation): void {
  const a = clamp((op.amount ?? 100) / 100, 0, 1);
  const subtract = op.mode === "subtract";
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i];
    mask.data[i] = subtract ? Math.round(v * (1 - a)) : Math.round(v + (255 - v) * a);
  }
}

/**
 * Spot-heal (PS J on a mask): rebuild the mask under a painted stroke from
 * its surroundings by diffusion — iterative 4-neighbour averaging inside the
 * stroke coverage with the boundary held fixed, converging toward the
 * harmonic (smooth) fill. Alternating forward / backward Gauss-Seidel sweeps
 * over the coverage bounding box; iterations scale with the region size under
 * a fixed work budget. Mirrors the Rust `heal_region`.
 */
export function healStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "heal", mode: "add", radius, points }, scale);
  diffuseCoverage(mask, coverage);
}

// The heal diffusion itself: rebuild the mask inside `coverage` from its
// surroundings by iterative 4-neighbour averaging with the boundary held
// fixed (shared by the heal stroke and the content-aware move's hole fill).
function diffuseCoverage(mask: ProxyMask, coverage: ProxyMask): void {
  // Coverage bounding box (also counts the region's pixels for the budget).
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (coverage.data[y * mask.w + x] === 0) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return;
  // Diffusion converges in ~O(d²) sweeps for a region d pixels across;
  // clamped, and capped by a fixed total work budget for huge regions.
  const maxDim = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const iters = Math.max(Math.min(maxDim * maxDim, 512, Math.ceil(4e8 / Math.max(area, 1))), 16);
  const buf = Float32Array.from(mask.data);
  const relax = (x: number, y: number) => {
    const i = y * mask.w + x;
    if (coverage.data[i] === 0) return;
    const left = x > 0 ? buf[i - 1] : buf[i];
    const right = x < mask.w - 1 ? buf[i + 1] : buf[i];
    const up = y > 0 ? buf[i - mask.w] : buf[i];
    const down = y < mask.h - 1 ? buf[i + mask.w] : buf[i];
    buf[i] = (left + right + up + down) / 4;
  };
  for (let it = 0; it < iters; it++) {
    if (it % 2 === 0) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) relax(x, y);
    } else {
      for (let y = y1; y >= y0; y--) for (let x = x1; x >= x0; x--) relax(x, y);
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * mask.w + x;
      if (coverage.data[i] !== 0) mask.data[i] = Math.round(Math.min(Math.max(buf[i], 0), 255));
    }
  }
}

/**
 * Clone stamp (PS S on a mask): copy the mask into a painted stroke from the
 * `dx`/`dy` source offset — each covered pixel `p` reads the pre-op mask at
 * `p + [dx, dy]` (out-of-bounds reads as empty). Mirrors the Rust
 * `clone_region`.
 */
export function cloneStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const dx = Math.round((op.dx ?? 0) * scale);
  const dy = Math.round((op.dy ?? 0) * scale);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "clone", mode: "add", radius, points }, scale);
  const base = Uint8Array.from(mask.data);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const i = y * mask.w + x;
      if (coverage.data[i] === 0) continue;
      const sx = x + dx;
      const sy = y + dy;
      mask.data[i] = sx >= 0 && sx < mask.w && sy >= 0 && sy < mask.h ? base[sy * mask.w + sx] : 0;
    }
  }
}

/**
 * History brush (PS Y on a mask): restore a painted stroke to the layer's
 * initial state — `base` is the mask as it was before any edit steps of the
 * stack replayed. Mirrors the Rust `history_region`.
 */
export function historyStroke(mask: ProxyMask, base: Uint8Array, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "history_brush", mode: "add", radius, points }, scale);
  for (let i = 0; i < mask.data.length; i++) {
    if (coverage.data[i] !== 0) mask.data[i] = base[i];
  }
}

// Per-stroke exposure of the dodge / burn tool: each pass moves the covered
// pixels half-way toward on (dodge) or off (burn).
const DODGE_BURN_EXPOSURE = 0.5;

/**
 * Dodge / burn (PS O on a mask): locally lighten (`mode: "dodge"`) or darken
 * (`mode: "burn"`) the mask under a painted stroke — each covered pixel is
 * lerped toward 255 / 0 by the fixed exposure. Mirrors the Rust
 * `dodge_burn_region`.
 */
export function dodgeBurnStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const burn = op.mode === "burn";
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "dodge_burn", mode: "add", radius, points }, scale);
  for (let i = 0; i < mask.data.length; i++) {
    if (coverage.data[i] === 0) continue;
    const v = mask.data[i];
    mask.data[i] = Math.round(burn ? v * (1 - DODGE_BURN_EXPOSURE) : v + (255 - v) * DODGE_BURN_EXPOSURE);
  }
}

// Per-stroke exposure of the sponge tool: each pass moves the covered pixels
// half-way toward hard on/off (saturate) or toward mid-grey (desaturate).
const SPONGE_EXPOSURE = 0.5;

/**
 * Sponge (PS O flyout, on a mask): locally push the mask's soft values toward
 * hard on/off (`mode: "saturate"`) or toward mid-grey (`mode: "desaturate"`)
 * under a painted stroke. Mirrors the Rust `sponge_region`.
 */
export function spongeStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const desaturate = op.mode === "desaturate";
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "sponge", mode: "add", radius, points }, scale);
  for (let i = 0; i < mask.data.length; i++) {
    if (coverage.data[i] === 0) continue;
    const v = mask.data[i];
    mask.data[i] = Math.round(
      desaturate
        ? v + (128 - v) * SPONGE_EXPOSURE
        : v >= 128
          ? v + (255 - v) * SPONGE_EXPOSURE
          : v * (1 - SPONGE_EXPOSURE),
    );
  }
}

/**
 * Healing brush (PS J flyout, on a mask): copy the mask into a painted stroke
 * from the `dx`/`dy` source offset like the clone stamp, but blend through a
 * feathered coverage so the patch's edges melt into the surroundings.
 * Mirrors the Rust `healing_brush_region`.
 */
export function healingBrushStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const dx = Math.round((op.dx ?? 0) * scale);
  const dy = Math.round((op.dy ?? 0) * scale);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "healing_brush", mode: "add", radius, points }, scale);
  const soft = boxBlur(coverage, Math.max(1, Math.round((radius * scale) / 2)));
  const base = Uint8Array.from(mask.data);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const i = y * mask.w + x;
      const w = soft.data[i] / 255;
      if (w === 0) continue;
      const sx = x + dx;
      const sy = y + dy;
      const cloned = sx >= 0 && sx < mask.w && sy >= 0 && sy < mask.h ? base[sy * mask.w + sx] : 0;
      mask.data[i] = Math.round(base[i] * (1 - w) + cloned * w);
    }
  }
}

/** Clear the mask outside a `crop` region (image-space `[x1,y1,x2,y2]`). */
function cropMask(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const region = op.region;
  if (!region || region.length < 4) return;
  const x1 = Math.min(region[0], region[2]) * scale;
  const y1 = Math.min(region[1], region[3]) * scale;
  const x2 = Math.max(region[0], region[2]) * scale;
  const y2 = Math.max(region[1], region[3]) * scale;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (x + 0.5 < x1 || x + 0.5 > x2 || y + 0.5 < y1 || y + 0.5 > y2) mask.data[y * mask.w + x] = 0;
    }
  }
}

/**
 * Move / scale / rotate the mask about the buffer centre (M5 free transform).
 * Inverse-mapped nearest-neighbour sampling; pixels mapping outside the
 * source read as 0. `dx`/`dy` are in the mask's own pixel space; `rotate` in
 * degrees clockwise; `scale` a uniform factor. Mirrors the Rust
 * `transform_mask`.
 */
export function transformMask(mask: ProxyMask, dx: number, dy: number, scale: number, rotate: number): ProxyMask {
  const out = createProxyMask(mask.w, mask.h);
  const s = scale > 1e-6 ? scale : 1e-6;
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = mask.w / 2;
  const cy = mask.h / 2;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      // Invert: un-translate, un-rotate, un-scale about the centre.
      const tx = x + 0.5 - dx - cx;
      const ty = y + 0.5 - dy - cy;
      const rx = (tx * cos + ty * sin) / s + cx;
      const ry = (-tx * sin + ty * cos) / s + cy;
      const sx = Math.floor(rx);
      const sy = Math.floor(ry);
      if (sx < 0 || sy < 0 || sx >= mask.w || sy >= mask.h) continue;
      out.data[y * mask.w + x] = mask.data[sy * mask.w + sx];
    }
  }
  return out;
}

/** Disc-kernel max filter (grayscale dilation) — grows the mask by `radius` px. */
export function dilate(mask: ProxyMask, radius: number): ProxyMask {
  return rankFilter(mask, radius, true);
}

/** Disc-kernel min filter (grayscale erosion) — shrinks the mask by `radius` px. */
export function erode(mask: ProxyMask, radius: number): ProxyMask {
  return rankFilter(mask, radius, false);
}

function rankFilter(mask: ProxyMask, radius: number, wantMax: boolean): ProxyMask {
  const r = Math.round(radius);
  if (r <= 0) return cloneMask(mask);
  // Precompute the disc offsets once.
  const offsets: [number, number][] = [];
  const r2 = (r + 0.25) * (r + 0.25);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }
  const out = createProxyMask(mask.w, mask.h);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      let best = wantMax ? 0 : 255;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mask.w || ny >= mask.h) continue;
        const v = at(mask, nx, ny);
        if (wantMax ? v > best : v < best) best = v;
      }
      out.data[y * mask.w + x] = best;
    }
  }
  return out;
}

/** Separable box blur (one pass) — a cheap gaussian-ish feather of the edge. */
function boxBlur(mask: ProxyMask, radius: number): ProxyMask {
  const r = Math.round(radius);
  if (r <= 0) return cloneMask(mask);
  const tmp = createProxyMask(mask.w, mask.h);
  const win = 2 * r + 1;
  // Horizontal pass.
  for (let y = 0; y < mask.h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += at(mask, clamp(x, 0, mask.w - 1), y);
    for (let x = 0; x < mask.w; x++) {
      tmp.data[y * mask.w + x] = Math.round(sum / win);
      const outX = clamp(x - r, 0, mask.w - 1);
      const inX = clamp(x + r + 1, 0, mask.w - 1);
      sum += at(mask, inX, y) - at(mask, outX, y);
    }
  }
  // Vertical pass.
  const out = createProxyMask(mask.w, mask.h);
  for (let x = 0; x < mask.w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp.data[clamp(y, 0, tmp.h - 1) * tmp.w + x];
    for (let y = 0; y < mask.h; y++) {
      out.data[y * mask.w + x] = Math.round(sum / win);
      const outY = clamp(y - r, 0, mask.h - 1);
      const inY = clamp(y + r + 1, 0, mask.h - 1);
      sum += tmp.data[inY * tmp.w + x] - tmp.data[outY * tmp.w + x];
    }
  }
  return out;
}

/** Feather = two box-blur passes (a smoother, gaussian-like soft edge). */
export function feather(mask: ProxyMask, radius: number): ProxyMask {
  if (radius <= 0) return cloneMask(mask);
  return boxBlur(boxBlur(mask, radius), radius);
}

/**
 * Unsharp-mask sharpen: `out = clamp(v + (v − blur(v)))` — boosts the mask
 * edge by its own high-frequency detail. `radius` is the blur radius in px.
 */
export function sharpen(mask: ProxyMask, radius: number): ProxyMask {
  if (radius <= 0) return cloneMask(mask);
  const blurred = feather(mask, radius);
  const out = createProxyMask(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i++) {
    out.data[i] = clamp(2 * mask.data[i] - blurred.data[i], 0, 255);
  }
  return out;
}

/** Morphological open (erode→dilate) then close (dilate→erode): despeckle + fill nicks. */
export function smooth(mask: ProxyMask, radius: number): ProxyMask {
  const r = Math.max(1, Math.round(radius));
  const opened = dilate(erode(mask, r), r);
  return erode(dilate(opened, r), r);
}

/** Invert the whole mask (255 - v). */
export function invert(mask: ProxyMask): ProxyMask {
  const out = createProxyMask(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i++) out.data[i] = 255 - mask.data[i];
  return out;
}

/**
 * Fill interior holes: threshold at 128, flood-fill "outside" from the border,
 * then any background pixel the flood never reached is an enclosed hole → 255.
 */
export function fillHoles(mask: ProxyMask): ProxyMask {
  const { w, h } = mask;
  const bg = new Uint8Array(w * h); // 1 where thresholded background
  for (let i = 0; i < mask.data.length; i++) bg[i] = mask.data[i] < 128 ? 1 : 0;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (bg[idx] && !outside[idx]) {
      outside[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx / w) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  const out = cloneMask(mask);
  for (let i = 0; i < out.data.length; i++) {
    if (bg[i] && !outside[i]) out.data[i] = 255; // enclosed hole
  }
  return out;
}

/**
 * Apply one recorded op to the proxy mask. `radius` is already in *proxy*
 * pixels (the modal scales the image-space `amount` by the proxy ratio).
 * `wand` needs the real image and is a no-op on the proxy.
 */
export function applyOp(mask: ProxyMask, type: string, radius: number): ProxyMask {
  switch (type) {
    case "grow":
      return dilate(mask, radius);
    case "shrink":
      return erode(mask, radius);
    case "feather":
    case "blur":
      return feather(mask, radius);
    case "sharpen":
      return sharpen(mask, radius);
    case "smooth":
      return smooth(mask, radius);
    case "invert":
      return invert(mask);
    case "fill_holes":
      return fillHoles(mask);
    case "select_all":
      return { w: mask.w, h: mask.h, data: new Uint8Array(mask.w * mask.h).fill(255) };
    case "delete":
      return { w: mask.w, h: mask.h, data: new Uint8Array(mask.w * mask.h) };
    default:
      return cloneMask(mask); // wand / rect / ellipse handled elsewhere or need pixels
  }
}

export interface ProxyBuildOptions {
  /** Target proxy width in px (height derives from the image aspect). */
  proxyWidth?: number;
  /**
   * Optional persistent cache (M7). When provided, per-layer surfaces are
   * reused across builds (exact / ops-prefix hits) and the composite is
   * recomputed for dirty tiles only. Output is byte-identical to an
   * uncached build.
   */
  cache?: ProxyLayerCache;
}

const DEFAULT_PROXY_WIDTH = 320;

// Feathered edge (image px) of the patch tool's blend into the surroundings.
const PATCH_FEATHER = 4;

/**
 * Patch (PS J flyout, on a mask): the lassoed polygon is refilled from the
 * `dx`/`dy` drop offset, blended through a feathered coverage like the
 * healing brush. Mirrors the Rust `patch_region`.
 */
export function patchRegion(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length < 3) return;
  const dx = Math.round((op.dx ?? 0) * scale);
  const dy = Math.round((op.dy ?? 0) * scale);
  const coverage = createProxyMask(mask.w, mask.h);
  fillPath(
    coverage,
    { id: "patch", mode: "add", tool: "patch", closed: true, points: points.map(([x, y]) => ({ x, y })) },
    scale,
  );
  const soft = boxBlur(coverage, Math.max(1, Math.round(PATCH_FEATHER * scale)));
  const base = Uint8Array.from(mask.data);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const i = y * mask.w + x;
      const w = soft.data[i] / 255;
      if (w === 0) continue;
      const sx = x + dx;
      const sy = y + dy;
      const cloned = sx >= 0 && sx < mask.w && sy >= 0 && sy < mask.h ? base[sy * mask.w + sx] : 0;
      mask.data[i] = Math.round(base[i] * (1 - w) + cloned * w);
    }
  }
}

/**
 * Content-aware move (PS J flyout, on a mask): the lassoed polygon moves by
 * `dx`/`dy` — its values blend into the destination through a feathered
 * coverage — and the hole behind it is healed from its surroundings by the
 * same diffusion the heal tool uses. Mirrors the Rust
 * `content_aware_move_region`.
 */
export function contentAwareMove(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length < 3) return;
  const dx = Math.round((op.dx ?? 0) * scale);
  const dy = Math.round((op.dy ?? 0) * scale);
  const coverage = createProxyMask(mask.w, mask.h);
  fillPath(
    coverage,
    { id: "content_aware_move", mode: "add", tool: "content_aware_move", closed: true, points: points.map(([x, y]) => ({ x, y })) },
    scale,
  );
  const soft = boxBlur(coverage, Math.max(1, Math.round(PATCH_FEATHER * scale)));
  const base = Uint8Array.from(mask.data);
  diffuseCoverage(mask, coverage);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sx >= mask.w || sy < 0 || sy >= mask.h) continue;
      const i = sy * mask.w + sx;
      const w = soft.data[i] / 255;
      if (w === 0) continue;
      const o = y * mask.w + x;
      mask.data[o] = Math.round(mask.data[o] * (1 - w) + base[i] * w);
    }
  }
}

// Cell size (image px) of the pattern stamp's checkerboard.
const PATTERN_CELL = 8;

/**
 * Pattern stamp (PS S flyout, on a mask): paint the repeating checker
 * pattern into the stroke coverage — covered pixels read the pattern value
 * at their image-space cell. Mirrors the Rust `pattern_stamp_region`.
 */
export function patternStampStroke(mask: ProxyMask, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "pattern_stamp", mode: "add", radius, points }, scale);
  const cell = Math.max(1, PATTERN_CELL * scale);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const i = y * mask.w + x;
      if (coverage.data[i] === 0) continue;
      mask.data[i] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 0;
    }
  }
}

/**
 * Art history brush (PS Y flyout, on a mask): restore the stroke coverage to
 * the layer's initial state through a deterministic per-pixel jitter — each
 * covered pixel reads `base` at a hashed offset within half the brush
 * radius, giving the stylised smeared look. Mirrors the Rust
 * `art_history_region`.
 */
export function artHistoryStroke(mask: ProxyMask, base: Uint8Array, op: MaskOperation, scale: number): void {
  const points = op.points;
  if (!points || points.length === 0) return;
  const radius = Math.max(1, op.amount ?? 8);
  const coverage = createProxyMask(mask.w, mask.h);
  stampStroke(coverage, { id: "art_history_brush", mode: "add", radius, points }, scale);
  const amp = Math.max(1, Math.round((radius * scale) / 2));
  const span = 2 * amp + 1;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const i = y * mask.w + x;
      if (coverage.data[i] === 0) continue;
      const h = (x * 374761393 + y * 668265263) % 4294967296;
      const sx = clamp(x + (((h / 8) | 0) % span) - amp, 0, mask.w - 1);
      const sy = clamp(y + (((h / 131072) | 0) % span) - amp, 0, mask.h - 1);
      mask.data[i] = base[sy * mask.w + sx];
    }
  }
}

/**
 * Homography coefficients mapping the unit square onto the quad
 * `[p00, p10, p11, p01]` (TL, TR, BR, BL):
 * `X = (a·u + b·v + c) / (g·u + h·v + 1)`, same for `Y` with `d, e, f`.
 * Degenerate quads fall back to the affine map (`g = h = 0`).
 */
export function quadHomography(quad: readonly (readonly [number, number])[]): number[] {
  const [p00, p10, p11, p01] = quad;
  const sx = p00[0] - p10[0] + p11[0] - p01[0];
  const sy = p00[1] - p10[1] + p11[1] - p01[1];
  const d1x = p10[0] - p11[0];
  const d1y = p10[1] - p11[1];
  const d2x = p01[0] - p11[0];
  const d2y = p01[1] - p11[1];
  const den = d1x * d2y - d1y * d2x;
  let g = 0;
  let h = 0;
  if ((sx !== 0 || sy !== 0) && Math.abs(den) > 1e-9) {
    g = (sx * d2y - sy * d2x) / den;
    h = (d1x * sy - sx * d1y) / den;
  }
  const a = p10[0] - p00[0] + g * p10[0];
  const b = p01[0] - p00[0] + h * p01[0];
  const c = p00[0];
  const d = p10[1] - p00[1] + g * p10[1];
  const e = p01[1] - p00[1] + h * p01[1];
  const f = p00[1];
  return [a, b, c, d, e, f, g, h];
}

/**
 * Perspective crop (PS C flyout, on a mask): straighten the quad
 * `region: [x0,y0, x1,y1, x2,y2, x3,y3]` (TL, TR, BR, BL image-space) into
 * its bounding rectangle — each rect pixel inverse-maps through the
 * rect→quad homography (nearest-neighbour), everything outside the rect is
 * cleared. Mirrors the Rust `perspective_crop_mask`.
 */
export function perspectiveCrop(mask: ProxyMask, op: MaskOperation, scale: number): ProxyMask {
  const q = op.region;
  if (!q || q.length < 8) return mask;
  const quad: [number, number][] = [0, 1, 2, 3].map((i) => [q[i * 2] * scale, q[i * 2 + 1] * scale]);
  const bx1 = Math.min(quad[0][0], quad[1][0], quad[2][0], quad[3][0]);
  const by1 = Math.min(quad[0][1], quad[1][1], quad[2][1], quad[3][1]);
  const bx2 = Math.max(quad[0][0], quad[1][0], quad[2][0], quad[3][0]);
  const by2 = Math.max(quad[0][1], quad[1][1], quad[2][1], quad[3][1]);
  const bw = Math.max(bx2 - bx1, 1e-6);
  const bh = Math.max(by2 - by1, 1e-6);
  const [a, b, c, d, e, f, g, h] = quadHomography(quad);
  const out = createProxyMask(mask.w, mask.h);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (cx < bx1 || cx > bx2 || cy < by1 || cy > by2) continue;
      const u = (cx - bx1) / bw;
      const v = (cy - by1) / bh;
      const den = g * u + h * v + 1;
      if (Math.abs(den) < 1e-9) continue;
      const sx = Math.floor((a * u + b * v + c) / den);
      const sy = Math.floor((d * u + e * v + f) / den);
      if (sx < 0 || sy < 0 || sx >= mask.w || sy >= mask.h) continue;
      out.data[y * mask.w + x] = mask.data[sy * mask.w + sx];
    }
  }
  return out;
}

/**
 * Rasterise one committed pen / lasso path onto the proxy: flatten the anchor
 * loop to a straight-edged polygon (proxy resolution makes bezier flattening
 * unnecessary), even-odd scanline fill, then boolean-combine per `mode`.
 */
function fillPath(mask: ProxyMask, path: EditPath, scale: number): void {
  if (path.points.length < 3) return;
  const poly = path.points.map((p) => [p.x * scale, p.y * scale] as const);
  const { w, h } = mask;
  for (let y = 0; y < h; y++) {
    const scan = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      if (y0 <= scan === y1 <= scan) continue;
      crossings.push(x0 + ((scan - y0) / (y1 - y0)) * (x1 - x0));
    }
    crossings.sort((a, b) => a - b);
    const inside = new Uint8Array(w);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const start = Math.max(0, Math.round(crossings[i]));
      const end = Math.min(w - 1, Math.round(crossings[i + 1]) - 1);
      for (let x = start; x <= end; x++) inside[x] = 1;
    }
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (path.mode === "intersect") {
        if (!inside[x]) mask.data[idx] = 0;
      } else if (inside[x]) {
        mask.data[idx] = path.mode === "subtract" ? 0 : 255;
      }
    }
  }
}

/**
 * Confine a replayed step to its recorded marquee selection (PS selection
 * semantics): pixels outside the `clip` region are restored from the
 * pre-step mask. Mirrors the Rust `restore_outside_clip`.
 */
function restoreOutsideClip(mask: ProxyMask, before: ProxyMask, clip: NonNullable<EditOp["clip"]>, scale: number): void {
  const [rx1, ry1, rx2, ry2] = clip.region;
  const x1 = Math.min(rx1, rx2) * scale;
  const y1 = Math.min(ry1, ry2) * scale;
  const x2 = Math.max(rx1, rx2) * scale;
  const y2 = Math.max(ry1, ry2) * scale;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.max(0.5, (x2 - x1) / 2);
  const ry = Math.max(0.5, (y2 - y1) / 2);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = px >= x1 && px <= x2 && py >= y1 && py <= y2;
      if (inside && clip.ellipse) {
        const nx = (px - cx) / rx;
        const ny = (py - cy) / ry;
        inside = nx * nx + ny * ny <= 1;
      }
      if (!inside) mask.data[y * mask.w + x] = before.data[y * mask.w + x];
    }
  }
}

// Replay one layer's ordered edit stack onto (a copy of) `mask`.
function replayOps(mask: ProxyMask, ops: EditOp[], scale: number): ProxyMask {
  // The layer's pre-edit state, the history brush's restore source (only
  // snapshotted when the stack contains a `history_brush` step).
  const base = ops.some(
    (op) => !isPathOp(op) && !isBrushOp(op) && (op.type === "history_brush" || op.type === "art_history_brush"),
  )
    ? Uint8Array.from(mask.data)
    : null;
  for (const op of ops) {
    const before = !op.disabled && op.clip ? cloneMask(mask) : null;
    if (op.disabled) {
      // Disabled history steps stay recorded but are skipped on replay.
    } else if (isPathOp(op)) {
      fillPath(mask, op, scale);
    } else if (isBrushOp(op)) {
      stampStroke(mask, op, scale);
    } else if (op.type === "rect" || op.type === "ellipse") {
      fillMarquee(mask, op, scale);
    } else if (op.type === "gradient") {
      fillGradient(mask, op, scale);
    } else if (op.type === "fill") {
      // The amount is an opacity (%), not a px radius — no proxy scaling.
      fillCoverage(mask, op);
    } else if (op.type === "heal") {
      healStroke(mask, op, scale);
    } else if (op.type === "clone") {
      cloneStroke(mask, op, scale);
    } else if (op.type === "history_brush") {
      if (base) historyStroke(mask, base, op, scale);
    } else if (op.type === "art_history_brush") {
      if (base) artHistoryStroke(mask, base, op, scale);
    } else if (op.type === "dodge_burn") {
      dodgeBurnStroke(mask, op, scale);
    } else if (op.type === "sponge") {
      spongeStroke(mask, op, scale);
    } else if (op.type === "healing_brush") {
      healingBrushStroke(mask, op, scale);
    } else if (op.type === "patch") {
      patchRegion(mask, op, scale);
    } else if (op.type === "content_aware_move") {
      contentAwareMove(mask, op, scale);
    } else if (op.type === "pattern_stamp") {
      patternStampStroke(mask, op, scale);
    } else if (op.type === "crop") {
      cropMask(mask, op, scale);
    } else if (op.type === "perspective_crop") {
      mask = perspectiveCrop(mask, op, scale);
    } else if (op.type === "transform") {
      mask = transformMask(mask, (op.dx ?? 0) * scale, (op.dy ?? 0) * scale, op.scale ?? 1, op.rotate ?? 0);
    } else if (op.type === "wand" || op.type === "quick_select" || op.type === "background_eraser" || op.type === "red_eye" || op.type === "object_select" || op.type === "remove") {
      // Need the real image; not previewable on the proxy.
    } else {
      const radius = op.amount != null ? Math.round(op.amount * scale) : 0;
      mask = applyOp(mask, op.type, radius);
    }
    if (before && op.clip) restoreOutsideClip(mask, before, op.clip, scale);
  }
  return mask;
}

/**
 * Build the 256-entry LUT an adjustment layer's tone map resolves to (M6).
 * Identity when the params are all at their defaults. Mirrors the Rust
 * `adjustment_lut` in `subject_mask.rs` exactly, so the proxy preview and
 * the run cannot drift.
 */
export function adjustmentLut(adj: LayerAdjustment): Uint8Array {
  const lut = new Uint8Array(256);
  if (adj.type === "levels") {
    const inBlack = clamp(adj.in_black ?? 0, 0, 255);
    const inWhite = clamp(adj.in_white ?? 255, 0, 255);
    const gamma = Math.max(adj.gamma ?? 1, 1e-6);
    const outBlack = clamp(adj.out_black ?? 0, 0, 255);
    const outWhite = clamp(adj.out_white ?? 255, 0, 255);
    const span = Math.max(inWhite - inBlack, 1e-6);
    for (let v = 0; v < 256; v++) {
      const t = Math.pow(clamp((v - inBlack) / span, 0, 1), 1 / gamma);
      lut[v] = Math.round(clamp(outBlack + t * (outWhite - outBlack), 0, 255));
    }
  } else if (adj.type === "curve") {
    const pts = [...(adj.points ?? [])]
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .sort((a, b) => a[0] - b[0]);
    for (let v = 0; v < 256; v++) {
      if (pts.length < 2) {
        lut[v] = v;
        continue;
      }
      if (v <= pts[0][0]) {
        lut[v] = Math.round(clamp(pts[0][1], 0, 255));
        continue;
      }
      if (v >= pts[pts.length - 1][0]) {
        lut[v] = Math.round(clamp(pts[pts.length - 1][1], 0, 255));
        continue;
      }
      let i = 1;
      while (pts[i][0] < v) i++;
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = (v - x0) / Math.max(x1 - x0, 1e-6);
      lut[v] = Math.round(clamp(y0 + t * (y1 - y0), 0, 255));
    }
  } else {
    // brightness_contrast: scale about the midpoint, then shift.
    const brightness = (clamp(adj.brightness ?? 0, -100, 100) / 100) * 255;
    const slope = 1 + clamp(adj.contrast ?? 0, -100, 100) / 100;
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.round(clamp((v - 127.5) * slope + 127.5 + brightness, 0, 255));
    }
  }
  return lut;
}

// Apply an adjustment layer's LUT to the composite in place, lerped by the
// layer opacity (mirrors the Rust `apply_adjustment`).
function applyAdjustment(dst: ProxyMask, adj: LayerAdjustment, opacity: number): void {
  const lut = adjustmentLut(adj);
  const a = clamp(opacity, 0, 1);
  for (let i = 0; i < dst.data.length; i++) {
    const d = dst.data[i];
    dst.data[i] = Math.round(d + (lut[d] - d) * a);
  }
}

// One blended sample per the layer blend mode (grayscale 0..255; mirrors the
// Rust `blend_value` in `subject_mask.rs` so the preview cannot drift).
function blendValue(d: number, s: number, blend: string): number {
  switch (blend) {
    case "multiply":
      return (d * s) / 255;
    case "screen":
      return 255 - ((255 - d) * (255 - s)) / 255;
    case "darken":
      return Math.min(d, s);
    case "lighten":
      return Math.max(d, s);
    case "difference":
      return Math.abs(d - s);
    default:
      return s;
  }
}

// Composite `src` onto `dst` in place per the layer's blend mode + opacity
// (grayscale surfaces; mirrors the Rust compositor in `subject_mask.rs`).
function blendInto(dst: ProxyMask, src: ProxyMask, blend: string, opacity: number): void {
  const a = clamp(opacity, 0, 1);
  for (let i = 0; i < dst.data.length; i++) {
    const d = dst.data[i];
    dst.data[i] = Math.round(d + (blendValue(d, src.data[i], blend) - d) * a);
  }
}

/**
 * Rasterise one layer's own ops into a tiny thumbnail surface (PS layer-panel
 * thumbnail). Every layer replays from an empty surface — the thumbnail shows
 * the layer's own content, not the composite. `wand` ops are skipped as in
 * the proxy build.
 */
export function buildLayerThumb(layer: MaskLayer, dims: { w: number; h: number }, thumbWidth = 48): ProxyMask {
  const w = Math.max(1, Math.min(thumbWidth, dims.w || thumbWidth));
  const scale = w / Math.max(1, dims.w || w);
  const h = Math.max(1, Math.round((dims.h || w) * scale));
  return replayOps(createProxyMask(w, h), layer.ops, scale);
}

/**
 * Rasterise the committed document (each layer's vector paths + brush strokes
 * + marquee regions + queued morphology, in order) into a downscaled proxy
 * mask. `wand` ops are skipped (they need the source pixels). The bottom
 * layer replays directly onto the base surface; layers above rasterise from
 * an empty surface and composite per blend + opacity — mirroring the Rust
 * compositor. This is the base a pending previewed op is then applied on top
 * of.
 */
export function buildProxyMask(
  doc: MaskDocument,
  dims: { w: number; h: number },
  options: ProxyBuildOptions = {},
): { mask: ProxyMask; scale: number } {
  const proxyWidth = Math.max(16, Math.min(options.proxyWidth ?? DEFAULT_PROXY_WIDTH, dims.w || DEFAULT_PROXY_WIDTH));
  const scale = proxyWidth / Math.max(1, dims.w);
  const w = Math.max(1, Math.round((dims.w || proxyWidth) * scale));
  const h = Math.max(1, Math.round((dims.h || proxyWidth) * scale));
  if (options.cache) return { mask: options.cache.build(doc, w, h, scale), scale };
  let mask = createProxyMask(w, h);
  doc.layers.forEach((layer, i) => {
    if (!layer.visible) return;
    if (layer.kind === "adjustment") {
      if (layer.adjustment) applyAdjustment(mask, layer.adjustment, layer.opacity);
      return;
    }
    if (i === 0) {
      mask = replayOps(mask, layer.ops, scale);
      return;
    }
    const surface = replayOps(createProxyMask(w, h), layer.ops, scale);
    blendInto(mask, surface, layer.blend, layer.opacity);
  });
  return { mask, scale };
}

// ---------------------------------------------------------------------------
// M7 — performance layer: per-layer surface cache + dirty-tile compositor.
// ---------------------------------------------------------------------------

/** Tile edge (px) for dirty-region compositing (M7, per the architecture doc). */
export const PROXY_TILE_SIZE = 256;

/** A half-open tile rect: `x0 <= x < x1`, `y0 <= y < y1`. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Cover a `w x h` surface with `tile`-sized rects (edge tiles clamp). */
export function tileRects(w: number, h: number, tile: number = PROXY_TILE_SIZE): TileRect[] {
  const rects: TileRect[] = [];
  for (let y = 0; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      rects.push({ x0: x, y0: y, x1: Math.min(x + tile, w), y1: Math.min(y + tile, h) });
    }
  }
  return rects;
}

/** Per-build reuse counters (reset by every `build`); read by tests / tuning. */
export interface ProxyCacheStats {
  /** Layers replayed from scratch (cache miss). */
  layersReplayed: number;
  /** Layers resumed from a cached ops-prefix surface (only new ops replayed). */
  layersResumed: number;
  /** Layers served verbatim from cache (ops unchanged). */
  layersReused: number;
  /** Tiles recomposited this build. */
  tilesComposited: number;
  /** Total tiles covering the proxy. */
  tilesTotal: number;
}

interface LayerCacheEntry {
  ops: EditOp[];
  surface: ProxyMask;
}

interface CompositeCacheEntry {
  key: string;
  surfaces: (ProxyMask | null)[];
  mask: ProxyMask;
}

// Longest count of leading ops shared (by reference) between the cached replay
// and the layer's current stack. maskEdit state is immutable — an edited op is
// a fresh object — so reference equality is an exact "unchanged" test.
function sharedOpsPrefix(cached: EditOp[], ops: EditOp[]): number {
  const n = Math.min(cached.length, ops.length);
  let i = 0;
  while (i < n && cached[i] === ops[i]) i++;
  return i;
}

function tileDiffers(a: ProxyMask, b: ProxyMask, rect: TileRect): boolean {
  for (let y = rect.y0; y < rect.y1; y++) {
    const row = y * a.w;
    for (let x = rect.x0; x < rect.x1; x++) {
      if (a.data[row + x] !== b.data[row + x]) return true;
    }
  }
  return false;
}

/**
 * Persistent proxy render cache (M7): keeps each layer's replayed surface
 * keyed by layer id, resumes replay from the longest unchanged ops prefix
 * (a brush drag replays only the new stroke), and recomposites only the
 * 256 px tiles whose inputs actually changed. Hold one per open modal and
 * pass it via `ProxyBuildOptions.cache`.
 */
export class ProxyLayerCache {
  private w = 0;
  private h = 0;
  private layers = new Map<string, LayerCacheEntry>();
  private composite: CompositeCacheEntry | null = null;
  stats: ProxyCacheStats = { layersReplayed: 0, layersResumed: 0, layersReused: 0, tilesComposited: 0, tilesTotal: 0 };

  /** Drop everything (proxy size changed, or the modal reopened). */
  reset(): void {
    this.layers.clear();
    this.composite = null;
  }

  build(doc: MaskDocument, w: number, h: number, scale: number): ProxyMask {
    if (w !== this.w || h !== this.h) {
      this.reset();
      this.w = w;
      this.h = h;
    }
    this.stats = { layersReplayed: 0, layersResumed: 0, layersReused: 0, tilesComposited: 0, tilesTotal: 0 };

    const seen = new Set<string>();
    const surfaces = doc.layers.map((layer) => {
      if (!layer.visible || layer.kind === "adjustment") return null;
      seen.add(layer.id);
      return this.layerSurface(layer, w, h, scale);
    });
    // Evict layers no longer in the document so the map cannot grow unbounded.
    for (const id of [...this.layers.keys()]) {
      if (!seen.has(id)) this.layers.delete(id);
    }

    // The composite key captures everything the per-tile composite reads
    // besides the surfaces themselves; any change forces a full recomposite.
    const key = doc.layers
      .map(
        (l) =>
          `${l.id}:${l.kind}:${l.visible ? 1 : 0}:${l.blend}:${l.opacity}:` +
          (l.kind === "adjustment" && l.adjustment ? JSON.stringify(l.adjustment) : ""),
      )
      .join("|");
    const luts = doc.layers.map((l) =>
      l.visible && l.kind === "adjustment" && l.adjustment ? adjustmentLut(l.adjustment) : null,
    );

    const tiles = tileRects(w, h);
    this.stats.tilesTotal = tiles.length;
    const prev = this.composite;
    let mask: ProxyMask;
    let dirty: TileRect[];
    if (prev && prev.key === key && prev.surfaces.length === surfaces.length) {
      mask = prev.mask;
      dirty = tiles.filter((t) =>
        surfaces.some((s, i) => {
          const old = prev.surfaces[i];
          if (s === old) return false;
          if (!s || !old) return true;
          return tileDiffers(s, old, t);
        }),
      );
    } else {
      mask = createProxyMask(w, h);
      dirty = tiles;
    }
    for (const rect of dirty) this.compositeTile(mask, doc, surfaces, luts, rect);
    this.stats.tilesComposited = dirty.length;
    this.composite = { key, surfaces, mask };
    // Hand out a copy: the cached composite is reused as the next build's
    // base and must not be mutated by the caller.
    return cloneMask(mask);
  }

  private layerSurface(layer: { id: string; ops: EditOp[] }, w: number, h: number, scale: number): ProxyMask {
    const entry = this.layers.get(layer.id);
    if (entry && entry.ops === layer.ops) {
      this.stats.layersReused++;
      return entry.surface;
    }
    if (entry && entry.ops.length > 0 && sharedOpsPrefix(entry.ops, layer.ops) === entry.ops.length) {
      // Replay is strictly sequential, so resuming from a cached prefix
      // surface and applying only the appended ops is always exact.
      const surface = replayOps(cloneMask(entry.surface), layer.ops.slice(entry.ops.length), scale);
      this.layers.set(layer.id, { ops: layer.ops, surface });
      this.stats.layersResumed++;
      return surface;
    }
    const surface = replayOps(createProxyMask(w, h), layer.ops, scale);
    this.layers.set(layer.id, { ops: layer.ops, surface });
    this.stats.layersReplayed++;
    return surface;
  }

  // Recompute one tile of the composite from the cached layer surfaces —
  // the same per-pixel math as the uncached path, restricted to `rect`.
  private compositeTile(
    mask: ProxyMask,
    doc: MaskDocument,
    surfaces: (ProxyMask | null)[],
    luts: (Uint8Array | null)[],
    rect: TileRect,
  ): void {
    const { w } = mask;
    for (let y = rect.y0; y < rect.y1; y++) {
      mask.data.fill(0, y * w + rect.x0, y * w + rect.x1);
    }
    doc.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      if (layer.kind === "adjustment") {
        const lut = luts[i];
        if (!lut) return;
        const a = clamp(layer.opacity, 0, 1);
        for (let y = rect.y0; y < rect.y1; y++) {
          const row = y * w;
          for (let x = rect.x0; x < rect.x1; x++) {
            const d = mask.data[row + x];
            mask.data[row + x] = Math.round(d + (lut[d] - d) * a);
          }
        }
        return;
      }
      const src = surfaces[i];
      if (!src) return;
      if (i === 0) {
        for (let y = rect.y0; y < rect.y1; y++) {
          const row = y * w;
          for (let x = rect.x0; x < rect.x1; x++) mask.data[row + x] = src.data[row + x];
        }
        return;
      }
      const a = clamp(layer.opacity, 0, 1);
      for (let y = rect.y0; y < rect.y1; y++) {
        const row = y * w;
        for (let x = rect.x0; x < rect.x1; x++) {
          const d = mask.data[row + x];
          mask.data[row + x] = Math.round(d + (blendValue(d, src.data[row + x], layer.blend) - d) * a);
        }
      }
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
