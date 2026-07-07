// Patch / content-aware move: lasso a loop, then drag it from inside to its
// drop site. The loop persists between the two gestures in `patchLoop`.
import type React from "react";
import { pointInPolygon } from "../pathGeometry";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function patchDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  // A drag from inside the pending loop drops it; anywhere else starts a
  // fresh lasso.
  const loop = g.patchLoop;
  if (loop && pointInPolygon(pt, loop)) {
    g.patchDrag = { start: pt, end: pt };
  } else {
    g.patchLoop = null;
    g.drawing = { points: [pt] };
  }
  env.forceRedraw();
}

export function patchMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.patchDrag) return false;
  g.patchDrag.end = env.toImage(e);
  env.redraw();
  return true;
}

export function patchUp(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.patchDrag) return false;
  const { start, end } = g.patchDrag;
  g.patchDrag = null;
  const loop = g.patchLoop;
  if (loop && Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
    // Patch: covered pixel `p` refills from `p + [dx, dy]` — the drop
    // site is the clean-texture source. Content-aware move instead
    // moves the loop by `[dx, dy]` and heals the hole behind it.
    env.dispatch({ type: "op", op: { type: env.tool.id === "content_aware_move" ? "content_aware_move" : "patch", points: loop, dx: end[0] - start[0], dy: end[1] - start[1] } });
    g.patchLoop = null;
  }
  env.forceRedraw();
  return true;
}

/** Release of the lasso drag: the loop becomes the pending region; the next
 * drag from inside it records the op. */
export function patchCaptureLoop(env: PointerEnv, g: PointerGestures, pts: Pt[]): void {
  g.patchLoop = pts.length >= 3 ? pts : null;
  env.forceRedraw();
}
