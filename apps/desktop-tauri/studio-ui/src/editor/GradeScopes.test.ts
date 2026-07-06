// The scopes surface's compute path: displayed RGBA8 pixels (viewport
// readback) and kernel surfaces (mirror preview) must feed the shared scope
// analysers identically. Binning maths itself is pinned by the scope goldens
// in gradeKernel.golden.test.ts.

import { describe, expect, it } from "vitest";

import {
  computeScopes,
  computeScopesFromRgba8,
  SCOPE_HISTOGRAM_BINS,
  SCOPE_VECTORSCOPE_SIZE,
  SCOPE_WAVEFORM_COLS,
  SCOPE_WAVEFORM_ROWS,
} from "./GradeScopes";

describe("computeScopesFromRgba8", () => {
  it("measures the displayed frame at the fixed scope resolutions", () => {
    // 2x1: pure black and pure white pixels.
    const pixels = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const scopes = computeScopesFromRgba8(pixels, 2, 1);
    expect(scopes.histogram.bins).toBe(SCOPE_HISTOGRAM_BINS);
    expect(scopes.waveform.cols).toBe(SCOPE_WAVEFORM_COLS);
    expect(scopes.waveform.rows).toBe(SCOPE_WAVEFORM_ROWS);
    expect(scopes.vectorscope.size).toBe(SCOPE_VECTORSCOPE_SIZE);
    // Black in the first bucket, white in the last; two pixels total.
    expect(scopes.histogram.luma[0]).toBe(1);
    expect(scopes.histogram.luma[SCOPE_HISTOGRAM_BINS - 1]).toBe(1);
    expect(scopes.histogram.luma.reduce((a, b) => a + b, 0)).toBe(2);
    // Both are neutral: the vectorscope's centre cell holds every count.
    const centre =
      (SCOPE_VECTORSCOPE_SIZE / 2) * SCOPE_VECTORSCOPE_SIZE + SCOPE_VECTORSCOPE_SIZE / 2;
    expect(scopes.vectorscope.counts[centre]).toBe(2);
  });

  it("matches computeScopes over the equivalent kernel surface", () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 255]);
    const data = new Float32Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) data[i] = pixels[i] / 255;
    const fromBytes = computeScopesFromRgba8(pixels, 2, 2);
    const fromSurface = computeScopes({ w: 2, h: 2, data, space: "srgb" });
    expect(fromBytes.histogram).toEqual(fromSurface.histogram);
    expect(fromBytes.waveform).toEqual(fromSurface.waveform);
    expect(fromBytes.vectorscope).toEqual(fromSurface.vectorscope);
  });

  it("puts each channel's waveform counts in the mapped column", () => {
    // 2x1: left pixel dark red, right pixel bright red.
    const pixels = new Uint8Array([64, 0, 0, 255, 255, 0, 0, 255]);
    const wf = computeScopesFromRgba8(pixels, 2, 1).waveform;
    const leftCols = SCOPE_WAVEFORM_COLS / 2;
    // One red count in the left half, one in the right; rows differ.
    let leftCount = 0;
    let rightCount = 0;
    for (let row = 0; row < wf.rows; row++) {
      for (let col = 0; col < wf.cols; col++) {
        const c = wf.r[row * wf.cols + col];
        if (col < leftCols) leftCount += c;
        else rightCount += c;
      }
    }
    expect(leftCount).toBe(1);
    expect(rightCount).toBe(1);
  });
});
