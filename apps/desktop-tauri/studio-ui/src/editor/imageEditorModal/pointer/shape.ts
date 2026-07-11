// Shape tools: drag a bounding box; the release commits an ordinary vector
// path step built from the chosen shape's vertices.
import type React from "react";
import { shapeVertices } from "../../imageEditorTools";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function shapeDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  g.shapeDrag = { start: pt, end: pt };
  env.forceRedraw();
}

export function shapeMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.shapeDrag) return false;
  g.shapeDrag.end = env.toImage(e);
  env.redraw();
  return true;
}

export function shapeUp(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.shapeDrag) return false;
  const { start, end } = g.shapeDrag;
  g.shapeDrag = null;
  const pts = shapeVertices(env.shapeKind, [start[0], start[1], end[0], end[1]], env.shapeSides, env.brushSize);
  if (pts.length >= 3) {
    env.dispatch({
      type: "path",
      path: {
        id: env.nextId("path"),
        mode: env.pathMode,
        tool: "shape",
        closed: true,
        points: pts.map(([x, y]) => ({ x, y })),
      },
    });
  }
  env.forceRedraw();
  return true;
}
