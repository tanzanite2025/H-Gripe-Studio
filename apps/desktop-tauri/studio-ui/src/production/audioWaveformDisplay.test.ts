import { describe, expect, it } from "vitest";

import {
  sliceWaveformPeaksToTrimmedSourceWindow,
  waveformPolygonPointsFromPeaks,
} from "./audioWaveformDisplay";

describe("sliceWaveformPeaksToTrimmedSourceWindow", () => {
  const fullSourcePeaks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  it("returns the full peaks when the window covers the whole source", () => {
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 0, 8, 8)).toEqual(
      fullSourcePeaks,
    );
  });

  it("returns the buckets covering a middle trim window", () => {
    // 8 s source, 8 buckets: seconds [2, 5) map to buckets 2..4.
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 2, 5, 8)).toEqual([
      0.3, 0.4, 0.5,
    ]);
  });

  it("clamps the window to the source bounds", () => {
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, -3, 99, 8)).toEqual(
      fullSourcePeaks,
    );
  });

  it("returns at least one bucket for a tiny non-empty window", () => {
    const sliced = sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 3.1, 3.2, 8);
    expect(sliced.length).toBeGreaterThan(0);
    expect(sliced).toContain(0.4);
  });

  it("returns empty for an empty or inverted window, or empty peaks", () => {
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 4, 4, 8)).toEqual([]);
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 6, 2, 8)).toEqual([]);
    expect(sliceWaveformPeaksToTrimmedSourceWindow([], 0, 8, 8)).toEqual([]);
    expect(sliceWaveformPeaksToTrimmedSourceWindow(fullSourcePeaks, 0, 8, 0)).toEqual([]);
  });
});

describe("waveformPolygonPointsFromPeaks", () => {
  it("anchors the outline to the baseline at both ends", () => {
    const points = waveformPolygonPointsFromPeaks([0.5, 1], 100, 60);
    expect(points.startsWith("0,60 ")).toBe(true);
    expect(points.endsWith(" 100,60")).toBe(true);
  });

  it("lifts each bucket's point by its peak amplitude", () => {
    // Two buckets across a 100x60 view box: x = 0 and x = 100.
    expect(waveformPolygonPointsFromPeaks([0.5, 1], 100, 60)).toBe(
      "0,60 0.00,30.00 100.00,0.00 100,60",
    );
  });

  it("centers a single bucket and clamps peaks into 0..1", () => {
    expect(waveformPolygonPointsFromPeaks([2], 100, 60)).toBe("0,60 50.00,0.00 100,60");
    expect(waveformPolygonPointsFromPeaks([-1], 100, 60)).toBe("0,60 50.00,60.00 100,60");
  });

  it("returns an empty string for no peaks", () => {
    expect(waveformPolygonPointsFromPeaks([], 100, 60)).toBe("");
  });
});
