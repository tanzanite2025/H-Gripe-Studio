import { describe, expect, it } from "vitest";
import { buildEdgeMap, snapLoopToEdges, snapToEdge } from "./magneticSnap";

/** RGBA pixels for a w×h image split at column `edgeX`: dark left, bright right. */
function verticalEdgeImage(w: number, h: number, edgeX: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < edgeX ? 10 : 240;
      const i = (y * w + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

describe("magneticSnap", () => {
  it("buildEdgeMap peaks along a luminance boundary", () => {
    const edge = buildEdgeMap(verticalEdgeImage(32, 32, 16), 32, 32, 0, 0);
    const onEdge = edge.mag[16 * 32 + 16];
    const offEdge = edge.mag[16 * 32 + 4];
    expect(onEdge).toBeGreaterThan(100);
    expect(offEdge).toBe(0);
  });

  it("snapToEdge pulls a nearby point onto the edge and leaves flat areas alone", () => {
    const edge = buildEdgeMap(verticalEdgeImage(32, 32, 16), 32, 32, 0, 0);
    const snapped = snapToEdge(edge, [12, 16], 6);
    expect(Math.abs(snapped[0] - 15.5)).toBeLessThanOrEqual(1);
    expect(snapped[1]).toBe(16);
    // Far from any edge the point stays where it was drawn.
    expect(snapToEdge(edge, [4, 16], 4)).toEqual([4, 16]);
  });

  it("snapToEdge honours the image-space offset of the edge map window", () => {
    const edge = buildEdgeMap(verticalEdgeImage(32, 32, 16), 32, 32, 100, 200);
    const snapped = snapToEdge(edge, [112, 216], 6);
    expect(Math.abs(snapped[0] - 115.5)).toBeLessThanOrEqual(1);
    expect(snapped[1]).toBe(216);
  });

  it("snapLoopToEdges maps every point of the loop", () => {
    const edge = buildEdgeMap(verticalEdgeImage(32, 32, 16), 32, 32, 0, 0);
    const loop = snapLoopToEdges(edge, [
      [13, 8],
      [13, 16],
      [13, 24],
    ], 6);
    expect(loop).toHaveLength(3);
    for (const [x] of loop) expect(Math.abs(x - 15.5)).toBeLessThanOrEqual(1);
  });
});
