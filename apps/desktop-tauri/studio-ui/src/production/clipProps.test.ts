import { describe, expect, it } from "vitest";

import {
  clampClipProperties,
  defaultClipProperties,
  isDefaultClipProperties,
  MAX_SCALE_PCT,
} from "./clipProps";

describe("clipProps", () => {
  it("defaults are recognized as default", () => {
    expect(isDefaultClipProperties(defaultClipProperties())).toBe(true);
  });

  it("any edited field is no longer default", () => {
    const props = defaultClipProperties();
    expect(isDefaultClipProperties({ ...props, transform: { ...props.transform, scalePct: 50 } })).toBe(false);
    expect(isDefaultClipProperties({ ...props, crop: { ...props.crop, leftPct: 1 } })).toBe(false);
  });

  it("clamps scale, opacity, and crop edges into range", () => {
    const props = defaultClipProperties();
    const clamped = clampClipProperties({
      transform: { ...props.transform, scalePct: 999999, opacityPct: 250 },
      crop: { leftPct: -5, topPct: 120, rightPct: 30, bottomPct: -1 },
    });
    expect(clamped.transform.scalePct).toBe(MAX_SCALE_PCT);
    expect(clamped.transform.opacityPct).toBe(100);
    expect(clamped.crop.leftPct).toBe(0);
    expect(clamped.crop.topPct).toBe(100);
    expect(clamped.crop.rightPct).toBe(30);
    expect(clamped.crop.bottomPct).toBe(0);
  });

  it("keeps opposite crop edges from inverting the window", () => {
    const props = defaultClipProperties();
    const clamped = clampClipProperties({
      transform: props.transform,
      crop: { leftPct: 70, topPct: 0, rightPct: 60, bottomPct: 0 },
    });
    expect(clamped.crop.leftPct + clamped.crop.rightPct).toBeLessThanOrEqual(100);
  });

  it("replaces non-finite fields with defaults", () => {
    const props = defaultClipProperties();
    const clamped = clampClipProperties({
      transform: { ...props.transform, rotationDeg: Number.NaN, scalePct: Number.POSITIVE_INFINITY },
      crop: props.crop,
    });
    expect(clamped.transform.rotationDeg).toBe(0);
    expect(clamped.transform.scalePct).toBe(100);
  });
});
