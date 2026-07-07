// Canvas navigation (M8): hand tool / Space-hold pan, the zoom tool and the
// rotate-view drag. Pure view changes — nothing records on the document.
import type React from "react";
import { ZOOM_STEP, panBy, rotateTo, zoomAt } from "../../canvasView";
import type { PointerEnv, PointerGestures } from "./types";

export function navigationDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  const { tool } = env;
  // Hand tool / Space-hold pans; zoom tool clicks in (Alt+click out)
  // anchored at the cursor.
  if (env.spacePan || tool.id === "hand") {
    g.panDrag = { x: e.clientX, y: e.clientY };
    return true;
  }
  if (tool.id === "zoom") {
    const rect = env.canvasRect();
    if (!rect) return true;
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const factor = e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP;
    env.setView((v) => zoomAt(v, factor, cx, cy, ...env.viewBase()));
    return true;
  }
  if (tool.id === "rotate_view") {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    g.rotateDrag = { angle: env.pointerAngle(e), rotate: env.viewRotate() };
    return true;
  }
  return false;
}

export function navigationMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (g.rotateDrag) {
    const { angle, rotate } = g.rotateDrag;
    env.setView((v) => rotateTo(v, rotate + env.pointerAngle(e) - angle));
    return true;
  }
  if (g.panDrag) {
    const dx = e.clientX - g.panDrag.x;
    const dy = e.clientY - g.panDrag.y;
    g.panDrag = { x: e.clientX, y: e.clientY };
    env.setView((v) => panBy(v, dx, dy, ...env.viewBase()));
    return true;
  }
  return false;
}

export function navigationUp(g: PointerGestures): boolean {
  if (g.rotateDrag) {
    g.rotateDrag = null;
    return true;
  }
  if (g.panDrag) {
    g.panDrag = null;
    return true;
  }
  return false;
}
