import { describe, expect, it } from "vitest";
import { buildEdgeMap, snapLoopToEdges, snapToEdge, snapToEdgeCandidate, type EdgeMap } from "./magneticSnap";

function rgba(w: number, h: number, valueAt: (x: number, y: number) => number) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = valueAt(x, y);
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function rgbaRgb(w: number, h: number, valueAt: (x: number, y: number) => [number, number, number, number?]) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a = 255] = valueAt(x, y);
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return pixels;
}

function brokenVerticalEdgeMap(w: number, h: number): EdgeMap {
  const mag = new Float32Array(w * h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    if (y >= 8 && y <= 22) continue;
    const idx = y * w + 20;
    mag[idx] = 120;
    gx[idx] = 120;
  }
  return { w, h, offX: 0, offY: 0, mag, gx, gy, strongThreshold: 50, maxMag: 120 };
}

function cornerEdgeMap(w: number, h: number): EdgeMap {
  const mag = new Float32Array(w * h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 4; y <= 16; y++) {
    const idx = y * w + 10;
    mag[idx] = 135;
    gx[idx] = 135;
  }
  for (let x = 10; x <= 28; x++) {
    const idx = 16 * w + x;
    mag[idx] = 135;
    gy[idx] = 135;
  }
  return { w, h, offX: 0, offY: 0, mag, gx, gy, strongThreshold: 50, maxMag: 135 };
}

describe("magnetic lasso edge snap", () => {
  it("snaps nearby points onto a strong image edge", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(rgba(w, h, (x) => (x < 16 ? 24 : 230)), w, h, 0, 0);

    const snapped = snapToEdge(edge, [13, 8], 6);

    expect(Math.abs(snapped[0] - 16)).toBeLessThanOrEqual(2);
    expect(snapped[1]).toBeCloseTo(8, 6);
  });

  it("reports candidate strength for live snap hysteresis", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(rgba(w, h, (x) => (x < 16 ? 24 : 230)), w, h, 0, 0);

    const candidate = snapToEdgeCandidate(edge, [13, 8], 6);

    expect(candidate.snapped).toBe(true);
    expect(candidate.score).toBeGreaterThan(0);
    expect(candidate.mag).toBeGreaterThan(0);
    expect(Math.abs(candidate.point[0] - 16)).toBeLessThanOrEqual(2);
    expect(Number.isInteger(candidate.point[0])).toBe(false);
  });

  it("leaves points alone in flat areas", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(rgba(w, h, () => 128), w, h, 0, 0);

    expect(snapToEdge(edge, [13, 8], 6)).toEqual([13, 8]);
  });

  it("keeps a strong boundary usable over textured image noise", () => {
    const w = 40;
    const h = 18;
    const edge = buildEdgeMap(
      rgba(w, h, (x, y) => {
        const noise = (((x * 17 + y * 11) % 9) - 4) * 5;
        return (x < 20 ? 72 : 196) + noise;
      }),
      w,
      h,
      0,
      0,
    );

    const snapped = snapToEdge(edge, [16, 9], 7, 50);

    expect(Math.abs(snapped[0] - 20)).toBeLessThanOrEqual(2);
  });

  it("traces intermediate points along a strong edge between sparse points", () => {
    const w = 40;
    const h = 28;
    const edge = buildEdgeMap(rgba(w, h, (x) => (x < 20 ? 20 : 235)), w, h, 0, 0);

    const traced = snapLoopToEdges(edge, [[17, 4], [17, 24]], 8, 45);

    expect(traced.length).toBeGreaterThan(2);
    expect(traced.slice(1, -1).every(([x]) => Math.abs(x - 20) <= 2)).toBe(true);
  });

  it("does not invent an edge-following segment across a weak gap", () => {
    const w = 40;
    const h = 32;
    const edge = brokenVerticalEdgeMap(w, h);

    const traced = snapLoopToEdges(edge, [[17, 4], [17, 28]], 8, 45);

    expect(traced).toHaveLength(2);
    expect(traced.every(([x]) => Math.abs(x - 20) <= 2)).toBe(true);
  });

  it("uses a local live-wire path around sharp corners", () => {
    const edge = cornerEdgeMap(42, 30);

    const traced = snapLoopToEdges(edge, [[10, 4], [28, 16]], 8, 45);

    expect(traced.length).toBeGreaterThan(4);
    expect(traced.some(([x, y]) => Math.abs(x - 10) <= 1 && Math.abs(y - 16) <= 1)).toBe(true);
    expect(traced.slice(1, -1).every(([x, y]) => Math.abs(x - 10) <= 1 || Math.abs(y - 16) <= 1)).toBe(true);
  });

  it("detects colour-only edges even when luma is similar", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(
      rgbaRgb(w, h, (x) => (x < 16 ? [255, 0, 0] : [0, 130, 0])),
      w,
      h,
      0,
      0,
    );

    const snapped = snapToEdge(edge, [13, 8], 6, 40);

    expect(Math.abs(snapped[0] - 16)).toBeLessThanOrEqual(2);
  });

  it("detects alpha-only edges for transparent layer boundaries", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(
      rgbaRgb(w, h, (x) => (x < 16 ? [128, 128, 128, 0] : [128, 128, 128, 255])),
      w,
      h,
      0,
      0,
    );

    const snapped = snapToEdge(edge, [13, 8], 6, 40);

    expect(Math.abs(snapped[0] - 16)).toBeLessThanOrEqual(2);
  });

  it("ignores hidden RGB changes inside fully transparent pixels", () => {
    const w = 32;
    const h = 16;
    const edge = buildEdgeMap(
      rgbaRgb(w, h, (x) => (x < 16 ? [255, 0, 0, 0] : [0, 255, 0, 0])),
      w,
      h,
      0,
      0,
    );

    expect(snapToEdge(edge, [13, 8], 6, 20)).toEqual([13, 8]);
  });

  it("uses a wider scale to detect soft image boundaries", () => {
    const w = 40;
    const h = 18;
    const edge = buildEdgeMap(
      rgba(w, h, (x) => {
        if (x < 10) return 64;
        if (x > 22) return 192;
        return 64 + ((x - 10) / 12) * 128;
      }),
      w,
      h,
      0,
      0,
    );

    const snapped = snapToEdge(edge, [13, 9], 8, 20);

    expect(snapped[0]).toBeGreaterThanOrEqual(13);
    expect(snapped[0]).toBeLessThanOrEqual(20);
  });
});
