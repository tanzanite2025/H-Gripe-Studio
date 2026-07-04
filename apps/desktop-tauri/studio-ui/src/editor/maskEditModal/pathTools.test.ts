import { describe, expect, it } from "vitest";
import { catmullRomClosed } from "./pathGeometry";
import { hitTestPathOp, translateAnchors } from "./pathEditTools";
import type { EditOp } from "../../types/production";

describe("catmullRomClosed", () => {
  it("passes through every anchor and closes the loop", () => {
    const anchors: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const out = catmullRomClosed(anchors, 8);
    expect(out.length).toBe(anchors.length * 8);
    // Each anchor is the first sample of its segment (t = 0).
    anchors.forEach(([x, y], i) => {
      const [sx, sy] = out[i * 8];
      expect(sx).toBeCloseTo(x);
      expect(sy).toBeCloseTo(y);
    });
  });

  it("returns fewer than three anchors unchanged", () => {
    expect(catmullRomClosed([[1, 2], [3, 4]])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

const pathOp = (points: { x: number; y: number }[], disabled = false): EditOp =>
  ({
    type: "path",
    id: "p",
    mode: "add",
    tool: "pen",
    closed: true,
    points,
    ...(disabled ? { disabled: true } : null),
  }) as EditOp;

describe("hitTestPathOp", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("hits the closest path outline within the radius", () => {
    const ops = [pathOp(square)];
    expect(hitTestPathOp(ops, [50, 3], 10)).toBe(0);
    expect(hitTestPathOp(ops, [50, 50], 10)).toBe(-1);
  });

  it("skips disabled ops and prefers the topmost step on ties", () => {
    const ops = [pathOp(square), pathOp(square)];
    expect(hitTestPathOp(ops, [50, 3], 10)).toBe(1);
    expect(hitTestPathOp([pathOp(square, true)], [50, 3], 10)).toBe(-1);
  });
});

describe("translateAnchors", () => {
  it("moves anchors and bezier handles together", () => {
    const out = translateAnchors(
      [{ x: 1, y: 2, in: [0, 0], out: [3, 3] }],
      10,
      -5,
    );
    expect(out[0]).toEqual({ x: 11, y: -3, in: [10, -5], out: [13, -2] });
  });
});
