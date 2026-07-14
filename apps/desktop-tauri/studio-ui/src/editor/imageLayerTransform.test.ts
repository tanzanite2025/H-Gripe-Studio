import { describe, expect, it } from "vitest";
import fixtures from "./imageDocumentContractFixtures.json";
import { composeTransforms } from "./imageLayerTransform";

describe("composeTransforms", () => {
  it("composes translations additively", () => {
    expect(
      composeTransforms({ dx: 10, dy: 5, scale: 1, rotate: 0 }, { dx: -4, dy: 3, scale: 1, rotate: 0 }),
    ).toEqual({ dx: 6, dy: 8, scale: 1, rotate: 0 });
  });

  it("carries the earlier translation through the later rotation and scale", () => {
    const transform = composeTransforms(
      { dx: 10, dy: 0, scale: 1, rotate: 0 },
      { dx: 0, dy: 0, scale: 2, rotate: 90 },
    );
    expect(transform.dx).toBeCloseTo(0);
    expect(transform.dy).toBeCloseTo(20);
    expect(transform.scale).toBe(2);
    expect(transform.rotate).toBe(90);
  });

  it("matches the shared transform-compose contract", () => {
    expect(fixtures.transformComposeCases.length).toBeGreaterThan(0);
    for (const testCase of fixtures.transformComposeCases) {
      const composed = composeTransforms(testCase.a, testCase.b);
      expect(composed.dx, testCase.name).toBeCloseTo(testCase.expected.dx, 4);
      expect(composed.dy, testCase.name).toBeCloseTo(testCase.expected.dy, 4);
      expect(composed.scale, testCase.name).toBeCloseTo(testCase.expected.scale, 4);
      expect(composed.rotate, testCase.name).toBeCloseTo(testCase.expected.rotate, 4);
    }
  });
});
