// Canvas navigation (M8): the stage's zoom/pan/rotate view, applied as a CSS
// transform on the stage frame — the render path and pointer→image mapping
// are untouched by it — plus the derived viewport view window the underlay
// renders for, Alt+wheel zoom and the Space hold-to-pan flag.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IDENTITY_VIEW, type ViewportViewState } from "../../viewport/view";
import { FIT_VIEW, WHEEL_ZOOM_STEP, viewWindow, zoomAt, type CanvasView } from "../canvasView";
import type { TransformParams } from "../maskEdit";
import type { PointerGestures } from "./pointer/types";

/** Idle time after the last view change before the underlay re-renders at
 * the new window's detail; the CSS transform carries the motion until then. */
const VIEW_SETTLE_MS = 120;

export interface CanvasNavigation {
  view: CanvasView;
  setView: React.Dispatch<React.SetStateAction<CanvasView>>;
  /** The current view, readable from event-time handlers. */
  viewRef: React.MutableRefObject<CanvasView>;
  /** The canvas's untransformed on-screen size (the clamp space for pan). */
  viewBase: () => [number, number];
  /** The view window the underlay should render for (un-debounced). */
  targetViewportView: ViewportViewState;
  /** The settled view window (debounced by VIEW_SETTLE_MS; the CSS
   * transform carries the motion in between). */
  viewportView: ViewportViewState;
  /** Space-hold pan (PS): any tool pans while Space is down. */
  spacePan: boolean;
  setSpacePan: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useCanvasNavigation(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  /** Composed image-workspace layer transform, if any: while a layer is
   * moved/scaled the displayed underlay must be the full identity frame
   * (moving a cropped window exposes a hard edge inside the stage), and the
   * settle debounce is skipped. */
  imageTransform: TransformParams | null,
  gestures: PointerGestures,
): CanvasNavigation {
  const [view, setView] = useState<CanvasView>(FIT_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;

  // The canvas's untransformed on-screen size (the clamp space for pan).
  // `offsetWidth`/`offsetHeight` are layout sizes, unaffected by the view's
  // CSS transform, so they stay correct under rotation.
  const viewBase = useCallback((): [number, number] => {
    const canvas = canvasRef.current;
    if (!canvas) return [1, 1];
    return [canvas.offsetWidth || 1, canvas.offsetHeight || 1];
  }, [canvasRef]);

  const targetViewportView = useMemo(() => {
    if (imageTransform) return IDENTITY_VIEW;
    const canvas = canvasRef.current;
    // The stage rect bounds what is visible of the transformed frame; the
    // window must cover it even when the frame's base rect is smaller.
    const stage = canvas?.closest<HTMLElement>(".mask-edit-stage");
    return viewWindow(
      view,
      canvas?.offsetWidth ?? 0,
      canvas?.offsetHeight ?? 0,
      stage?.clientWidth ?? 0,
      stage?.clientHeight ?? 0,
    );
  }, [view, imageTransform]);
  const [viewportView, setViewportView] = useState(targetViewportView);
  useEffect(() => {
    if (
      targetViewportView.zoom === viewportView.zoom &&
      targetViewportView.panX === viewportView.panX &&
      targetViewportView.panY === viewportView.panY
    )
      return;
    if (imageTransform) {
      setViewportView(targetViewportView);
      return;
    }
    const timer = setTimeout(() => setViewportView(targetViewportView), VIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [targetViewportView, viewportView, imageTransform]);

  // Alt+wheel / Ctrl+wheel zooms about the cursor with any tool in hand (PS
  // Alt+scroll). A native non-passive listener: React's synthetic `onWheel`
  // is passive at the root, so `preventDefault` (needed to stop page scroll /
  // browser pinch-zoom) would be ignored there.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY === 0 && e.deltaX === 0) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      // Alt+wheel on some platforms reports the delta on the X axis.
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const factor = delta < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      setView((v) => zoomAt(v, factor, cx, cy, ...viewBase()));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvasRef, viewBase]);

  const [spacePan, setSpacePan] = useState(false);
  // Space keyup ends the hold-to-pan (keydown arrives via the shortcut scope).
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") {
        setSpacePan(false);
        gestures.panDrag = null;
      }
    };
    window.addEventListener("keyup", up);
    return () => window.removeEventListener("keyup", up);
  }, []);

  return { view, setView, viewRef, viewBase, targetViewportView, viewportView, spacePan, setSpacePan };
}
