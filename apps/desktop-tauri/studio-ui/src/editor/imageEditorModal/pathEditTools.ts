// Path selection: hit-test a canvas click against the committed path steps of
// the active layer, and translate a whole anchor draft.
//
// It re-opens a committed `EditPath` through the existing anchor-edit flow
// (M2). It adds no new kernel op — the commit is the ordinary
// `path_anchors` history step.

import { isPathOp, type EditOp, type EditPathPoint } from "../../contracts/imageEditOps";

/** Distance from `pt` to the segment `a`–`b` (image px). */
function segmentDistance(pt: [number, number], a: EditPathPoint, b: EditPathPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = pt[0] - a.x;
  const wy = pt[1] - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(pt[0] - (a.x + t * vx), pt[1] - (a.y + t * vy));
}

/**
 * The index of the enabled path op whose outline passes closest to `pt`
 * within `radius` px, or -1 when nothing is in reach. Ties go to the
 * topmost (latest) step, matching what the user sees painted on top.
 */
export function hitTestPathOp(ops: readonly EditOp[], pt: [number, number], radius: number): number {
  let best = -1;
  let bestDist = radius;
  ops.forEach((op, i) => {
    if (op.disabled || !isPathOp(op) || op.points.length < 2) return;
    for (let k = 0; k < op.points.length; k++) {
      const a = op.points[k];
      const b = op.points[(k + 1) % op.points.length];
      const d = segmentDistance(pt, a, b);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    }
  });
  return best;
}

/** A copy of `anchors` moved by (`dx`, `dy`), handles included. */
export function translateAnchors(anchors: readonly EditPathPoint[], dx: number, dy: number): EditPathPoint[] {
  return anchors.map((p) => ({
    ...p,
    x: p.x + dx,
    y: p.y + dy,
    ...(p.in ? { in: [p.in[0] + dx, p.in[1] + dy] as [number, number] } : null),
    ...(p.out ? { out: [p.out[0] + dx, p.out[1] + dy] as [number, number] } : null),
  }));
}
