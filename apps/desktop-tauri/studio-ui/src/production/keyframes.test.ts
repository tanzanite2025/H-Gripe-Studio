import { describe, expect, it } from "vitest";

import { defaultClipProperties, type ClipProperties } from "./clipProps";
import fixtures from "./clipPropsKeyframeFixtures.json";
import {
  DEFAULT_BEZIER_CONTROL_POINTS,
  effectiveKeyframeInterpolation,
  evaluateClipProp,
  hasKeyframeAt,
  keyframeAt,
  keyframesFor,
  moveKeyframesAtTime,
  removeKeyframesAtTime,
  resolveClipPropertiesAt,
  setClipPropValueAt,
  setKeyframeInterpolationAt,
  toggleKeyframe,
  timelineKeyframeGroups,
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

  it("changes a key's outgoing interpolation and supplies bezier controls", () => {
    const eased = setKeyframeInterpolationAt(
      animated(),
      "transform.scalePct",
      1,
      EPS,
      "bezier",
    );
    const key = keyframeAt(eased, "transform.scalePct", 1, EPS);
    expect(key?.interp).toBe("bezier");
    expect(key?.bezier).toEqual(DEFAULT_BEZIER_CONTROL_POINTS);
    expect(effectiveKeyframeInterpolation(key!)).toBe("bezier");

    const held = setKeyframeInterpolationAt(eased, "transform.scalePct", 1, EPS, "hold");
    expect(keyframeAt(held, "transform.scalePct", 1, EPS)).toEqual({
      t: 1,
      v: 100,
      interp: "hold",
    });
  });

  it("preserves interpolation metadata when editing a key's value", () => {
    const eased = setKeyframeInterpolationAt(
      animated(),
      "transform.scalePct",
      1,
      EPS,
      "bezier",
    );
    const edited = setClipPropValueAt(eased, "transform.scalePct", 1, 90, EPS);
    expect(keyframeAt(edited, "transform.scalePct", 1, EPS)).toEqual({
      t: 1,
      v: 90,
      interp: "bezier",
      bezier: DEFAULT_BEZIER_CONTROL_POINTS,
    });
  });

  it("groups lane diamonds by time and retimes every property in the group", () => {
    const props: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 1, v: 80, interp: "hold" }],
        "transform.opacityPct": [{ t: 1, v: 50 }],
        "crop.leftPct": [{ t: 3, v: 10 }],
      },
    };
    expect(timelineKeyframeGroups(props, EPS)).toEqual([
      { t: 1, count: 2 },
      { t: 3, count: 1 },
    ]);

    const moved = moveKeyframesAtTime(props, 1, 2, EPS);
    expect(keyframesFor(moved, "transform.scalePct")).toEqual([
      { t: 2, v: 80, interp: "hold" },
    ]);
    expect(keyframesFor(moved, "transform.opacityPct")).toEqual([{ t: 2, v: 50 }]);
    expect(keyframesFor(moved, "crop.leftPct")).toEqual([{ t: 3, v: 10 }]);
  });

  it("deletes every property keyframe at a lane diamond", () => {
    const props: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 1, v: 80 }],
        "transform.opacityPct": [{ t: 1, v: 50 }],
        "crop.leftPct": [{ t: 3, v: 10 }],
      },
    };
    const removed = removeKeyframesAtTime(props, 1, EPS);
    expect(keyframesFor(removed, "transform.scalePct")).toEqual([]);
    expect(keyframesFor(removed, "transform.opacityPct")).toEqual([]);
    expect(keyframesFor(removed, "crop.leftPct")).toEqual([{ t: 3, v: 10 }]);
  });
});
