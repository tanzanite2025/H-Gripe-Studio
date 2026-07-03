import { describe, expect, it } from "vitest";

import {
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  clampAudioEdit,
  defaultAudioEdit,
  editedDuration,
  envelopeAt,
  gainScalar,
} from "./audioEdit";

describe("defaultAudioEdit / editedDuration", () => {
  it("defaults to the whole source, unity gain, no fades", () => {
    const edit = defaultAudioEdit();
    expect(edit).toEqual({ trimStartSec: 0, trimEndSec: null, gainDb: 0, fadeInSec: 0, fadeOutSec: 0 });
    expect(editedDuration(edit, 12)).toBe(12);
  });

  it("computes trimmed length and clamps to the minimum clip length", () => {
    expect(editedDuration({ ...defaultAudioEdit(), trimStartSec: 2, trimEndSec: 7 }, 12)).toBe(5);
    expect(editedDuration({ ...defaultAudioEdit(), trimStartSec: 11.99 }, 12)).toBeGreaterThan(0);
  });
});

describe("clampAudioEdit", () => {
  it("clamps the trim window inside the source", () => {
    const clamped = clampAudioEdit(
      { trimStartSec: -3, trimEndSec: 99, gainDb: 0, fadeInSec: 0, fadeOutSec: 0 },
      10,
    );
    expect(clamped.trimStartSec).toBe(0);
    expect(clamped.trimEndSec).toBe(10);
  });

  it("keeps a null trim end when it stays at the source end", () => {
    const clamped = clampAudioEdit(defaultAudioEdit(), 10);
    expect(clamped.trimEndSec).toBeNull();
  });

  it("clamps gain to the dB range", () => {
    expect(clampAudioEdit({ ...defaultAudioEdit(), gainDb: 99 }, 10).gainDb).toBe(MAX_GAIN_DB);
    expect(clampAudioEdit({ ...defaultAudioEdit(), gainDb: -99 }, 10).gainDb).toBe(MIN_GAIN_DB);
  });

  it("scales fades down so they fit the trimmed length", () => {
    const clamped = clampAudioEdit(
      { trimStartSec: 0, trimEndSec: 4, gainDb: 0, fadeInSec: 6, fadeOutSec: 2 },
      10,
    );
    expect(clamped.fadeInSec + clamped.fadeOutSec).toBeCloseTo(4);
    expect(clamped.fadeInSec / clamped.fadeOutSec).toBeCloseTo(3);
  });

  it("rejects negative fades", () => {
    const clamped = clampAudioEdit({ ...defaultAudioEdit(), fadeInSec: -1, fadeOutSec: -2 }, 10);
    expect(clamped.fadeInSec).toBe(0);
    expect(clamped.fadeOutSec).toBe(0);
  });
});

describe("gainScalar / envelopeAt", () => {
  it("maps dB to a linear scalar", () => {
    expect(gainScalar(0)).toBe(1);
    expect(gainScalar(6)).toBeCloseTo(1.995, 2);
    expect(gainScalar(-6)).toBeCloseTo(0.501, 2);
  });

  it("ramps linearly through fades and holds 1 between them", () => {
    const edit = { trimStartSec: 0, trimEndSec: 10, gainDb: 0, fadeInSec: 2, fadeOutSec: 4 };
    expect(envelopeAt(edit, 10, 0)).toBe(0);
    expect(envelopeAt(edit, 10, 1)).toBeCloseTo(0.5);
    expect(envelopeAt(edit, 10, 3)).toBe(1);
    expect(envelopeAt(edit, 10, 8)).toBeCloseTo(0.5);
    expect(envelopeAt(edit, 10, 10)).toBe(0);
  });

  it("is zero outside the trimmed window", () => {
    const edit = { trimStartSec: 2, trimEndSec: 8, gainDb: 0, fadeInSec: 0, fadeOutSec: 0 };
    expect(envelopeAt(edit, 10, -0.1)).toBe(0);
    expect(envelopeAt(edit, 10, 6.1)).toBe(0);
    expect(envelopeAt(edit, 10, 3)).toBe(1);
  });
});
