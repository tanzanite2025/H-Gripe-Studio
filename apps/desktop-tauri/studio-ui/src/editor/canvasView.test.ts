// M8 canvas navigation: pure zoom / pan math for the Mask-Edit view layer.

import { describe, expect, it } from "vitest";
import {
  FIT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampView,
  isFitView,
  normalizeAngle,
  panBy,
  rotateTo,
  viewTransform,
  zoom100,
  zoomAt,
  zoomIn,
  zoomOut,
} from "./canvasView";

const W = 800;
const H = 450;

describe("canvasView (M8)", () => {
  it("zoomIn/zoomOut step multiplicatively and clamp to [MIN, MAX]", () => {
    let v = zoomIn(FIT_VIEW, W, H);
    expect(v.zoom).toBeCloseTo(ZOOM_STEP);
    v = zoomOut(v, W, H);
    expect(v.zoom).toBeCloseTo(MIN_ZOOM);
    expect(isFitView(v)).toBe(true);
    // Zooming out at fit stays at fit; zooming in saturates at MAX.
    expect(zoomOut(FIT_VIEW, W, H).zoom).toBe(MIN_ZOOM);
    let max = FIT_VIEW;
    for (let i = 0; i < 20; i++) max = zoomIn(max, W, H);
    expect(max.zoom).toBe(MAX_ZOOM);
  });

  it("pan clamps so the canvas edge never passes the stage centre, collapsing at fit", () => {
    const zoomed = { zoom: 2, panX: 0, panY: 0 };
    const panned = panBy(zoomed, 10_000, -10_000, W, H);
    expect(panned.panX).toBe((W * (2 - 1)) / 2);
    expect(panned.panY).toBe(-(H * (2 - 1)) / 2);
    // At fit zoom there is nowhere to pan.
    expect(panBy(FIT_VIEW, 50, 50, W, H)).toEqual(FIT_VIEW);
    // Zooming back out re-clamps a large pan.
    const out = zoomAt(panned, 1 / 2, 0, 0, W, H);
    expect(out).toEqual(FIT_VIEW);
  });

  it("zoomAt keeps the anchor's screen position fixed", () => {
    // Anchor at (100, -50) on screen: the canvas point under it must render
    // at the same screen offset after the zoom.
    const v0 = { zoom: 2, panX: 20, panY: -10 };
    const [ax, ay] = [100, -50];
    // Canvas point (pre-scale, from centre) under the anchor.
    const px = (ax - v0.panX) / v0.zoom;
    const py = (ay - v0.panY) / v0.zoom;
    const v1 = zoomAt(v0, 1.5, ax, ay, W, H);
    expect(v1.zoom).toBeCloseTo(3);
    expect(v1.panX + v1.zoom * px).toBeCloseTo(ax);
    expect(v1.panY + v1.zoom * py).toBeCloseTo(ay);
  });

  it("zoom100 maps one image pixel to one screen pixel and never upscales past fit", () => {
    // 8K image displayed at 800 CSS px → 100% zoom is ×9.6.
    expect(zoom100(FIT_VIEW, 7680, W, H).zoom).toBeCloseTo(7680 / W);
    // A small image on a large stage stays at fit (no blurry upscale).
    expect(zoom100(FIT_VIEW, 400, W, H).zoom).toBe(MIN_ZOOM);
    // Absurd ratios still clamp to MAX.
    expect(zoom100(FIT_VIEW, 100_000, W, H).zoom).toBe(MAX_ZOOM);
  });

  it("rotateTo normalises the angle and drops a zero rotation", () => {
    expect(normalizeAngle(370)).toBe(10);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(180)).toBe(180);
    const rotated = rotateTo(FIT_VIEW, 45);
    expect(rotated).toEqual({ zoom: 1, panX: 0, panY: 0, rotate: 45 });
    expect(isFitView(rotated)).toBe(false);
    expect(viewTransform(rotated)).toBe("translate(0px, 0px) rotate(45deg) scale(1)");
    // Rotating back to 0 drops the key, so the view compares equal to FIT_VIEW.
    expect(rotateTo(rotated, 0)).toEqual(FIT_VIEW);
    expect(rotateTo(rotated, 360)).toEqual(FIT_VIEW);
    // Rotation survives zoom / pan clamping.
    expect(clampView({ zoom: 2, panX: 0, panY: 0, rotate: 30 }, W, H).rotate).toBe(30);
    expect(zoomIn(rotated, W, H).rotate).toBe(45);
  });

  it("clampView + viewTransform round-trip the CSS transform", () => {
    const v = clampView({ zoom: 4, panX: 100, panY: -60 }, W, H);
    expect(v).toEqual({ zoom: 4, panX: 100, panY: -60 });
    expect(viewTransform(v)).toBe("translate(100px, -60px) scale(4)");
    expect(isFitView(v)).toBe(false);
  });
});
