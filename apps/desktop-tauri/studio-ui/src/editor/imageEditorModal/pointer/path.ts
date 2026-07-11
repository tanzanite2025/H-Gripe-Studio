// Path tools: freehand paths (freeform pen / magnetic lasso) that
// draw a loop, and anchor tools (pen / polygonal lasso / curvature pen) that
// click anchors and close on the first one.
import { snapLoopToEdges, snapToEdgeCandidate } from "../magneticSnap";
import { usesSelectionAssistRead } from "../selectionToolProtocol";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function pathToolDown(env: PointerEnv, g: PointerGestures, pt: Pt): void {
  const { tool, dims } = env;
  if (tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
    if (usesSelectionAssistRead(tool.id)) env.captureEdgeMap();
    if (tool.id === "magnetic_lasso" && g.magneticEdge) {
      const first = snapToEdgeCandidate(g.magneticEdge, pt, env.magnetic.width, env.magnetic.contrast);
      g.magneticLock = first.snapped ? { point: first.point, score: first.score } : null;
      g.drawing = { points: [first.point] };
    } else {
      g.drawing = { points: [pt] };
    }
    env.forceRedraw();
    return;
  }
  // Anchor tools (pen / polygonal lasso / curvature pen): clicking near
  // the first anchor closes the path.
  const closeRadius = Math.max(8, dims.w * 0.01);
  const first = env.penAnchors[0];
  if (env.penAnchors.length >= 3 && first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) <= closeRadius) {
    env.closePenPath();
    return;
  }
  env.setPenAnchors((prev) => [...prev, pt]);
}

/** Release of a freehand lasso drag: the drawn loop commits as a path. */
export function commitDrawnLoop(env: PointerEnv, g: PointerGestures, pts: Pt[]): void {
  const { tool } = env;
  // The magnetic lasso snaps the drawn loop to nearby image edges at
  // commit time (the search window scales with the drawn size).
  const edge = tool.id === "magnetic_lasso" ? g.magneticEdge : null;
  env.commitPath(tool.id, edge ? snapLoopToEdges(edge, pts, env.magnetic.width, env.magnetic.contrast) : pts);
  g.magneticEdge = null;
  g.magneticLock = null;
  env.forceRedraw();
}
