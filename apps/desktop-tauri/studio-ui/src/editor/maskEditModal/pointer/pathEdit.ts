// Anchor re-edit mode (M2): dragging anchors of the path being re-edited,
// path-selection whole-path drags, and the path selection tool's
// click-to-reopen hit test.
import type React from "react";
import { activeOps } from "../../maskEdit";
import { hitTestPathOp, translateAnchors } from "../pathEditTools";
import type { PointerEnv, PointerGestures } from "./types";

/** Pointer-down while a committed path is open for re-editing. */
export function anchorEditDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (env.editingPath == null || !env.anchorDraft) return false;
  (e.target as Element).setPointerCapture?.(e.pointerId);
  const [x, y] = env.toImage(e);
  if (env.tool.id === "path_select") {
    // Path selection: any drag moves the whole selected path.
    g.wholePathDrag = [x, y];
    return true;
  }
  // Anchor re-editing mode: grab the nearest anchor square, if any.
  const grabRadius = Math.max(10, env.dims.w * 0.012);
  let best = -1;
  let bestDist = grabRadius;
  env.anchorDraft.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  });
  g.draggingAnchor = best >= 0 ? best : null;
  return true;
}

/** Path selection: click near a committed path outline to re-open
 * it through the ordinary anchor-edit flow. */
export function pathEditHitDown(env: PointerEnv, pt: [number, number]): void {
  const hit = hitTestPathOp(activeOps(env.doc), pt, Math.max(10, env.dims.w * 0.012));
  if (hit >= 0) env.startPathEdit(hit);
}

export function anchorEditMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (g.wholePathDrag) {
    const [x, y] = env.toImage(e);
    const [px, py] = g.wholePathDrag;
    g.wholePathDrag = [x, y];
    env.setAnchorDraft((prev) => (prev ? translateAnchors(prev, x - px, y - py) : prev));
    return true;
  }
  if (g.draggingAnchor != null) {
    const [x, y] = env.toImage(e);
    const idx = g.draggingAnchor;
    env.setAnchorDraft((prev) => (prev ? prev.map((p, i) => (i === idx ? { ...p, x, y } : p)) : prev));
    return true;
  }
  return false;
}

export function anchorEditUp(env: PointerEnv, g: PointerGestures): boolean {
  if (g.wholePathDrag) {
    g.wholePathDrag = null;
    env.forceRedraw();
    return true;
  }
  if (g.draggingAnchor != null) {
    g.draggingAnchor = null;
    env.forceRedraw();
    return true;
  }
  return false;
}
