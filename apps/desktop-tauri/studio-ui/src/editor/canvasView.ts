// Canvas navigation for the Mask-Edit modal (M8 view layer): zoom / pan state
// and its pure math, PS-aligned (H hand pan, Z zoom tool, Space-hold pan,
// Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+1).
//
// The view never touches the document or the render path: it is applied as a
// CSS transform on the canvas element, so pointer→image mapping through
// `getBoundingClientRect()` (which reflects transforms) keeps working
// unchanged, and the M7 proxy/tile pipeline is untouched. Pure helpers here;
// the modal owns the React state.

import {
  clampView as clampViewportView,
  IDENTITY_VIEW,
  MAX_VIEW_ZOOM,
  type ViewportViewState,
} from "../viewport/view";

/**
 * The canvas view: `zoom` relative to fit (1 = fit, below 1 zooms out to a
 * letterboxed image, PS-style), pan offsets in pre-scale CSS px,
 * `rotate` an optional view rotation in degrees (PS rotate-view: purely a
 * screen-space transform, never part of the document; absent ⇒ 0).
 */
export interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
  rotate?: number;
}

/** Fit-on-screen: the canvas fills its stage slot, unpanned. */
export const FIT_VIEW: CanvasView = { zoom: 1, panX: 0, panY: 0 };

export const MIN_ZOOM = 1 / 16;
export const MAX_ZOOM = 16;
/** Multiplicative zoom step per Ctrl+= / Ctrl+- / zoom-tool click. */
export const ZOOM_STEP = 1.5;
/** Multiplicative zoom step per Alt/Ctrl+wheel notch (finer than a click). */
export const WHEEL_ZOOM_STEP = 1.2;

const EPS = 1e-9;

/** `transform` value for the canvas element (origin must be `center`). */
export function viewTransform(view: CanvasView): string {
  const rotate = view.rotate ? ` rotate(${view.rotate}deg)` : "";
  return `translate(${view.panX}px, ${view.panY}px)${rotate} scale(${view.zoom})`;
}

export function isFitView(view: CanvasView): boolean {
  return Math.abs(view.zoom - 1) <= EPS && view.panX === 0 && view.panY === 0 && !view.rotate;
}

