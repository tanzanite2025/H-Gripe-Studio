import { describe, expect, it } from "vitest";

import { defaultClipProperties, type ClipProperties } from "./clipProps";
import fixtures from "./clipPropsKeyframeFixtures.json";
import {
  evaluateClipProp,
  hasKeyframeAt,
  keyframesFor,
  resolveClipPropertiesAt,
  setClipPropValueAt,
  toggleKeyframe,
  type ClipPropPath,
} from "./keyframes";

const EPS = 1 / 48; // half a frame at 24fps

function animated(): ClipProperties {
  return {
    ...defaultClipProperties(),
    tracks: {
      "transform.scalePct": [
        { t: 1, v: 100 },
        { t: 3, v: 50 },
      ],
    },
  };
}

describe("keyframes", () => {
  it("matches the shared fixtures with the Rust evaluator", () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
    for (const testCase of fixtures.cases) {
      for (const sample of testCase.samples) {
        const got = evaluateClipProp(
          testCase.doc as ClipProperties,
          sample.path as ClipPropPath,
          sample.t,
        );
        expect
          .soft(got, `${testCase.name}: ${sample.path} at t=${sample.t}`)
          .toBeCloseTo(sample.expected, 9);
      }
    }
  });

  it("resolving strips the tracks and clamps like the static document", () => {
    const resolved = resolveClipPropertiesAt(animated(), 2);
    expect(resolved.tracks).toBeUndefined();
    expect(resolved.transform.scalePct).toBe(75);
  });

  it("toggling adds a key carrying the evaluated value, toggling again removes it", () => {
    const withKey = toggleKeyframe(animated(), "transform.scalePct", 2, EPS);
    expect(keyframesFor(withKey, "transform.scalePct")).toEqual([
      { t: 1, v: 100 },
      { t: 2, v: 75 },
      { t: 3, v: 50 },
    ]);
    expect(hasKeyframeAt(withKey, "transform.scalePct", 2, EPS)).toBe(true);

    const removed = toggleKeyframe(withKey, "transform.scalePct", 2.01, EPS);
    expect(keyframesFor(removed, "transform.scalePct")).toEqual([
      { t: 1, v: 100 },
      { t: 3, v: 50 },
    ]);
  });

  it("removing the last key drops the track (and the tracks object)", () => {
    let props = toggleKeyframe(defaultClipProperties(), "transform.opacityPct", 1, EPS);
    expect(keyframesFor(props, "transform.opacityPct")).toEqual([{ t: 1, v: 100 }]);
    props = toggleKeyframe(props, "transform.opacityPct", 1, EPS);
    expect(props.tracks).toBeUndefined();
  });

  it("committing a value on an animated property upserts a key at the playhead", () => {
    const upserted = setClipPropValueAt(animated(), "transform.scalePct", 3, 40, EPS);
    expect(keyframesFor(upserted, "transform.scalePct")).toEqual([
      { t: 1, v: 100 },
      { t: 3, v: 40 },
    ]);
  });

  it("committing a value on a static property just sets the document value", () => {
    const set = setClipPropValueAt(defaultClipProperties(), "crop.leftPct", 2, 25, EPS);
    expect(set.tracks).toBeUndefined();
    expect(set.crop.leftPct).toBe(25);
  });
});
