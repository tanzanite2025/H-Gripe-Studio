// Draggable always-on-top container for the Prompt Assistant panel. Dragging
// starts from any child marked `data-drag-handle` (the panel header); the
// position persists per workspace and is clamped so the handle stays visible.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  clampToViewport,
  isDragGesture,
  loadDockPos,
  saveDockPos,
  type FloatingPos,
} from "./floatingButton";

const DOCK_WIDTH = 320;
const CLAMP_SIZE = 48;

function defaultPos(): FloatingPos {
  return { x: Math.max(0, window.innerWidth - DOCK_WIDTH - 120), y: Math.round(window.innerHeight * 0.2) };
}

export function FloatingDock({ children }: { children: ReactNode }) {
  const [pos, setPos] = useState<FloatingPos>(() =>
    clampToViewport(loadDockPos() ?? defaultPos(), CLAMP_SIZE, window.innerWidth, window.innerHeight),
  );
  const drag = useRef<{ startX: number; startY: number; origin: FloatingPos; moved: boolean } | null>(
    null,
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drag-handle]") || target.closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startY: e.clientY, origin: pos, moved: false };
    },
    [pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && !isDragGesture(d.startX, d.startY, e.clientX, e.clientY)) return;
    d.moved = true;
    setPos(
      clampToViewport(
        { x: d.origin.x + (e.clientX - d.startX), y: d.origin.y + (e.clientY - d.startY) },
        CLAMP_SIZE,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (d?.moved) {
      setPos((p) => {
        saveDockPos(p);
        return p;
      });
    }
  }, []);

  useEffect(() => {
    const onResize = () =>
      setPos((p) => clampToViewport(p, CLAMP_SIZE, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      className="assistant-dock"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {children}
    </div>
  );
}
