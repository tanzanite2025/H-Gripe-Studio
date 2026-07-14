import type React from "react";
import type { PointerEnv, PointerGestures, Pt } from "./pointer/types";

function moveDelta(env: PointerEnv, start: Pt, end: Pt): Pt | null {
  const resolved = env.resolveSelectedLayerMoveDelta([end[0] - start[0], end[1] - start[1]]);
  if (!resolved || (Math.abs(resolved[0]) < 1 && Math.abs(resolved[1]) < 1)) return null;
  return resolved;
}

export function beginSelectedLayerMove(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  g.moveDrag = { start: pt, end: pt };
  if (env.workspace === "image") env.beginMovePreview();
}

export function updateSelectedLayerMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.moveDrag) return false;
  g.moveDrag.end = env.toImage(e);
  const { start, end } = g.moveDrag;
  const delta = moveDelta(env, start, end);
  if (env.workspace === "image") env.setMoveDraft(delta);
  return true;
}

export function commitSelectedLayerMove(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.moveDrag) return false;
  const { start, end } = g.moveDrag;
  g.moveDrag = null;
  const completedDraft = moveDelta(env, start, end);
  if (completedDraft) {
    const [dx, dy] = completedDraft;
    env.dispatch({ type: "op", op: { type: "transform", dx, dy } });
  }
  if (env.workspace === "image") env.completeMoveDraft(completedDraft);
  env.forceRedraw();
  return true;
}
