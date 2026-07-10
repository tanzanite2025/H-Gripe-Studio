// Marquee drags: the rect/ellipse selection tools, plus the generic
// region-op tools and the crop tools' initial box (they share `g.marquee`;
// the crop-specific endings live in crop.ts).
import type React from "react";
import { cropMarqueeEnd, perspectiveMarqueeEnd } from "./crop";
import type { Box, PointerEnv, PointerGestures, Pt } from "./types";
import { commitSelectionDraft, createBoxSelection } from "../selection";

export function marqueeDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  g.marquee = { start: pt, end: pt };
  env.forceRedraw();
}

export function marqueeDragMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (!g.marquee) return false;
  g.marquee.end = env.toImage(e);
  env.redraw();
  return true;
}

export function marqueeUp(env: PointerEnv, g: PointerGestures): boolean {
  if (!g.marquee) return false;
  const { tool } = env;
  const { start, end } = g.marquee;
  g.marquee = null;
  const region = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
  if (region[2] - region[0] > 1 && region[3] - region[1] > 1) {
    if (tool.id === "crop" && env.workspace === "image") {
      cropMarqueeEnd(env, region as Box);
    } else if (tool.id === "perspective_crop") {
      perspectiveMarqueeEnd(env, region as Box);
    } else if (tool.id === "rect" || tool.id === "ellipse") {
      const selection = createBoxSelection(region as Box, tool.id === "ellipse");
      if (env.workspace === "image") {
        env.setSelectionDraft(selection);
        env.setActiveSelection(null);
      } else {
        // Mask workspace keeps the existing PS marquee behaviour: the drag
        // directly defines an active selection used as an edit clip.
        env.setActiveSelection(commitSelectionDraft(selection));
      }
      // Surface the selection's size readout / manual inputs: they live
      // on the 选项 tab, which may be behind another tab in its group.
      env.selectOptionsTab();
    } else {
      env.dispatch({ type: "op", op: { type: tool.id, region } });
    }
  } else if (tool.id === "rect" || tool.id === "ellipse") {
    // A plain click with a marquee tool drops the selection (PS deselect).
    env.setActiveSelection(null);
    env.setSelectionDraft(null);
  }
  env.forceRedraw();
  return true;
}
