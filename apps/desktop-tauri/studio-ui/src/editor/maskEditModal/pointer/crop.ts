// Crop tools: the image crop's adjustable rect (corner drags, ratio lock,
// click-inside to confirm) and the perspective crop's adjustable quad.
import type React from "react";
import { pointInPolygon } from "../pathGeometry";
import { cropCorners, type Box, type PointerEnv, type PointerGestures, type Pt } from "./types";

export function cropDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  // Image crop: drag a box, adjust its corners, then click inside to
  // confirm — the crop lands on the document's edit stack (undoable via
  // history) and the stage dims everything outside the kept region.
  const { dims } = env;
  const draft = env.cropDraft;
  if (draft) {
    const grabRadius = Math.max(10, dims.w * 0.012);
    const idx = cropCorners(draft).findIndex(
      ([qx, qy]) => Math.hypot(qx - pt[0], qy - pt[1]) <= grabRadius,
    );
    if (idx >= 0) {
      g.cropCorner = idx;
      // Ratio lock holds the box's proportions through the corner drag;
      // a free drag drops any picked preset.
      const bw = Math.abs(draft[2] - draft[0]);
      const bh = Math.abs(draft[3] - draft[1]);
      g.cropDragRatio = env.cropLock && bh >= 1 ? bw / bh : null;
      if (!env.cropLock) env.setCropAspect("");
      return;
    }
    if (pt[0] >= draft[0] && pt[0] <= draft[2] && pt[1] >= draft[1] && pt[1] <= draft[3]) {
      env.confirmCropDraft(draft);
      return;
    }
    env.setCropDraft(null);
  }
  g.marquee = { start: pt, end: pt };
  env.forceRedraw();
}

export function perspectiveCropDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  // Perspective crop: drag corners of the pending quad, click inside it
  // to commit, or drag a fresh box.
  const quad = env.quadDraft;
  if (quad) {
    const grabRadius = Math.max(10, env.dims.w * 0.012);
    const idx = quad.findIndex(([qx, qy]) => Math.hypot(qx - pt[0], qy - pt[1]) <= grabRadius);
    if (idx >= 0) {
      g.quadCorner = idx;
      return;
    }
    env.setQuadDraft(null);
    if (pointInPolygon(pt, quad)) {
      env.dispatch({ type: "op", op: { type: "perspective_crop", region: quad.flat() } });
      return;
    }
  }
  g.marquee = { start: pt, end: pt };
  env.forceRedraw();
}

export function cropMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): boolean {
  if (g.quadCorner != null) {
    const p = env.toImage(e);
    const idx = g.quadCorner;
    env.setQuadDraft((prev) => (prev ? prev.map((q, i) => (i === idx ? p : q)) : prev));
    return true;
  }
  if (g.cropCorner != null) {
    const p = env.toImage(e);
    const idx = g.cropCorner;
    env.setCropDraft((prev) => {
      if (!prev) return prev;
      const [x0, y0, x1, y1] = prev;
      const next: [number, number, number, number] =
        idx === 0
          ? [p[0], p[1], x1, y1]
          : idx === 1
            ? [x0, p[1], p[0], y1]
            : idx === 2
              ? [x0, y0, p[0], p[1]]
              : [p[0], y0, x1, p[1]];
      const ratio = g.cropDragRatio;
      if (ratio) {
        // Locked ratio: the dragged corner's vertical edge follows the
        // width, growing away from the fixed edge.
        const h = Math.abs(next[2] - next[0]) / ratio;
        if (idx === 0 || idx === 1) next[1] = y1 - h;
        else next[3] = y0 + h;
      }
      return next;
    });
    return true;
  }
  return false;
}

export function cropUp(env: PointerEnv, g: PointerGestures): boolean {
  if (g.quadCorner != null) {
    g.quadCorner = null;
    return true;
  }
  if (g.cropCorner != null) {
    g.cropCorner = null;
    g.cropDragRatio = null;
    env.setCropDraft((prev) =>
      prev
        ? [
            Math.min(prev[0], prev[2]),
            Math.min(prev[1], prev[3]),
            Math.max(prev[0], prev[2]),
            Math.max(prev[1], prev[3]),
          ]
        : prev,
    );
    return true;
  }
  return false;
}

/** A released crop marquee becomes the adjustable rect; the commit happens
 * on the click inside it. A fresh free-form box carries no preset. */
export function cropMarqueeEnd(env: PointerEnv, region: Box): void {
  env.setCropAspect("");
  env.setCropDraft(region);
}

/** A released perspective-crop marquee becomes the adjustable quad; the
 * commit happens on the click inside it. */
export function perspectiveMarqueeEnd(env: PointerEnv, region: Box): void {
  env.setQuadDraft([
    [region[0], region[1]],
    [region[2], region[1]],
    [region[2], region[3]],
    [region[0], region[3]],
  ]);
}
