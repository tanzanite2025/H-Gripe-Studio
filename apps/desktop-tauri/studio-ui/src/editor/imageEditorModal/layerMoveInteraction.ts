import type React from "react";
import type { PointerEnv, PointerGestures, Pt } from "./pointer/types";

export function beginSelectedLayerMove(_env: PointerEnv, g: PointerGestures, pt: Pt): void {
  g.moveDrag = { start: pt, end: pt };
}

export function updateSelectedLayerMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.moveDrag) return false;
  g.moveDrag.end = env.toImage(e);
  const { start, end } = g.moveDrag;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (env.workspace === "image") env.setMoveDraft(Math.abs(dx) >= 1 || Math.abs(dy) >= 1 ? [dx, dy] : null);
  return true;
}

export function commitSelectedLayerMove(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.moveDrag) return false;
  const { start, end } = g.moveDrag;
  g.moveDrag = null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
    env.dispatch({ type: "op", op: { type: "transform", dx, dy } });
  }
  if (env.workspace === "image") env.setMoveDraft(null);
  env.forceRedraw();
  return true;
}
