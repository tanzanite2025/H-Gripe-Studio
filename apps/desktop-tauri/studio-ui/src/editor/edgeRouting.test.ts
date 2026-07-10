import { describe, expect, it } from "vitest";
import {
  cachedChamferPath,
  cachedRoutedEdgePath,
  chamferPath,
  chamferPoints,
  EDGE_LOD_ZOOM_THRESHOLD,
  EDGE_PORT_STUB_LENGTH,
  isEdgeLodActive,
  pointsToPath,
  portedChamferPath,
  portedChamferPoints,
  routedEdgePath,
  routedEdgePoints,
} from "@hgripe/flow";

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

describe("ported chamfer paths", () => {
  it("keeps a short straight segment out of side ports before the 45 degree route", () => {
    expect(
      portedChamferPoints(
        { x: 0, y: 0 },
        { x: 80, y: 140 },
        { sourcePosition: "right", targetPosition: "left" },
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: EDGE_PORT_STUB_LENGTH, y: 0 },
      { x: 58, y: 36 },
      { x: 58, y: 140 },
      { x: 80, y: 140 },
    ]);
  });

  it("uses the real source side for bottom image-source ports", () => {
    expect(
      portedChamferPath(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { sourcePosition: "bottom", targetPosition: "left" },
      ),
    ).toBe("M 0,0 L 0,22 L 78,100 L 100,100");
  });
});

describe("cachedChamferPath", () => {
  it("matches the uncached path and reuses the built string", () => {
    const t = { x: 200, y: 50 };
    const first = cachedChamferPath(s, t);
    expect(first).toBe(chamferPath(s, t));
    expect(cachedChamferPath(s, t)).toBe(first);
    expect(cachedChamferPath({ x: 0, y: 0 }, { x: 200, y: 50 })).toBe(first);
  });
});

describe("explicit edge waypoints", () => {
  it("routes through persisted bend points in order", () => {
    const waypoints = [
      { x: 60, y: 20 },
      { x: 120, y: 80 },
    ];
    expect(routedEdgePoints(s, { x: 200, y: 100 }, waypoints)).toEqual([
      s,
      ...waypoints,
      { x: 200, y: 100 },
    ]);
    expect(routedEdgePath(s, { x: 200, y: 100 }, waypoints)).toBe(
      "M 0,0 L 60,20 L 120,80 L 200,100",
    );
  });

  it("caches waypoint routes separately from the default route", () => {
    const target = { x: 200, y: 50 };
    expect(cachedRoutedEdgePath(s, target, [{ x: 80, y: 80 }])).toBe(
      "M 0,0 L 80,80 L 200,50",
    );
    expect(cachedRoutedEdgePath(s, target)).toBe(cachedChamferPath(s, target));
  });

  it("adds port stubs around explicit waypoint routes when positions are known", () => {
    expect(
      routedEdgePath(
        s,
        { x: 200, y: 100 },
        [{ x: 80, y: 80 }],
        { sourcePosition: "right", targetPosition: "left" },
      ),
    ).toBe("M 0,0 L 22,0 L 80,80 L 178,100 L 200,100");
  });
});

describe("isEdgeLodActive", () => {
  it("is active (simplified) below the threshold only", () => {
    expect(isEdgeLodActive(EDGE_LOD_ZOOM_THRESHOLD - 0.1)).toBe(true);
    expect(isEdgeLodActive(EDGE_LOD_ZOOM_THRESHOLD)).toBe(false);
    expect(isEdgeLodActive(1)).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isEdgeLodActive(0.8, 0.9)).toBe(true);
    expect(isEdgeLodActive(0.8, 0.5)).toBe(false);
  });
});
