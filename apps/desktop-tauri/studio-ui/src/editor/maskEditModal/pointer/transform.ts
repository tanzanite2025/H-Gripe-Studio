// Move tool: drags the whole mask (a `transform` op), or — over a committed
// marquee — drags the selection region itself (PS moves the marching ants).
import type React from "react";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function transformDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  const r = env.activeSelection?.region;
  if (r && pt[0] >= r[0] && pt[0] <= r[2] && pt[1] >= r[1] && pt[1] <= r[3]) {
    g.marqueeMove = { last: pt, from: r };
  } else {
    g.moveDrag = { start: pt, end: pt };
  }
  env.forceRedraw();
}

export function transformMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  const { dims } = env;
  if (g.marqueeMove) {
    const pt = env.toImage(e);
    const { last } = g.marqueeMove;
    const dx = pt[0] - last[0];
    const dy = pt[1] - last[1];
    g.marqueeMove.last = pt;
    env.setActiveSelection((prev) => {
      if (!prev) return prev;
      const [x0, y0, x1, y1] = prev.region;
      const w = x1 - x0;
      const h = y1 - y0;
      const nx = Math.max(0, Math.min(x0 + dx, dims.w - w));
      const ny = Math.max(0, Math.min(y0 + dy, dims.h - h));
      return { ...prev, region: [nx, ny, nx + w, ny + h] };
    });
    return true;
  }
  if (g.moveDrag) {
    g.moveDrag.end = env.toImage(e);
    if (env.workspace === "image") {
      const { start, end } = g.moveDrag;
      env.setMoveDraft([end[0] - start[0], end[1] - start[1]]);
    }
    env.redraw();
    return true;
  }
  return false;
}

export function transformUp(env: PointerEnv, g: PointerGestures): boolean {
  if (g.marqueeMove) {
    // The moved selection is already live in `activeSelection`; nothing lands
    // on the edit stack (the selection is not a mask edit).
    g.marqueeMove = null;
    return true;
  }
  if (g.moveDrag) {
    const { start, end } = g.moveDrag;
    g.moveDrag = null;
    env.setMoveDraft(null);
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      env.dispatch({ type: "op", op: { type: "transform", dx, dy } });
    }
    env.forceRedraw();
    return true;
  }
  return false;
}
