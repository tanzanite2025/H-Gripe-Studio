// The Mask-Edit stage's pointer state machine: dispatch only. The per-tool
// behaviour lives in the pointer/ modules, split by tool type — navigation,
// anchor re-edit, path, brush family, patch, crop, marquee, transform,
// gradient, shape, and the single-click tools. This file holds the shared
// gesture ordering: which drag consumes the move/up when several could, and
// the pointer-down gates (tool readiness, adjustment layers) that apply
// before any tool sees the event.
import type React from "react";
import { brushDown, commitStroke } from "./pointer/brush";
import { clickDown, pointDown, rulerMove, rulerUp, sampleDown } from "./pointer/clickTools";
import { cropDown, cropMove, cropUp, perspectiveCropDown } from "./pointer/crop";
import { gradientDown, gradientMove, gradientUp } from "./pointer/gradient";
import { marqueeDown, marqueeDragMove, marqueeUp } from "./pointer/marquee";
import { navigationDown, navigationMove, navigationUp } from "./pointer/navigation";
import { commitDrawnLoop, pathToolDown } from "./pointer/path";
import { anchorEditDown, anchorEditMove, anchorEditUp, pathEditHitDown } from "./pointer/pathEdit";
import { patchCaptureLoop, patchDown, patchMove, patchUp } from "./pointer/patch";
import { shapeDown, shapeMove, shapeUp } from "./pointer/shape";
import { transformDown, transformMove, transformUp } from "./pointer/transform";
import type { PointerEnv, PointerGestures } from "./pointer/types";

export { createPointerGestures, cropCorners } from "./pointer/types";
export type { MarqueeSelection, PointerEnv, PointerGestures } from "./pointer/types";

export function pointerDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): void {
  const { tool } = env;
  if (navigationDown(env, g, e)) return;
  if (anchorEditDown(env, g, e)) return;
  if (tool.status !== "ready") return;
  // Adjustment layers carry no edit stack — canvas edits that would record
  // onto the active layer are ignored; document-level matte strokes / SAM
  // points still land.
  const activeIsAdjustment = env.activeLayerKind === "adjustment";
  const toMatteTarget = tool.kind === "matte" || (tool.kind === "paint" && env.paintTarget === "matte");
  if (activeIsAdjustment && tool.kind !== "point" && !toMatteTarget) return;
  (e.target as Element).setPointerCapture?.(e.pointerId);
  const pt = env.toImage(e);
  if (tool.kind === "path_edit") return pathEditHitDown(env, pt);
  if (tool.kind === "path") return pathToolDown(env, g, pt);
  if (tool.id === "patch" || tool.id === "content_aware_move") return patchDown(env, g, pt);
  if (tool.id === "crop" && env.workspace === "image") return cropDown(env, g, pt);
  if (tool.id === "perspective_crop") return perspectiveCropDown(env, g, pt);
  if (
    tool.id === "pattern_stamp" ||
    tool.id === "healing_brush" ||
    tool.kind === "clone" ||
    tool.kind === "paint" ||
    tool.kind === "matte" ||
    tool.kind === "heal" ||
    tool.kind === "history" ||
    tool.kind === "dodge"
  )
    return brushDown(env, g, e, pt);
  if (tool.kind === "transform") return transformDown(env, g, pt);
  if (tool.kind === "gradient") return gradientDown(env, g, e, pt);
  if (tool.kind === "marquee") return marqueeDown(env, g, pt);
  if (tool.kind === "shape") return shapeDown(env, g, pt);
  if (tool.kind === "click") return clickDown(env, pt);
  if (tool.kind === "sample") return sampleDown(env, g, pt);
  if (tool.kind === "point") return pointDown(env, e, pt);
}

export function pointerMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): void {
  if (navigationMove(env, g, e)) return;
  if (anchorEditMove(env, g, e)) return;
  if (rulerMove(env, g, e)) return;
  if (cropMove(env, g, e)) return;
  if (patchMove(env, g, e)) return;
  if (g.drawing) {
    // Freehand drags (brush family, lassos, the patch loop) share the
    // point-accumulation plumbing; the tool only matters on release.
    g.drawing.points.push(env.toImage(e));
    env.redraw();
    return;
  }
  if (transformMove(env, g, e)) return;
  if (gradientMove(env, g, e)) return;
  if (marqueeDragMove(env, g, e)) return;
  shapeMove(env, g, e);
}

export function pointerUp(env: PointerEnv, g: PointerGestures): void {
  const { tool } = env;
  if (navigationUp(g)) return;
  if (anchorEditUp(env, g)) return;
  if (rulerUp(env, g)) return;
  if (cropUp(env, g)) return;
  if (patchUp(env, g)) return;
  if (g.drawing) {
    const pts = g.drawing.points;
    g.drawing = null;
    if (tool.id === "lasso" || tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
      return commitDrawnLoop(env, g, pts);
    }
    if (tool.id === "patch" || tool.id === "content_aware_move") {
      return patchCaptureLoop(env, g, pts);
    }
    return commitStroke(env, g, pts);
  }
  if (transformUp(env, g)) return;
  if (gradientUp(env, g)) return;
  if (marqueeUp(env, g)) return;
  shapeUp(env, g);
}
