import { describe, expect, it } from "vitest";
import {
  applyOp,
  buildProxyMask,
  createProxyMask,
  dilate,
  erode,
  feather,
  fillHoles,
  invert,
  isPreviewableOp,
  PREVIEWABLE_OP_IDS,
  smooth,
  stampDisc,
  stampSoftDisc,
  type ProxyMask,
} from "./maskMorphology";
import { normalizeEditPaths } from "./maskEdit";
import { emptyMaskDocument, type EditOp, type MaskDocument, type MaskLayer } from "../types/production";

/** A single-layer v3 document whose background layer holds `ops`. */
function doc(ops: EditOp[], layerPatch: Partial<MaskLayer> = {}): MaskDocument {
  const d = emptyMaskDocument();
  d.layers[0] = { ...d.layers[0], ...layerPatch, ops };
  return d;
}

/** Count of set (>=128) pixels — a proxy for mask "area". */
function area(mask: ProxyMask): number {
  let n = 0;
  for (const v of mask.data) if (v >= 128) n++;
  return n;
}

function filledSquare(size: number, inset: number): ProxyMask {
  const mask = createProxyMask(size, size);
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) mask.data[y * size + x] = 255;
  }
  return mask;
}

describe("maskMorphology preview primitives", () => {
  it("stampDisc fills a clamped circular region", () => {
    const mask = createProxyMask(20, 20);
    stampDisc(mask, 10, 10, 5, 255);
    expect(mask.data[10 * 20 + 10]).toBe(255); // centre set
    expect(mask.data[10 * 20 + 19]).toBe(0); // far corner untouched
    expect(area(mask)).toBeGreaterThan(0);
  });

  it("stampSoftDisc grades coverage from the hard core to the rim", () => {
    const mask = createProxyMask(40, 40);
    stampSoftDisc(mask, 20, 20, 10, 0.5, 1, false);
    expect(mask.data[20 * 40 + 20]).toBe(255); // hard core fully on
    const nearRim = mask.data[20 * 40 + 28]; // d=8 ∈ (hard=5, r=10)
    expect(nearRim).toBeGreaterThan(0);
    expect(nearRim).toBeLessThan(255);
    expect(mask.data[20 * 40 + 35]).toBe(0); // outside untouched
  });

  it("stampSoftDisc caps coverage at flow and subtract scales down", () => {
    const mask = createProxyMask(20, 20);
    stampSoftDisc(mask, 10, 10, 5, 1, 0.5, false);
    expect(mask.data[10 * 20 + 10]).toBe(128); // flow-capped
    const sub = createProxyMask(20, 20);
    sub.data.fill(255);
    stampSoftDisc(sub, 10, 10, 5, 1, 0.5, true);
    expect(sub.data[10 * 20 + 10]).toBe(128); // 255 * (1 - 0.5)
    expect(sub.data[0]).toBe(255); // outside untouched
  });

  it("dilate grows and erode shrinks the mask area", () => {
    const base = filledSquare(40, 12); // 16x16 block
    const grown = dilate(base, 3);
    const eroded = erode(base, 3);
    expect(area(grown)).toBeGreaterThan(area(base));
    expect(area(eroded)).toBeLessThan(area(base));
  });

  it("dilate/erode with radius 0 are identity", () => {
    const base = filledSquare(20, 6);
    expect(area(dilate(base, 0))).toBe(area(base));
    expect(area(erode(base, 0))).toBe(area(base));
  });

  it("feather produces soft (intermediate) alpha at the edge", () => {
    const base = filledSquare(40, 12);
    const soft = feather(base, 3);
    const hasSoftEdge = Array.from(soft.data).some((v) => v > 0 && v < 255);
    expect(hasSoftEdge).toBe(true);
  });

  it("invert flips every pixel", () => {
    const base = filledSquare(10, 3);
    const inv = invert(base);
    for (let i = 0; i < base.data.length; i++) expect(inv.data[i]).toBe(255 - base.data[i]);
  });

  it("smooth removes an isolated speckle (morphological open)", () => {
    const mask = createProxyMask(40, 40);
    stampDisc(mask, 20, 20, 8, 255); // main blob
    mask.data[2 * 40 + 2] = 255; // 1px speckle in the corner
    const cleaned = smooth(mask, 2);
    expect(cleaned.data[2 * 40 + 2]).toBe(0);
    expect(cleaned.data[20 * 40 + 20]).toBe(255); // blob survives
  });

  it("fillHoles closes an enclosed interior hole but not the exterior", () => {
    const mask = filledSquare(21, 4); // solid block
    const cx = 10;
    mask.data[cx * 21 + cx] = 0; // punch a 1px hole in the centre
    const filled = fillHoles(mask);
    expect(filled.data[cx * 21 + cx]).toBe(255); // hole filled
    expect(filled.data[0]).toBe(0); // exterior background stays background
  });

  it("applyOp dispatches by op type and no-ops for wand", () => {
    const base = filledSquare(30, 10);
    expect(area(applyOp(base, "grow", 2))).toBeGreaterThan(area(base));
    expect(area(applyOp(base, "shrink", 2))).toBeLessThan(area(base));
    expect(area(applyOp(base, "wand", 4))).toBe(area(base)); // pixels needed → identity
  });

  it("exposes the amount-taking morphology ops as previewable", () => {
    expect([...PREVIEWABLE_OP_IDS]).toEqual(["grow", "shrink", "feather", "smooth"]);
    expect(isPreviewableOp("grow")).toBe(true);
    expect(isPreviewableOp("invert")).toBe(false);
    expect(isPreviewableOp("wand")).toBe(false);
  });
});

