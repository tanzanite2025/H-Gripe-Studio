// Scopes surface for the grading panel (WGPU migration: scopes on top of
// the viewport presentation). Scope data is measured from the displayed
// frame — explicit pixel readback through the viewport host on desktop
// (surface swap Phase S4), or the mirror preview's graded surface in the
// browser preview — and rendered onto small canvases. Read-only analysers:
// the binning maths lives in the shared grade kernel (`gradeKernel/scopes`),
// pinned bit-identical to Rust by the scope goldens.

import { useEffect, useRef } from "react";

import { useT } from "../i18n";
import {
  histogramScope,
  vectorscopeScope,
  waveformScope,
  type GradeSurface,
  type HistogramScope,
  type VectorscopeScope,
  type WaveformScope,
} from "./gradeKernel";

/** Scope resolutions: fixed so re-computes stay cheap and comparable. */
export const SCOPE_HISTOGRAM_BINS = 256;
export const SCOPE_WAVEFORM_COLS = 256;
export const SCOPE_WAVEFORM_ROWS = 128;
export const SCOPE_VECTORSCOPE_SIZE = 128;

/** One frame's scope data, ready to draw. */
export interface ScopeData {
  histogram: HistogramScope;
  waveform: WaveformScope;
  vectorscope: VectorscopeScope;
}

/** Scopes of a graded kernel surface (mirror preview path). */
export function computeScopes(surface: GradeSurface): ScopeData {
  return {
    histogram: histogramScope(surface, SCOPE_HISTOGRAM_BINS),
    waveform: waveformScope(surface, SCOPE_WAVEFORM_COLS, SCOPE_WAVEFORM_ROWS),
    vectorscope: vectorscopeScope(surface, SCOPE_VECTORSCOPE_SIZE),
  };
}

/** Scopes of a displayed RGBA8 frame (viewport pixel readback path). */
export function computeScopesFromRgba8(pixels: Uint8Array, w: number, h: number): ScopeData {
  const data = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) data[i] = pixels[i] / 255;
  return computeScopes({ w, h, data, space: "srgb" });
}

// Perceptual intensity for count cells: sqrt keeps sparse detail visible
// without a per-scope gain control.
function cellIntensity(count: number, max: number): number {
  return max > 0 ? Math.sqrt(count / max) : 0;
}

function drawHistogram(canvas: HTMLCanvasElement, hist: HistogramScope) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#0b0d13";
  ctx.fillRect(0, 0, width, height);
  const planes: Array<[Uint32Array, string]> = [
    [hist.luma, "rgba(160, 160, 160, 0.55)"],
    [hist.r, "rgba(255, 64, 64, 0.75)"],
    [hist.g, "rgba(64, 255, 64, 0.75)"],
    [hist.b, "rgba(80, 128, 255, 0.75)"],
  ];
  ctx.globalCompositeOperation = "lighter";
  for (const [bins, color] of planes) {
    let max = 0;
    for (const c of bins) if (c > max) max = c;
    if (max === 0) continue;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < bins.length; i++) {
      const x = ((i + 0.5) / bins.length) * width;
      const y = height - cellIntensity(bins[i], max) * height;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawWaveform(canvas: HTMLCanvasElement, wf: WaveformScope) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { cols, rows } = wf;
  canvas.width = cols;
  canvas.height = rows;
  const img = ctx.createImageData(cols, rows);
  const planes = [wf.r, wf.g, wf.b];
  const maxes = planes.map((p) => {
    let max = 0;
    for (const c of p) if (c > max) max = c;
    return max;
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Row 0 is signal 0 (black): paint it at the canvas bottom.
      const src = row * cols + col;
      const dst = ((rows - 1 - row) * cols + col) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[dst + c] = Math.round(cellIntensity(planes[c][src], maxes[c]) * 255);
      }
      img.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawVectorscope(canvas: HTMLCanvasElement, vs: VectorscopeScope) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = vs.size;
  canvas.width = size;
  canvas.height = size;
  const img = ctx.createImageData(size, size);
  let max = 0;
  for (const c of vs.counts) if (c > max) max = c;
  for (let i = 0; i < vs.counts.length; i++) {
    const v = cellIntensity(vs.counts[i], max);
    const dst = i * 4;
    img.data[dst] = Math.round(v * 190);
    img.data[dst + 1] = Math.round(v * 255);
    img.data[dst + 2] = Math.round(v * 190);
    img.data[dst + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Graticule: centre crosshair (neutral grays) over the chroma field.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
}

/** The three Resolve-style scopes over the current preview frame. */
export function GradeScopes({ scopes }: { scopes: ScopeData }) {
  const t = useT();
  const histRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const vectorRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (histRef.current) drawHistogram(histRef.current, scopes.histogram);
    if (waveRef.current) drawWaveform(waveRef.current, scopes.waveform);
    if (vectorRef.current) drawVectorscope(vectorRef.current, scopes.vectorscope);
  }, [scopes]);

  return (
    <div className="grade-scopes">
      <figure className="grade-scope">
        <canvas ref={histRef} width={SCOPE_HISTOGRAM_BINS} height={SCOPE_WAVEFORM_ROWS} />
        <figcaption>{t("grade.scopeHistogram")}</figcaption>
      </figure>
      <figure className="grade-scope">
        <canvas ref={waveRef} width={SCOPE_WAVEFORM_COLS} height={SCOPE_WAVEFORM_ROWS} />
        <figcaption>{t("grade.scopeWaveform")}</figcaption>
      </figure>
      <figure className="grade-scope">
        <canvas ref={vectorRef} width={SCOPE_VECTORSCOPE_SIZE} height={SCOPE_VECTORSCOPE_SIZE} />
        <figcaption>{t("grade.scopeVectorscope")}</figcaption>
      </figure>
    </div>
  );
}
