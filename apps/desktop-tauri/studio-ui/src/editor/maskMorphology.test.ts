import { describe, expect, it } from "vitest";
import {
  adjustmentLut,
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
  PROXY_TILE_SIZE,
  ProxyLayerCache,
  sharpen,
  tileRects,
  smooth,
  stampDisc,
  stampSoftDisc,
  transformMask,
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

  it("gradient op composites a linear ramp: add unions, subtract cuts (M10)", () => {
    const dims = { w: 32, h: 32 };
    const at1 = { proxyWidth: 32 }; // scale 1: proxy px ≡ image px
    // Left-to-right ramp across the full width: full at x=0, none at x=w.
    const add = buildProxyMask(doc([{ type: "gradient", region: [0, 16, 32, 16] }]), dims, at1).mask;
    expect(add.data[0]).toBeGreaterThan(240);
    expect(add.data[31]).toBeLessThan(15);
    expect(add.data[16]).toBeGreaterThan(100);
    expect(add.data[16]).toBeLessThan(155);
    expect(add.data[31 * 32]).toBe(add.data[0]); // constant down each column
    // Subtract cuts the ramp out of a full mask (complement of add).
    const sub = buildProxyMask(
      doc([{ type: "select_all" }, { type: "gradient", region: [0, 16, 32, 16], mode: "subtract" }]),
      dims,
      at1,
    ).mask;
    for (let x = 0; x < 32; x++) expect(sub.data[x]).toBe(255 - add.data[x]);
    // Degenerate (zero-length) drags are a no-op.
    const none = buildProxyMask(doc([{ type: "gradient", region: [3, 16, 3, 16] }]), dims, at1).mask;
    expect(area(none)).toBe(0);
  });

  it("fill op floods at an opacity: add lerps up, subtract scales down (M11)", () => {
    const dims = { w: 32, h: 32 };
    const at1 = { proxyWidth: 32 };
    // 100% add fill ≡ select all.
    const full = buildProxyMask(doc([{ type: "fill" }]), dims, at1).mask;
    expect(area(full)).toBe(32 * 32);
    // 50% add on an empty layer lands halfway.
    const half = buildProxyMask(doc([{ type: "fill", amount: 50 }]), dims, at1).mask;
    expect(half.data[0]).toBe(128);
    // 50% subtract on a full mask scales it down to half.
    const sub = buildProxyMask(
      doc([{ type: "select_all" }, { type: "fill", mode: "subtract", amount: 50 }]),
      dims,
      at1,
    ).mask;
    expect(sub.data[0]).toBe(128);
    // 100% subtract ≡ delete.
    const wiped = buildProxyMask(
      doc([{ type: "select_all" }, { type: "fill", mode: "subtract", amount: 100 }]),
      dims,
      at1,
    ).mask;
    expect(area(wiped)).toBe(0);
    // 0% is the identity.
    const noop = buildProxyMask(doc([{ type: "select_all" }, { type: "fill", amount: 0 }]), dims, at1).mask;
    expect(area(noop)).toBe(32 * 32);
  });

  it("applyOp select_all fills the canvas and delete clears it (M9)", () => {
    const base = filledSquare(30, 10);
    expect(area(applyOp(base, "select_all", 0))).toBe(30 * 30);
    expect(area(applyOp(base, "delete", 0))).toBe(0);
  });

  it("transformMask translates the mask by dx/dy", () => {
    const mask = createProxyMask(9, 9);
    mask.data[2 * 9 + 2] = 255;
    const moved = transformMask(mask, 3, 1, 1, 0);
    expect(moved.data[3 * 9 + 5]).toBe(255);
    expect(moved.data[2 * 9 + 2]).toBe(0);
  });

  it("transformMask rotates 90° about the centre", () => {
    const mask = createProxyMask(9, 9);
    mask.data[4 * 9 + 2] = 255; // (x=2, y=4)
    const rotated = transformMask(mask, 0, 0, 1, 90);
    expect(rotated.data[2 * 9 + 4]).toBe(255); // → (x=4, y=2)
    expect(rotated.data[4 * 9 + 2]).toBe(0);
  });

  it("transformMask with identity params is a no-op", () => {
    const base = filledSquare(12, 3);
    const same = transformMask(base, 0, 0, 1, 0);
    expect(Array.from(same.data)).toEqual(Array.from(base.data));
  });

  it("transformMask scale grows the mask about the centre", () => {
    const base = filledSquare(20, 7); // 6x6 block
    const scaled = transformMask(base, 0, 0, 2, 0);
    expect(area(scaled)).toBeGreaterThan(area(base));
  });

  it("exposes the amount-taking morphology / filter ops as previewable", () => {
    expect([...PREVIEWABLE_OP_IDS]).toEqual(["grow", "shrink", "feather", "smooth", "blur", "sharpen"]);
    expect(isPreviewableOp("grow")).toBe(true);
    expect(isPreviewableOp("blur")).toBe(true);
    expect(isPreviewableOp("sharpen")).toBe(true);
    expect(isPreviewableOp("invert")).toBe(false);
    expect(isPreviewableOp("wand")).toBe(false);
  });

  it("sharpen re-steepens a blurred edge", () => {
    const blurred = feather(filledSquare(24, 8), 2);
    const sharpened = sharpen(blurred, 2);
    const mid = (m: ProxyMask) => Array.from(m.data).filter((v) => v > 32 && v < 224).length;
    expect(mid(sharpened)).toBeLessThan(mid(blurred)); // fewer in-between greys
    expect(sharpen(blurred, 0).data).toEqual(blurred.data); // radius 0 ⇒ no-op
  });
});

