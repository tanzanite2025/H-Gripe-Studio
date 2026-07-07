// Gradient tool (M10): drag the start → end ramp vector; Alt at pointer-down
// records a subtract ramp.
import type React from "react";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function gradientDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent, pt: Pt): void {
  g.gradientDrag = { start: pt, end: pt, subtract: e.altKey };
  env.forceRedraw();
}

export function gradientMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.gradientDrag) return false;
  g.gradientDrag.end = env.toImage(e);
  env.redraw();
  return true;
}

export function gradientUp(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.gradientDrag) return false;
  const { start, end, subtract } = g.gradientDrag;
  g.gradientDrag = null;
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
    env.dispatch({
      type: "op",
      op: { type: "gradient", region: [start[0], start[1], end[0], end[1]], mode: subtract ? "subtract" : "add" },
    });
  }
  env.forceRedraw();
  return true;
}
