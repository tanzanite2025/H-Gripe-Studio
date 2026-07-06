import { describe, expect, it } from "vitest";
import { pupilOffset } from "./EyesIcon";

describe("pupilOffset", () => {
  it("is zero when the cursor sits on the eye", () => {
    expect(pupilOffset(10, 10, 10, 10, 2)).toEqual({ dx: 0, dy: 0 });
  });

  it("points toward the cursor and clamps to max", () => {
    const right = pupilOffset(0, 0, 500, 0, 2);
    expect(right.dx).toBeCloseTo(2);
    expect(right.dy).toBeCloseTo(0);
    const down = pupilOffset(0, 0, 0, 500, 2);
    expect(down.dx).toBeCloseTo(0);
    expect(down.dy).toBeCloseTo(2);
  });

  it("scales down for a nearby cursor so the gaze eases in", () => {
    const near = pupilOffset(0, 0, 40, 0, 2);
    expect(near.dx).toBeGreaterThan(0);
    expect(near.dx).toBeLessThan(2);
    expect(near.dy).toBeCloseTo(0);
  });

  it("normalizes diagonals (never exceeds max distance)", () => {
    const { dx, dy } = pupilOffset(0, 0, 300, 300, 2);
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(2 + 1e-9);
    expect(dx).toBeCloseTo(dy);
  });
});
