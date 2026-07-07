// Single-click tools: the wand family and red eye (kind "click"), the view
// samplers — eyedropper, colour sampler, ruler — (kind "sample"), and the
// SAM 2 point prompt (kind "point").
import type React from "react";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function clickDown(env: PointerEnv, pt: Pt): void {
  const { tool } = env;
  if (tool.id === "red_eye") {
    // Red eye: the contiguous red-dominant region around the click
    // floods into the mask on run.
    env.dispatch({ type: "op", op: { type: "red_eye", region: pt } });
    return;
  }
  // Wand-family flood fill, seeded at the click: the paint bucket adds
  // like the wand; the magic eraser records mode "subtract" and the
  // backend clears the flooded region instead.
  env.dispatch({
    type: "op",
    op: { type: "wand", amount: env.tolerance, region: pt, ...(tool.mode === "subtract" ? { mode: "subtract" } : null) },
  });
}

/** Sample tools are pure view reads — nothing lands on the document. */
export function sampleDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  const { tool } = env;
  if (tool.id === "ruler") {
    g.rulerDrag = { start: pt, end: pt };
    env.forceRedraw();
  } else if (tool.id === "color_sampler") {
    // Pin up to four persistent readouts (PS colour sampler).
    env.sampleUnderlay(pt, (hex) =>
      env.setColorSamples((prev) => (prev.length >= 4 ? prev : [...prev, { x: pt[0], y: pt[1], hex }])),
    );
  } else {
    env.sampleUnderlay(pt);
  }
}

/** SAM 2 point prompt: left button includes (positive), right button
 * excludes (negative). Right-click's context menu is suppressed by the
 * stage. */
export function pointDown(env: PointerEnv, e: React.PointerEvent, pt: Pt): void {
  const label = e.button === 2 ? 0 : 1;
  env.dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
}

export function rulerMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.rulerDrag) return false;
  g.rulerDrag.end = env.toImage(e);
  env.redraw();
  return true;
}

export function rulerUp(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.rulerDrag) return false;
  const { start, end } = g.rulerDrag;
  g.rulerDrag = null;
  env.setRulerLine(Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1 ? { start, end } : null);
  env.forceRedraw();
  return true;
}
