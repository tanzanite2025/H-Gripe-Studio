// Magnetic-lasso edge snapping: an edge-magnitude map built from the underlay
// window, and a snap that pulls a point to the strongest edge nearby.

/** Edge-magnitude map over the underlay's visible window. `offX`/`offY` map
 *  image-space coordinates into the window (`wx = x - offX`). */
export interface EdgeMap {
  w: number;
  h: number;
  offX: number;
  offY: number;
  mag: Float32Array;
}

/** Build an edge map from window pixels: luma central-difference gradient. */
export function buildEdgeMap(pixels: Uint8ClampedArray | Uint8Array, w: number, h: number, offX: number, offY: number): EdgeMap {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
  }
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + w] - luma[i - w];
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return { w, h, offX, offY, mag };
}

// Snapping only moves a point when the edge is meaningfully stronger than
// flat-area noise; weaker maxima leave the point where the user drew it.
const MIN_EDGE_MAG = 24;

/**
 * Snap an image-space point to the strongest edge within `radius` px,
 * preferring closer edges (magnitude decayed by distance). Returns the input
 * point when the map misses it or no strong edge is nearby.
 */
export function snapToEdge(edge: EdgeMap, pt: [number, number], radius: number): [number, number] {
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(pt[0] - edge.offX);
  const cy = Math.round(pt[1] - edge.offY);
  let best: [number, number] | null = null;
  let bestScore = MIN_EDGE_MAG;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 1 || y < 1 || x >= edge.w - 1 || y >= edge.h - 1) continue;
      const score = edge.mag[y * edge.w + x] * (1 - Math.sqrt(d2) / (r + 1));
      if (score > bestScore) {
        bestScore = score;
        best = [x + edge.offX, y + edge.offY];
      }
    }
  }
  return best ?? pt;
}

/** Snap every point of a drawn loop to nearby edges (commit-time pass). */
export function snapLoopToEdges(edge: EdgeMap, points: readonly [number, number][], radius: number): [number, number][] {
  return points.map((p) => snapToEdge(edge, p, radius));
}
