// Curvature-pen geometry: fit a smooth closed curve through clicked anchors.
//
// The curvature pen records the same `EditPath` polygon as the pen / lasso —
// the smoothing happens up front, at commit time, by sampling a closed
// Catmull-Rom spline through the anchors into a dense point list. The
// rasteriser (frontend proxy and Rust backend) then replays it like any
// other straight-segment path, so no new kernel op is needed.

/** Even-odd point-in-polygon test against a closed loop. */
export function pointInPolygon([px, py]: readonly [number, number], polygon: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i];
    const [x1, y1] = polygon[(i + 1) % polygon.length];
    if (y0 <= py === y1 <= py) continue;
    if (px < x0 + ((py - y0) / (y1 - y0)) * (x1 - x0)) inside = !inside;
  }
  return inside;
}

/**
 * Sample a closed centripetal-flavoured Catmull-Rom spline through `anchors`.
 * Returns `samplesPerSeg` points per anchor segment (the anchors themselves
 * are the segment endpoints, so the curve passes through every anchor).
 * Fewer than three anchors cannot bound a region: returned unchanged.
 */
export function catmullRomClosed(
  anchors: readonly [number, number][],
  samplesPerSeg = 16,
): [number, number][] {
  const n = anchors.length;
  if (n < 3) return anchors.map(([x, y]) => [x, y]);
  const out: [number, number][] = [];
  const at = (i: number) => anchors[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      // Uniform Catmull-Rom basis (tension 0.5).
      const w0 = -0.5 * t3 + t2 - 0.5 * t;
      const w1 = 1.5 * t3 - 2.5 * t2 + 1;
      const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
      const w3 = 0.5 * t3 - 0.5 * t2;
      out.push([
        w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
        w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
      ]);
    }
  }
  return out;
}
