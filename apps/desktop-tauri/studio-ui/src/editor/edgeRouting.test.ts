import { describe, expect, it } from "vitest";
import { chamferPath, chamferPoints, pointsToPath } from "@hgripe/flow";

const s = { x: 0, y: 0 };

describe("chamferPoints / path", () => {
  it("builds a structured path with one 45 degree diagonal cut", () => {
    expect(chamferPoints(s, { x: 200, y: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 44, y: 0 },
      { x: 94, y: 50 },
      { x: 200, y: 50 },
    ]);
  });

  it("keeps the diagonal at 45 degrees when routing upward", () => {
    expect(chamferPoints({ x: 200, y: 80 }, { x: 0, y: 20 })).toEqual([
      { x: 200, y: 80 },
      { x: 156, y: 80 },
      { x: 96, y: 20 },
      { x: 0, y: 20 },
    ]);
  });

  it("serializes points to an SVG path", () => {
    expect(pointsToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe("M 0,0 L 10,0");
  });

  it("uses a straight segment when the ports are already aligned", () => {
    expect(chamferPath(s, { x: 200, y: 0 })).toBe("M 0,0 L 200,0");
  });
});
