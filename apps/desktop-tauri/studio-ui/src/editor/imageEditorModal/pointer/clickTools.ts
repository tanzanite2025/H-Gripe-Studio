// Single-click tools: the wand family and red eye (kind "click"), the view
// samplers — eyedropper and colour sampler — (kind "sample"), and the
// Built-in include/exclude point prompt (kind "point").
import type React from "react";
import type { PointerEnv, Pt } from "./types";

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
export function sampleDown(env: PointerEnv, pt: Pt): void {
  const { tool } = env;
  if (tool.id === "color_sampler") {
    // Pin up to four persistent readouts (PS colour sampler).
    env.sampleUnderlay(pt, (hex) =>
      env.setColorSamples((prev) => (prev.length >= 4 ? prev : [...prev, { x: pt[0], y: pt[1], hex }])),
    );
  } else env.sampleUnderlay(pt);
}

/** Built-in point prompt: left button includes (positive), right button
 * excludes (negative). Right-click's context menu is suppressed by the
 * stage. */
export function pointDown(env: PointerEnv, e: React.PointerEvent, pt: Pt): void {
  const label = e.button === 2 ? 0 : 1;
  env.dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
}
