// Shared zoom/pan interaction for viewport-consuming stages (WGPU migration
// Phase 2 view state). Every surface behaves the same: cursor-anchored wheel
// zoom, drag pan when zoomed, double-click reset, grab/grabbing cursor. The
// hook owns the view state and the pointer wiring; the caller spreads
// `stageProps` onto its stage element and passes `view` to the underlay.

import { useRef, useState } from "react";
import { IDENTITY_VIEW, panView, zoomViewAt, type ViewportViewState } from "./view";

export interface ViewControls {
  view: ViewportViewState;
  setView: React.Dispatch<React.SetStateAction<ViewportViewState>>;
  resetView: () => void;
  /** Spread onto the stage element that hosts the presented frame. */
  stageProps: {
    ref: React.RefObject<HTMLDivElement>;
    onWheel: (e: React.WheelEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onDoubleClick: () => void;
    style: React.CSSProperties | undefined;
  };
}

/**
 * Zoom/pan controls for one stage. `enabled` gates the interaction (e.g. no
 * frame yet, or a non-image target): while false the wheel does nothing and
 * the view can still be reset by the caller.
 */
export function useViewControls(enabled = true): ViewControls {
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null!);

  const onWheel = (e: React.WheelEvent) => {
    if (!enabled) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const fx = rect && rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const fy = rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    setView((v) => zoomViewAt(v, e.deltaY < 0 ? 1.25 : 0.8, fx, fy));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || view.zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const from = dragRef.current;
    const stage = stageRef.current;
    if (!from || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => panView(v, dx, dy, rect.width, rect.height));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return {
    view,
    setView,
    resetView: () => setView(IDENTITY_VIEW),
    stageProps: {
      ref: stageRef,
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: () => setView(IDENTITY_VIEW),
      style: view.zoom > 1 ? { cursor: dragRef.current ? "grabbing" : "grab" } : undefined,
    },
  };
}