describe("adjustmentLut", () => {
  it("levels remaps the input range onto the output range with gamma", () => {
    const lut = adjustmentLut({ type: "levels", in_black: 64, in_white: 192 });
    expect(lut[0]).toBe(0);
    expect(lut[64]).toBe(0);
    expect(lut[128]).toBe(128); // midpoint of the input span
    expect(lut[192]).toBe(255);
    expect(lut[255]).toBe(255);
    const bright = adjustmentLut({ type: "levels", gamma: 2 });
    expect(bright[64]).toBeGreaterThan(64); // gamma > 1 lifts midtones
    const identity = adjustmentLut({ type: "levels" });
    expect(identity[100]).toBe(100);
  });

  it("curve interpolates piecewise-linearly between sorted control points", () => {
    const lut = adjustmentLut({ type: "curve", points: [[0, 0], [128, 192], [255, 255]] });
    expect(lut[0]).toBe(0);
    expect(lut[64]).toBe(96); // halfway up the first segment
    expect(lut[128]).toBe(192);
    expect(lut[255]).toBe(255);
    const identity = adjustmentLut({ type: "curve" }); // <2 points ⇒ identity
    expect(identity[77]).toBe(77);
  });

  it("brightness_contrast scales about the midpoint then shifts", () => {
    const lut = adjustmentLut({ type: "brightness_contrast", contrast: 100 });
    expect(lut[64]).toBe(1); // (64-127.5)*2+127.5 = 0.5 → rounds to 1
    expect(lut[192]).toBe(255); // clamped
    const brighter = adjustmentLut({ type: "brightness_contrast", brightness: 20 });
    expect(brighter[100]).toBe(151); // +51
    const identity = adjustmentLut({ type: "brightness_contrast" });
    expect(identity[100]).toBe(100);
  });

  it("buildProxyMask applies visible adjustment layers to the composite below", () => {
    const d = doc([{ type: "brush", id: "s1", mode: "add", radius: 40, points: [[480, 320]] }]);
    d.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "adj",
      kind: "adjustment",
      adjustment: { type: "brightness_contrast", brightness: -100 },
    });
    const adjusted = buildProxyMask(d, { w: 960, h: 640 });
    expect(area(adjusted.mask)).toBe(0); // −100 brightness crushes to black
    d.layers[1].visible = false; // hidden ⇒ skipped
    expect(area(buildProxyMask(d, { w: 960, h: 640 }).mask)).toBeGreaterThan(0);
    d.layers[1].visible = true;
    d.layers[1].opacity = 0.5; // half strength ⇒ mid grey survives
    const half = buildProxyMask(d, { w: 960, h: 640 });
    expect(Array.from(half.mask.data).some((v) => v > 0 && v < 255)).toBe(true);
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

  it("replays crop ops: the mask is cleared outside the region", () => {
    const cropped = buildProxyMask(
      doc([{ type: "invert" }, { type: "crop", region: [240, 160, 720, 480] }]),
      { w: 960, h: 640 },
      { proxyWidth: 320 },
    );
    const at = (x: number, y: number) =>
      cropped.mask.data[Math.round(y * cropped.scale) * cropped.mask.w + Math.round(x * cropped.scale)];
    expect(at(480, 320)).toBe(255); // inside the crop box
    expect(at(60, 60)).toBe(0); // outside cleared
    expect(at(900, 600)).toBe(0);
  });

  it("replays transform ops in proxy space (dx/dy scaled)", () => {
    const stroke = { type: "brush" as const, id: "s1", mode: "add", radius: 40, points: [[240, 160]] as [number, number][] };
    const moved = buildProxyMask(
      doc([stroke, { type: "transform", dx: 300, dy: 200 }]),
      { w: 960, h: 640 },
      { proxyWidth: 320 },
    );
    const at = (x: number, y: number) =>
      moved.mask.data[Math.round(y * moved.scale) * moved.mask.w + Math.round(x * moved.scale)];
    expect(at(540, 360)).toBe(255); // blob moved to the new centre
    expect(at(240, 160)).toBe(0); // old position vacated
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

describe("ProxyLayerCache (M7)", () => {
  const brush = (id: string, x: number, y: number, radius = 300): EditOp => ({
    type: "brush",
    id,
    mode: "add",
    radius,
    points: [[x, y]],
  });

  /** An 8K-canvas document: background strokes + an upper multiply layer + an adjustment. */
  const bigDoc = (): MaskDocument => {
    const d = doc([brush("s1", 1200, 1200), { type: "grow", amount: 64 }]);
    d.layers.push({
      id: "l2",
      name: "Layer 2",
      kind: "mask",
      blend: "screen",
      opacity: 0.75,
      visible: true,
      ops: [brush("s2", 6800, 6800)],
    });
    d.layers.push({
      id: "adj",
      name: "Levels",
      kind: "adjustment",
      blend: "normal",
      opacity: 1,
      visible: true,
      ops: [],
      adjustment: { type: "levels", gamma: 1.4 },
    });
    return d;
  };
  const dims = { w: 8192, h: 8192 };
  const options = { proxyWidth: 512 };

  it("tileRects covers the surface with clamped 256px tiles", () => {
    expect(PROXY_TILE_SIZE).toBe(256);
    const rects = tileRects(512, 300);
    expect(rects).toHaveLength(4); // 2 cols x 2 rows
    expect(rects[3]).toEqual({ x0: 256, y0: 256, x1: 512, y1: 300 });
  });

  it("a cached build is byte-identical to an uncached build", () => {
    const cache = new ProxyLayerCache();
    const d = bigDoc();
    const cached = buildProxyMask(d, dims, { ...options, cache }).mask;
    const plain = buildProxyMask(d, dims, options).mask;
    expect(Array.from(cached.data)).toEqual(Array.from(plain.data));
    // A no-change rebuild reuses every layer and recomposites nothing.
    const again = buildProxyMask(d, dims, { ...options, cache }).mask;
    expect(cache.stats.layersReused).toBe(2);
    expect(cache.stats.layersReplayed).toBe(0);
    expect(cache.stats.tilesComposited).toBe(0);
    expect(Array.from(again.data)).toEqual(Array.from(plain.data));
  });

  it("appending a stroke resumes the layer replay and recomposites dirty tiles only", () => {
    const cache = new ProxyLayerCache();
    const d = bigDoc();
    buildProxyMask(d, dims, { ...options, cache });
    // Append a stroke near the top-left corner of the upper layer (immutably,
    // as maskEdit's commit() does).
    const edited: MaskDocument = {
      ...d,
      layers: d.layers.map((l) => (l.id === "l2" ? { ...l, ops: [...l.ops, brush("s3", 400, 400)] } : l)),
    };
    const cached = buildProxyMask(edited, dims, { ...options, cache }).mask;
    expect(cache.stats.layersResumed).toBe(1); // only the new stroke replayed
    expect(cache.stats.layersReused).toBe(1); // background untouched
    expect(cache.stats.layersReplayed).toBe(0);
    expect(cache.stats.tilesTotal).toBe(4); // 512x512 proxy = 2x2 tiles
    expect(cache.stats.tilesComposited).toBe(1); // stroke confined to one tile
    const plain = buildProxyMask(edited, dims, options).mask;
    expect(Array.from(cached.data)).toEqual(Array.from(plain.data));
  });

  it("changing adjustment params or layer shape forces a full recomposite but reuses surfaces", () => {
    const cache = new ProxyLayerCache();
    const d = bigDoc();
    buildProxyMask(d, dims, { ...options, cache });
    const edited: MaskDocument = {
      ...d,
      layers: d.layers.map((l) =>
        l.id === "adj" ? { ...l, adjustment: { type: "levels" as const, gamma: 0.6 } } : l,
      ),
    };
    const cached = buildProxyMask(edited, dims, { ...options, cache }).mask;
    expect(cache.stats.layersReused).toBe(2); // mask surfaces untouched
    expect(cache.stats.tilesComposited).toBe(4); // composite key changed
    const plain = buildProxyMask(edited, dims, options).mask;
    expect(Array.from(cached.data)).toEqual(Array.from(plain.data));
  });

  it("editing an earlier op invalidates the prefix and replays the layer", () => {
    const cache = new ProxyLayerCache();
    const d = bigDoc();
    buildProxyMask(d, dims, { ...options, cache });
    const edited: MaskDocument = {
      ...d,
      layers: d.layers.map((l, i) =>
        i === 0 ? { ...l, ops: [l.ops[0], { type: "grow", amount: 96 }] } : l,
      ),
    };
    const cached = buildProxyMask(edited, dims, { ...options, cache }).mask;
    expect(cache.stats.layersReplayed).toBe(1); // prefix broken at the edited op
    const plain = buildProxyMask(edited, dims, options).mask;
    expect(Array.from(cached.data)).toEqual(Array.from(plain.data));
  });

  it("a proxy size change resets the cache", () => {
    const cache = new ProxyLayerCache();
    const d = bigDoc();
    buildProxyMask(d, dims, { ...options, cache });
    const smaller = buildProxyMask(d, dims, { proxyWidth: 320, cache }).mask;
    expect(cache.stats.layersReplayed).toBe(2); // everything rebuilt at the new size
    const plain = buildProxyMask(d, dims, { proxyWidth: 320 }).mask;
    expect(Array.from(smaller.data)).toEqual(Array.from(plain.data));
  });
});
