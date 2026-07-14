// Canvas navigation (M8): camera-only zoom/pan/rotate state plus the derived
// retained viewport window, Alt+wheel zoom and Space hold-to-pan. World
// projection consumes this state; document and pixel target identity do not.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ViewportViewState } from "../../viewport/view";
import { FIT_VIEW, WHEEL_ZOOM_STEP, viewWindow, zoomAt, type CanvasView } from "../canvasView";
import type { PointerGestures } from "./pointer/types";
import type { SceneFrame } from "./sceneFrame";
import { viewportWindowForWorld } from "./stageProjection";

/** Idle time after the last view change before the underlay re-renders at
 * the new window's detail; the CSS transform carries the motion until then. */
const VIEW_SETTLE_MS = 120;

export interface CanvasNavigation {
  view: CanvasView;
  setView: React.Dispatch<React.SetStateAction<CanvasView>>;
  /** The current view, readable from event-time handlers. */
  viewRef: React.MutableRefObject<CanvasView>;
  /** The canvas's untransformed on-screen size for zoom anchoring. */
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

export interface CanvasNavigationLayout {
  /** Fitted document/crop size at camera zoom 1. */
  baseW: number;
  baseH: number;
  /** Visible stage dimensions used to choose the retained viewport window. */
  stageW: number;
  stageH: number;
  /** Stable retained scene and the frame fitted by the DOM camera. When both
   * are present, the viewport window is normalized to the scene, not the
   * document child. */
  viewportWorldFrame?: SceneFrame;
  viewportFitFrame?: SceneFrame;
  /** Changes whenever document/world geometry changes at the same CSS size. */
  revision: string;
}

export function useCanvasNavigation(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  gestures: PointerGestures,
  layout: CanvasNavigationLayout | null = null,
): CanvasNavigation {
  const [view, setView] = useState<CanvasView>(FIT_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;

  // The canvas's untransformed on-screen size for zoom anchoring.
  // `offsetWidth`/`offsetHeight` are layout sizes, unaffected by the view's
  // CSS transform, so they stay correct under rotation.
  const viewBase = useCallback((): [number, number] => {
    if (layout && layout.baseW > 0 && layout.baseH > 0) {
      return [layout.baseW, layout.baseH];
    }
    const canvas = canvasRef.current;
    if (!canvas) return [1, 1];
    return [canvas.offsetWidth || 1, canvas.offsetHeight || 1];
  }, [canvasRef, layout?.baseW, layout?.baseH, layout?.revision]);

  const targetViewportView = useMemo(() => {
    const canvas = canvasRef.current;
    const stage = layout ? null : canvas?.closest<HTMLElement>(".image-editor-stage");
    const baseW = layout?.baseW ?? canvas?.offsetWidth ?? 0;
    const baseH = layout?.baseH ?? canvas?.offsetHeight ?? 0;
    const stageW = layout?.stageW ?? stage?.clientWidth ?? 0;
    const stageH = layout?.stageH ?? stage?.clientHeight ?? 0;
    if (layout?.viewportWorldFrame && layout.viewportFitFrame) {
      return viewportWindowForWorld(
        { w: stageW, h: stageH },
        layout.viewportWorldFrame,
        layout.viewportFitFrame,
        view,
      );
    }
    return viewWindow(
      view,
      baseW,
      baseH,
      stageW,
      stageH,
    );
  }, [
    view,
    layout?.baseW,
    layout?.baseH,
    layout?.stageW,
    layout?.stageH,
    layout?.revision,
  ]);
  const [viewportView, setViewportView] = useState(targetViewportView);
  useEffect(() => {
    if (
      targetViewportView.zoom === viewportView.zoom &&
      targetViewportView.panX === viewportView.panX &&
      targetViewportView.panY === viewportView.panY
    )
      return;
    const timer = setTimeout(() => setViewportView(targetViewportView), VIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [targetViewportView, viewportView]);

  // Alt+wheel / Ctrl+wheel zooms about the cursor with any tool in hand (PS
  // Alt+scroll). A native non-passive listener: React's synthetic `onWheel`
  // is passive at the root, so `preventDefault` (needed to stop page scroll /
  // browser pinch-zoom) would be ignored there.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheelTarget = canvas.closest<HTMLElement>(".image-editor-stage") ?? canvas;
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
      // The bounding rect reflects the view transform, so its centre sits at
      // base centre + pan; `zoomAt` anchors from the untransformed centre.
      setView((v) => zoomAt(v, factor, cx + v.panX, cy + v.panY, ...viewBase()));
    };
    wheelTarget.addEventListener("wheel", onWheel, { passive: false });
    return () => wheelTarget.removeEventListener("wheel", onWheel);
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