describe("buildProxyMask", () => {
  it("rasterises a soft brush stroke with a graded edge", () => {
    const edits = doc([
      { type: "brush", id: "s1", mode: "add", radius: 60, points: [[480, 320]], hardness: 0.3, flow: 1, spacing: 0.25 },
    ]);
    const { mask } = buildProxyMask(edits, { w: 960, h: 640 }, { proxyWidth: 320 });
    const hasSoftEdge = Array.from(mask.data).some((v) => v > 0 && v < 255);
    expect(hasSoftEdge).toBe(true);
    expect(area(mask)).toBeGreaterThan(0);
  });

  it("rasterises a brush stroke into a downscaled proxy", () => {
    const edits = doc([{ type: "brush", id: "s1", mode: "add", radius: 40, points: [[480, 320]] }]);
    const { mask, scale } = buildProxyMask(edits, { w: 960, h: 640 }, { proxyWidth: 320 });
    expect(mask.w).toBe(320);
    expect(mask.h).toBe(213); // 640 * (320/960) rounded
    expect(scale).toBeCloseTo(1 / 3, 5);
    expect(area(mask)).toBeGreaterThan(0);
  });

  it("skips disabled history steps on replay", () => {
    const stroke = { type: "brush" as const, id: "s1", mode: "add", radius: 40, points: [[480, 320]] as [number, number][] };
    const enabled = doc([stroke]);
    const disabled = doc([{ ...stroke, disabled: true }]);
    expect(area(buildProxyMask(enabled, { w: 960, h: 640 }).mask)).toBeGreaterThan(0);
    expect(area(buildProxyMask(disabled, { w: 960, h: 640 }).mask)).toBe(0);
  });

  it("applies queued morphology operations in order on top of strokes", () => {
    const stroke = { type: "brush" as const, id: "s1", mode: "add", radius: 40, points: [[480, 320]] as [number, number][] };
    const base = buildProxyMask(doc([stroke]), { w: 960, h: 640 });
    const grown = buildProxyMask(doc([stroke, { type: "grow", amount: 12 }]), { w: 960, h: 640 });
    expect(area(grown.mask)).toBeGreaterThan(area(base.mask));
  });

  it("rasterises pen / lasso paths and boolean-combines by mode", () => {
    const square = (x0: number, y0: number, x1: number, y1: number) => [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    const addOp: EditOp = { type: "path", id: "p1", mode: "add", tool: "lasso", closed: true, points: square(120, 120, 840, 520) };
    const added = doc([addOp]);
    const { mask, scale } = buildProxyMask(added, { w: 960, h: 640 }, { proxyWidth: 320 });
    const at = (x: number, y: number) => mask.data[Math.round(y * scale) * mask.w + Math.round(x * scale)];
    expect(at(480, 320)).toBe(255); // interior on
    expect(at(30, 30)).toBe(0); // exterior off

    const subtracted = doc([
      addOp,
      { type: "path", id: "p2", mode: "subtract", tool: "pen", closed: true, points: square(400, 250, 560, 390) },
    ]);
    const sub = buildProxyMask(subtracted, { w: 960, h: 640 }, { proxyWidth: 320 });
    const atSub = (x: number, y: number) => sub.mask.data[Math.round(y * sub.scale) * sub.mask.w + Math.round(x * sub.scale)];
    expect(atSub(480, 320)).toBe(0); // carved out
    expect(atSub(200, 200)).toBe(255); // rest of the add survives

    const intersected = doc([
      addOp,
      { type: "path", id: "p3", mode: "intersect", tool: "lasso", closed: true, points: square(120, 120, 480, 320) },
    ]);
    const inter = buildProxyMask(intersected, { w: 960, h: 640 }, { proxyWidth: 320 });
    const atInter = (x: number, y: number) => inter.mask.data[Math.round(y * inter.scale) * inter.mask.w + Math.round(x * inter.scale)];
    expect(atInter(200, 200)).toBe(255); // inside both
    expect(atInter(700, 450)).toBe(0); // inside add only
  });

  it("skips wand ops (no source pixels on the proxy)", () => {
    const brush = { type: "brush" as const, id: "s1", mode: "add", radius: 40, points: [[480, 320]] as [number, number][] };
    const withWand = buildProxyMask(doc([brush, { type: "wand", amount: 30, region: [10, 10] }]), { w: 960, h: 640 });
    const withoutWand = buildProxyMask(doc([brush]), { w: 960, h: 640 });
    expect(area(withWand.mask)).toBe(area(withoutWand.mask));
  });

  it("composites upper layers per blend mode and opacity", () => {
    const dims = { w: 320, h: 240 };
    const layered = (top: Partial<MaskLayer>): MaskDocument => {
      const d = doc([{ type: "invert" }]); // background: everything on
      d.layers.push({
        id: "l2",
        name: "Layer 2",
        kind: "mask",
        blend: "normal",
        opacity: 1,
        visible: true,
        ops: [],
        ...top,
      });
      return d;
    };

    // normal @ 100%: the (empty) upper surface replaces the background.
    const normal = buildProxyMask(layered({ blend: "normal" }), dims).mask;
    expect(area(normal)).toBe(0);

    // multiply with an empty (dark) upper surface knocks everything out.
    const multiply = buildProxyMask(layered({ blend: "multiply" }), dims).mask;
    expect(area(multiply)).toBe(0);

    // screen with an empty upper surface leaves the background untouched.
    const screen = buildProxyMask(layered({ blend: "screen" }), dims).mask;
    expect(area(screen)).toBe(normal.data.length);

    // normal @ 50%: half-way between on (255) and off (0).
    const half = buildProxyMask(layered({ blend: "normal", opacity: 0.5 }), dims).mask;
    expect(half.data[0]).toBe(128);

    // hidden layers are skipped entirely.
    const hidden = buildProxyMask(layered({ blend: "normal", visible: false }), dims).mask;
    expect(area(hidden)).toBe(hidden.data.length);
  });

  it("a single-layer document rasterises identically to the pre-M3 flat replay", () => {
    // M3 acceptance: no compositing side-effects for one layer.
    const ops: EditOp[] = [
      { type: "path", id: "p1", mode: "add", tool: "lasso", closed: true,
        points: [{ x: 100, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 500 }, { x: 100, y: 500 }] },
      { type: "brush", id: "s1", mode: "subtract", radius: 40, points: [[480, 320]] },
      { type: "invert" },
    ];
    const single = buildProxyMask(doc(ops), { w: 960, h: 640 }).mask;
    // Reference: the same ops loaded through the v2 (flat stack) migration.
    const migrated = normalizeEditPaths({ version: 2, ops, matte_strokes: [], points: [] });
    const replayed = buildProxyMask(migrated, { w: 960, h: 640 }).mask;
    expect(Array.from(single.data)).toEqual(Array.from(replayed.data));
  });
});