/** Normalise an angle in degrees to (-180, 180]. */
export function normalizeAngle(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Set the view rotation (degrees, normalised). Zoom / pan are untouched;
 * a zero rotation drops the key so fit views compare equal to `FIT_VIEW`.
 */
export function rotateTo(view: CanvasView, deg: number): CanvasView {
  const rotate = normalizeAngle(deg);
  const { rotate: _drop, ...rest } = view;
  return rotate === 0 ? rest : { ...rest, rotate };
}

/**
 * Clamp the view: zoom into [MIN, MAX]; pan so the scaled canvas never pulls
 * an edge past the stage centre line (the surrounding letterbox shows,
 * PS-style) — at or below fit zoom the image stays centred and the pan
 * collapses to 0. `baseW`/`baseH` are the canvas's *untransformed* displayed
 * CSS size.
 */
export function clampView(view: CanvasView, baseW: number, baseH: number): CanvasView {
  const zoom = Math.min(Math.max(view.zoom, MIN_ZOOM), MAX_ZOOM);
  // The pan range opens up with zoom: none at or below fit, ramping until at
  // 2× and beyond an image edge can be pulled all the way to the stage centre
  // (`zoom / 2`), so the canvas beside it shows — PS scroll bounds.
  const slack = Math.max(0, Math.min(zoom - 1, zoom / 2));
  const maxX = baseW * slack;
  const maxY = baseH * slack;
  // `+ 0` normalises a clamped-to-`-0` pan so fit views compare equal.
  return {
    zoom,
    panX: Math.min(Math.max(view.panX, -maxX), maxX) + 0,
    panY: Math.min(Math.max(view.panY, -maxY), maxY) + 0,
    ...(view.rotate ? { rotate: view.rotate } : {}),
  };
}

/**
 * Zoom by `factor` anchored at (`cx`, `cy`) — offsets from the canvas centre
 * in on-screen (post-transform) CSS px — so the pixel under the cursor stays
 * put (PS zoom-tool behaviour). Anchor (0, 0) zooms about the centre.
 *
 * A canvas point p (pre-scale px from centre) renders at `pan + zoom · p`;
 * keeping the anchor's screen position fixed across `zoom → zoom'` gives
 * `pan' = pan + (1 − zoom'/zoom) · (anchor − pan)`.
 */
export function zoomAt(
  view: CanvasView,
  factor: number,
  cx: number,
  cy: number,
  baseW: number,
  baseH: number,
): CanvasView {
  const zoom = Math.min(Math.max(view.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  const ratio = zoom / view.zoom;
  return clampView(
    {
      ...view,
      zoom,
      panX: view.panX + (1 - ratio) * (cx - view.panX),
      panY: view.panY + (1 - ratio) * (cy - view.panY),
    },
    baseW,
    baseH,
  );
}

export function zoomIn(view: CanvasView, baseW: number, baseH: number): CanvasView {
  return zoomAt(view, ZOOM_STEP, 0, 0, baseW, baseH);
}

export function zoomOut(view: CanvasView, baseW: number, baseH: number): CanvasView {
  return zoomAt(view, 1 / ZOOM_STEP, 0, 0, baseW, baseH);
}

/**
 * 100% zoom (Ctrl+1): one image pixel = one screen pixel, i.e.
 * `zoom = imageW / baseW` (clamped; a small image on a large stage shrinks
 * below fit to its actual pixels, PS-style).
 */
export function zoom100(view: CanvasView, imageW: number, baseW: number, baseH: number): CanvasView {
  const zoom = baseW > 0 ? imageW / baseW : MIN_ZOOM;
  return clampView({ ...view, zoom }, baseW, baseH);
}

/** Pan by an on-screen drag delta (hand tool / Space-drag). */
export function panBy(view: CanvasView, dx: number, dy: number, baseW: number, baseH: number): CanvasView {
  return clampView({ ...view, panX: view.panX + dx, panY: view.panY + dy }, baseW, baseH);
}

/**
 * The viewport-host view window backing this canvas view: the visible region
 * of the canvas as a normalized `1/zoom` window, so a zoomed canvas presents
 * an underlay decoded at matching detail (WGPU migration: underlay detail
 * follows canvas zoom; the recorded pixel space is untouched).
 *
 * A canvas point p (pre-scale px from centre) renders at `pan + zoom · p`, so
 * the visible window's centre in normalized canvas coordinates is
 * `0.5 − pan / (base · zoom)`. Under a rotated view the visible region is not
 * an axis-aligned window, so the full frame is kept.
 *
 * The stage can outsize the frame's base rect (an image capped at its natural
 * pixels, or a fit constrained on only one axis): the region on screen then
 * spans more of the frame than `1/zoom`. `stageW`/`stageH` widen the window
 * by the covering ratio so it holds everything visible — a window smaller
 * than the screen would crop the frame to its rect.
 */
export function viewWindow(
  view: CanvasView,
  baseW: number,
  baseH: number,
  stageW = baseW,
  stageH = baseH,
): ViewportViewState {
  if (view.rotate || baseW <= 0 || baseH <= 0) return IDENTITY_VIEW;
  const cover = Math.max(stageW / baseW, stageH / baseH, 1);
  const zoom = Math.min(view.zoom / cover, MAX_VIEW_ZOOM);
  if (zoom <= 1) return IDENTITY_VIEW;
  const cx = 0.5 - view.panX / (baseW * view.zoom);
  const cy = 0.5 - view.panY / (baseH * view.zoom);
  return clampViewportView({
    zoom,
    panX: cx - 1 / (2 * zoom),
    panY: cy - 1 / (2 * zoom),
  });
}
