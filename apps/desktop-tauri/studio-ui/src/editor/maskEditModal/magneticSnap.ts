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
  gx: Float32Array;
  gy: Float32Array;
  strongThreshold: number;
  maxMag: number;
}

export interface MagneticSnapSettings {
  /** Search radius around the cursor, in image pixels. */
  width: number;
  /** Edge sensitivity, Photoshop-style percentage: higher requires stronger edges. */
  contrast: number;
  /** Minimum spacing between live auto-fasten points, in image pixels. */
  frequency: number;
}

export interface EdgeSnapCandidate {
  point: [number, number];
  snapped: boolean;
  score: number;
  mag: number;
  distance: number;
}

export const DEFAULT_MAGNETIC_SNAP: MagneticSnapSettings = {
  width: 10,
  contrast: 50,
  frequency: 10,
};

function edgeThreshold(edge: EdgeMap, contrast = DEFAULT_MAGNETIC_SNAP.contrast): number {
  const c = Math.max(0, Math.min(100, contrast)) / 100;
  return Math.max(MIN_EDGE_MAG, edge.strongThreshold * (0.55 + c * 0.9));
}

function blurPlane(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = (
        src[i] * 4 +
        (src[i - 1] + src[i + 1] + src[i - w] + src[i + w]) * 2 +
        src[i - w - 1] + src[i - w + 1] + src[i + w - 1] + src[i + w + 1]
      ) / 16;
    }
  }
  return out;
}

function scharrPlane(plane: Float32Array, w: number, x: number, y: number, step = 1): [number, number] {
  const row = w * step;
  const i = y * w + x;
  const tl = plane[i - row - step];
  const tc = plane[i - row];
  const tr = plane[i - row + step];
  const ml = plane[i - step];
  const mr = plane[i + step];
  const bl = plane[i + row - step];
  const bc = plane[i + row];
  const br = plane[i + row + step];
  return [
    (3 * tr + 10 * mr + 3 * br - 3 * tl - 10 * ml - 3 * bl) / 16,
    (3 * bl + 10 * bc + 3 * br - 3 * tl - 10 * tc - 3 * tr) / 16,
  ];
}

function gradientNeighborOffsets(gx: number, gy: number): [[number, number], [number, number]] {
  const ax = Math.abs(gx);
  const ay = Math.abs(gy);
  if (ax > ay * 2) return [[-1, 0], [1, 0]];
  if (ay > ax * 2) return [[0, -1], [0, 1]];
  return gx * gy >= 0 ? [[-1, -1], [1, 1]] : [[-1, 1], [1, -1]];
}

function magnitudePercentile(mag: Float32Array, w: number, h: number, maxMag: number, percentile: number): number {
  if (maxMag <= 0) return 0;
  const bins = 64;
  const hist = new Uint32Array(bins);
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const m = mag[y * w + x];
      const bin = Math.max(0, Math.min(bins - 1, Math.floor((m / maxMag) * (bins - 1))));
      hist[bin]++;
      count++;
    }
  }
  const target = Math.max(1, Math.ceil(count * percentile));
  let seen = 0;
  for (let i = 0; i < bins; i++) {
    seen += hist[i];
    if (seen >= target) return ((i + 0.5) / (bins - 1)) * maxMag;
  }
  return maxMag;
}

/** Build an edge map from window pixels: luma -> light blur -> Scharr gradient.
 * The dynamic threshold keeps low-contrast images usable without snapping to
 * flat-area noise. */
export function buildEdgeMap(pixels: Uint8ClampedArray | Uint8Array, w: number, h: number, offX: number, offY: number): EdgeMap {
  const px = (x: number, y: number, channel: number) => pixels[(y * w + x) * 4 + channel];
  const visiblePx = (x: number, y: number, channel: number) => px(x, y, channel) * (px(x, y, 3) / 255);
  const scharrChannel = (x: number, y: number, channel: number): [number, number] => {
    const read = channel === 3 ? px : visiblePx;
    const tl = read(x - 1, y - 1, channel);
    const tc = read(x, y - 1, channel);
    const tr = read(x + 1, y - 1, channel);
    const ml = read(x - 1, y, channel);
    const mr = read(x + 1, y, channel);
    const bl = read(x - 1, y + 1, channel);
    const bc = read(x, y + 1, channel);
    const br = read(x + 1, y + 1, channel);
    return [
      (3 * tr + 10 * mr + 3 * br - 3 * tl - 10 * ml - 3 * bl) / 16,
      (3 * bl + 10 * bc + 3 * br - 3 * tl - 10 * tc - 3 * tr) / 16,
    ];
  };
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const alpha = pixels[i * 4 + 3] / 255;
    luma[i] = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) * alpha;
  }
  const smooth = blurPlane(luma, w, h);
  const coarse = blurPlane(blurPlane(smooth, w, h), w, h);
  const mag = new Float32Array(w * h);
  const gxMap = new Float32Array(w * h);
  const gyMap = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const [gx, gy] = scharrPlane(smooth, w, x, y);
      let bestGx = gx;
      let bestGy = gy;
      let m = Math.hypot(gx, gy);
      if (x >= 2 && y >= 2 && x < w - 2 && y < h - 2) {
        const [wideGx, wideGy] = scharrPlane(coarse, w, x, y, 2);
        const wideMag = Math.hypot(wideGx, wideGy) * 0.82;
        if (wideMag > m) {
          m = wideMag;
          bestGx = wideGx;
          bestGy = wideGy;
        }
      }
      for (const channel of [0, 1, 2]) {
        const [cgx, cgy] = scharrChannel(x, y, channel);
        const cm = Math.hypot(cgx, cgy) * 0.82;
        if (cm > m) {
          m = cm;
          bestGx = cgx;
          bestGy = cgy;
        }
      }
      const [agx, agy] = scharrChannel(x, y, 3);
      const am = Math.hypot(agx, agy) * 0.9;
      if (am > m) {
        m = am;
        bestGx = agx;
        bestGy = agy;
      }
      gxMap[i] = bestGx;
      gyMap[i] = bestGy;
      mag[i] = m;
    }
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      const [a, b] = gradientNeighborOffsets(gxMap[i], gyMap[i]);
      const ridge = m >= mag[(y + a[1]) * w + x + a[0]] && m >= mag[(y + b[1]) * w + x + b[0]];
      const shaped = ridge ? m * 1.08 : m * 0.82;
      mag[i] = shaped;
      sum += shaped;
      sumSq += shaped * shaped;
      count++;
      if (shaped > maxMag) maxMag = shaped;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  const std = Math.sqrt(variance);
  const p90 = magnitudePercentile(mag, w, h, maxMag, 0.9);
  const robustBase = Math.max(mean + std * 0.8, p90 * 0.72);
  const strongThreshold = Math.max(18, Math.min(maxMag * 0.55, robustBase));
  return { w, h, offX, offY, mag, gx: gxMap, gy: gyMap, strongThreshold, maxMag };
}

// Snapping only moves a point when the edge is meaningfully stronger than
// flat-area noise; weaker maxima leave the point where the user drew it.
const MIN_EDGE_MAG = 18;
const LIVEWIRE_MAX_CELLS = 26000;
const LIVEWIRE_MAX_EXPANSIONS = 12000;

function refineEdgePoint(edge: EdgeMap, point: [number, number], threshold: number): [number, number] {
  const cx = Math.round(point[0] - edge.offX);
  const cy = Math.round(point[1] - edge.offY);
  if (cx < 1 || cy < 1 || cx >= edge.w - 1 || cy >= edge.h - 1) return point;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  const floor = threshold * 0.35;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const x = cx + ox;
      const y = cy + oy;
      if (x < 1 || y < 1 || x >= edge.w - 1 || y >= edge.h - 1) continue;
      const weight = Math.max(0, edge.mag[y * edge.w + x] - floor);
      sx += x * weight;
      sy += y * weight;
      sw += weight;
    }
  }
  return sw > 0 ? [sx / sw + edge.offX, sy / sw + edge.offY] : point;
}

/**
 * Snap an image-space point to the strongest edge within `radius` px,
 * preferring closer edges (magnitude decayed by distance). Returns the input
 * point when the map misses it or no strong edge is nearby.
 */
export function snapToEdgeCandidate(
  edge: EdgeMap,
  pt: [number, number],
  radius: number,
  contrast = DEFAULT_MAGNETIC_SNAP.contrast,
): EdgeSnapCandidate {
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(pt[0] - edge.offX);
  const cy = Math.round(pt[1] - edge.offY);
  let best: [number, number] | null = null;
  let bestCell: [number, number] | null = null;
  let bestMag = 0;
  let bestDistance = 0;
  const threshold = edgeThreshold(edge, contrast);
  let bestScore = threshold;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 1 || y < 1 || x >= edge.w - 1 || y >= edge.h - 1) continue;
      const m = edge.mag[y * edge.w + x];
      const distanceWeight = 1 - Math.sqrt(d2) / (r + 1);
      const ridgeBonus =
        m >= edge.mag[y * edge.w + x - 1] &&
        m >= edge.mag[y * edge.w + x + 1] &&
        m >= edge.mag[(y - 1) * edge.w + x] &&
        m >= edge.mag[(y + 1) * edge.w + x]
          ? 1.18
          : 1;
      const score = m * distanceWeight * ridgeBonus;
      if (score > bestScore) {
        bestScore = score;
        best = [x + edge.offX, y + edge.offY];
        bestCell = [x, y];
        bestMag = m;
        bestDistance = Math.sqrt(d2);
      }
    }
  }
  if (!best) return { point: pt, snapped: false, score: 0, mag: 0, distance: 0 };
  if (bestCell) {
    best = refineEdgePoint(edge, [bestCell[0] + edge.offX, bestCell[1] + edge.offY], threshold);
    bestDistance = Math.hypot(best[0] - pt[0], best[1] - pt[1]);
  }
  return { point: best, snapped: true, score: bestScore, mag: bestMag, distance: bestDistance };
}

export function snapToEdge(edge: EdgeMap, pt: [number, number], radius: number, contrast = DEFAULT_MAGNETIC_SNAP.contrast): [number, number] {
  return snapToEdgeCandidate(edge, pt, radius, contrast).point;
}

function traceReliability(edge: EdgeMap, points: readonly [number, number][], threshold: number) {
  let sampled = 0;
  let usable = 0;
  let strong = 0;
  let magSum = 0;
  let weakRun = 0;
  let maxWeakRun = 0;
  for (const point of points) {
    const x = Math.round(point[0] - edge.offX);
    const y = Math.round(point[1] - edge.offY);
    if (x < 1 || y < 1 || x >= edge.w - 1 || y >= edge.h - 1) continue;
    const mag = edge.mag[y * edge.w + x];
    sampled++;
    magSum += mag;
    if (mag >= threshold) {
      strong++;
      weakRun = 0;
    } else if (mag >= threshold * 0.62) {
      usable++;
      weakRun = 0;
    } else {
      weakRun++;
      if (weakRun > maxWeakRun) maxWeakRun = weakRun;
    }
  }
  return {
    sampled,
    confidence: sampled > 0 ? (strong + usable * 0.45) / sampled : 1,
    avgMag: sampled > 0 ? magSum / sampled : threshold,
    maxWeakRun,
  };
}

function traceIsReliable(edge: EdgeMap, points: readonly [number, number][], threshold: number): boolean {
  const { sampled, confidence, avgMag, maxWeakRun } = traceReliability(edge, points, threshold);
  if (sampled === 0) return true;
  if (maxWeakRun > Math.max(4, sampled * 0.42)) return false;
  return confidence >= 0.28 || avgMag >= threshold * 0.9;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0.0001) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function compactTrace(points: readonly [number, number][], from: [number, number], to: [number, number]): [number, number][] {
  const out: [number, number][] = [from];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.75) out.push(p);
  }
  const last = out[out.length - 1];
  if (Math.hypot(to[0] - last[0], to[1] - last[1]) >= 0.75) out.push(to);
  else out[out.length - 1] = to;
  return out;
}

function compactCommittedLoop(points: readonly [number, number][]): [number, number][] {
  if (points.length <= 3) return points.map((p) => [...p] as [number, number]);
  const deduped: [number, number][] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= 0.75) deduped.push([...point] as [number, number]);
  }
  if (deduped.length <= 3) return deduped;
  const out: [number, number][] = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = out[out.length - 1];
    const curr = deduped[i];
    const next = deduped[i + 1];
    const aLen = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const bLen = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const turn = aLen > 0 && bLen > 0
      ? Math.abs((curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0])) / (aLen * bLen)
      : 0;
    const drift = distanceToSegment(curr[0], curr[1], prev[0], prev[1], next[0], next[1]);
    if (drift > 0.35 || turn > 0.08) out.push(curr);
  }
  out.push(deduped[deduped.length - 1]);
  return out;
}

function traceLiveWireSegment(
  edge: EdgeMap,
  from: [number, number],
  to: [number, number],
  radius: number,
  contrast: number,
): [number, number][] | null {
  const sx = Math.round(from[0] - edge.offX);
  const sy = Math.round(from[1] - edge.offY);
  const tx = Math.round(to[0] - edge.offX);
  const ty = Math.round(to[1] - edge.offY);
  if (sx < 1 || sy < 1 || tx < 1 || ty < 1 || sx >= edge.w - 1 || sy >= edge.h - 1 || tx >= edge.w - 1 || ty >= edge.h - 1) {
    return null;
  }
  const r = Math.max(1, Math.round(radius));
  const corridor = Math.max(8, Math.round(r * 2.2 + 4));
  const minX = Math.max(1, Math.min(sx, tx) - corridor);
  const maxX = Math.min(edge.w - 2, Math.max(sx, tx) + corridor);
  const minY = Math.max(1, Math.min(sy, ty) - corridor);
  const maxY = Math.min(edge.h - 2, Math.max(sy, ty) + corridor);
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const cells = bw * bh;
  if (cells <= 1 || cells > LIVEWIRE_MAX_CELLS) return null;

  const threshold = edgeThreshold(edge, contrast);
  const dist = new Float32Array(cells);
  const score = new Float32Array(cells);
  const prev = new Int32Array(cells);
  const visited = new Uint8Array(cells);
  dist.fill(Infinity);
  score.fill(Infinity);
  prev.fill(-1);

  const localIndex = (x: number, y: number) => (y - minY) * bw + (x - minX);
  const globalX = (idx: number) => minX + (idx % bw);
  const globalY = (idx: number) => minY + Math.floor(idx / bw);
  const start = localIndex(sx, sy);
  const target = localIndex(tx, ty);
  const heuristic = (x: number, y: number) => Math.hypot(x - tx, y - ty) * 0.12;

  const heap: number[] = [];
  const less = (a: number, b: number) => score[a] < score[b];
  const heapPush = (idx: number) => {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    if (heap.length === 0) return -1;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < heap.length && less(heap[left], heap[best])) best = left;
        if (right < heap.length && less(heap[right], heap[best])) best = right;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best], heap[i]];
        i = best;
      }
    }
    return top;
  };

  const cellCost = (x: number, y: number, moveX: number, moveY: number, centerDistance: number) => {
    const idx = y * edge.w + x;
    const mag = edge.mag[idx];
    const edgeStrength = Math.min(1.8, mag / Math.max(threshold, 1));
    const ridge =
      mag >= edge.mag[idx - 1] &&
      mag >= edge.mag[idx + 1] &&
      mag >= edge.mag[idx - edge.w] &&
      mag >= edge.mag[idx + edge.w]
        ? 0.22
        : 0;
    let cost = 2.2 - Math.min(1.7, edgeStrength * 1.25) - ridge;
    if (mag < threshold * 0.35) cost += 1.7;
    else if (mag < threshold) cost += 0.55;
    cost += (centerDistance / (corridor + 1)) * 0.45;
    const gradLen = Math.hypot(edge.gx[idx], edge.gy[idx]);
    const moveLen = Math.hypot(moveX, moveY) || 1;
    if (gradLen > 0.0001 && mag >= threshold * 0.45) {
      const tangentX = -edge.gy[idx] / gradLen;
      const tangentY = edge.gx[idx] / gradLen;
      const alignment = Math.abs(tangentX * (moveX / moveLen) + tangentY * (moveY / moveLen));
      cost -= alignment * 0.34;
    }
    return Math.max(0.08, cost);
  };

  dist[start] = 0;
  score[start] = heuristic(sx, sy);
  heapPush(start);
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const;

  let expansions = 0;
  while (heap.length > 0) {
    const current = heapPop();
    if (current < 0 || visited[current]) continue;
    visited[current] = 1;
    expansions++;
    if (expansions > LIVEWIRE_MAX_EXPANSIONS) return null;
    if (current === target) break;
    const x = globalX(current);
    const y = globalY(current);
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const centerDistance = distanceToSegment(nx, ny, sx, sy, tx, ty);
      if (centerDistance > corridor) continue;
      const ni = localIndex(nx, ny);
      if (visited[ni]) continue;
      const moveLen = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const nextDist = dist[current] + moveLen * cellCost(nx, ny, dx, dy, centerDistance);
      if (nextDist < dist[ni]) {
        dist[ni] = nextDist;
        score[ni] = nextDist + heuristic(nx, ny);
        prev[ni] = current;
        heapPush(ni);
      }
    }
  }

  if (!Number.isFinite(dist[target]) || prev[target] < 0) return null;
  const reversed: [number, number][] = [];
  for (let at = target; at >= 0; at = prev[at]) {
    reversed.push(refineEdgePoint(edge, [globalX(at) + edge.offX, globalY(at) + edge.offY], threshold));
    if (at === start) break;
  }
  reversed.reverse();
  if (reversed.length < 2 || !traceIsReliable(edge, reversed, threshold)) return null;
  return compactTrace(reversed, from, to);
}

function sampleMagneticSegment(
  edge: EdgeMap,
  from: [number, number],
  to: [number, number],
  radius: number,
  contrast: number,
): [number, number][] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length < Math.max(4, radius * 0.45)) return [from, to];
  const dirX = dx / length;
  const dirY = dy / length;
  const normX = -dirY;
  const normY = dirX;
  const threshold = edgeThreshold(edge, contrast);
  const r = Math.max(1, Math.round(radius));
  const offsetStep = r > 18 ? 2 : 1;
  const sampleStep = Math.max(3, Math.min(8, radius * 0.6));
  const steps = Math.max(1, Math.min(96, Math.ceil(length / sampleStep)));
  const offsets: number[] = [];
  for (let offset = -r; offset <= r; offset += offsetStep) offsets.push(offset);
  if (!offsets.includes(0)) offsets.push(0);
  offsets.sort((a, b) => a - b);

  interface Candidate {
    point: [number, number];
    offset: number;
    baseCost: number;
  }

  const rows: Candidate[][] = [];

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = from[0] + dx * t;
    const cy = from[1] + dy * t;
    const row: Candidate[] = [];
    for (const offset of offsets) {
      const x = Math.round(cx + normX * offset - edge.offX);
      const y = Math.round(cy + normY * offset - edge.offY);
      if (x < 1 || y < 1 || x >= edge.w - 1 || y >= edge.h - 1) {
        row.push({
          point: [cx, cy],
          offset,
          baseCost: 8 + Math.abs(offset) / (r + 1),
        });
        continue;
      }
      const idx = y * edge.w + x;
      const mag = edge.mag[idx];
      const gradLen = Math.hypot(edge.gx[idx], edge.gy[idx]) || 1;
      const tangentPenalty = Math.abs((edge.gx[idx] / gradLen) * dirX + (edge.gy[idx] / gradLen) * dirY);
      const centerPenalty = Math.abs(offset) / (r + 1);
      const ridgeBonus =
        mag >= edge.mag[idx - 1] &&
        mag >= edge.mag[idx + 1] &&
        mag >= edge.mag[idx - edge.w] &&
        mag >= edge.mag[idx + edge.w]
          ? 0.45
          : 0;
      const edgeReward = Math.min(3.2, mag / Math.max(threshold, 1)) * 2.4;
      const weakPenalty = mag < threshold * 0.45 ? 2.5 : 0;
      row.push({
        point: [x + edge.offX, y + edge.offY],
        offset,
        baseCost: centerPenalty * 0.5 + tangentPenalty * 0.65 + weakPenalty - edgeReward - ridgeBonus,
      });
    }
    rows.push(row);
  }

  if (rows.length === 0) return [from, to];

  const costs: number[][] = [];
  const prev: number[][] = [];
  const transition = (a: number, b: number) => {
    const jump = Math.abs(a - b) / (r + 1);
    return jump * jump * 0.9 + jump * 0.25;
  };

  rows.forEach((row, rowIndex) => {
    costs[rowIndex] = new Array(row.length).fill(Infinity);
    prev[rowIndex] = new Array(row.length).fill(-1);
    row.forEach((candidate, ci) => {
      if (rowIndex === 0) {
        costs[rowIndex][ci] = candidate.baseCost + transition(0, candidate.offset);
        return;
      }
      const previousRow = rows[rowIndex - 1];
      for (let pi = 0; pi < previousRow.length; pi++) {
        const score = costs[rowIndex - 1][pi] + candidate.baseCost + transition(previousRow[pi].offset, candidate.offset);
        if (score < costs[rowIndex][ci]) {
          costs[rowIndex][ci] = score;
          prev[rowIndex][ci] = pi;
        }
      }
    });
  });

  const lastRow = rows.length - 1;
  let bestIndex = 0;
  let bestCost = Infinity;
  rows[lastRow].forEach((candidate, ci) => {
    const score = costs[lastRow][ci] + transition(candidate.offset, 0) * 0.35;
    if (score < bestCost) {
      bestCost = score;
      bestIndex = ci;
    }
  });

  const traced: [number, number][] = [from];
  const chosen: [number, number][] = [];
  for (let row = lastRow, ci = bestIndex; row >= 0 && ci >= 0; row--) {
    chosen.push(rows[row][ci].point);
    ci = prev[row][ci];
  }
  chosen.reverse();
  if (!traceIsReliable(edge, chosen, threshold)) return [from, to];
  traced.push(...chosen, to);
  return traced;
}

/** Snap every point of a drawn loop to nearby edges (commit-time pass). */
export function traceMagneticSegment(
  edge: EdgeMap,
  from: [number, number],
  to: [number, number],
  radius: number,
  contrast = DEFAULT_MAGNETIC_SNAP.contrast,
): [number, number][] {
  return traceLiveWireSegment(edge, from, to, radius, contrast) ?? sampleMagneticSegment(edge, from, to, radius, contrast);
}

export function snapLoopToEdges(
  edge: EdgeMap,
  points: readonly [number, number][],
  radius: number,
  contrast = DEFAULT_MAGNETIC_SNAP.contrast,
): [number, number][] {
  if (points.length <= 1) return points.map((p) => [...p] as [number, number]);
  const snapped: [number, number][] = [snapToEdge(edge, points[0], radius, contrast)];
  for (let i = 1; i < points.length; i++) {
    const target = snapToEdge(edge, points[i], radius, contrast);
    const segment = traceMagneticSegment(edge, snapped[snapped.length - 1], target, radius, contrast);
    for (const pt of segment.slice(1)) {
      const last = snapped[snapped.length - 1];
      if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1) snapped.push(pt);
    }
  }
  if (snapped.length >= 3) {
    const closing = traceMagneticSegment(edge, snapped[snapped.length - 1], snapped[0], radius, contrast);
    for (const pt of closing.slice(1, -1)) {
      const last = snapped[snapped.length - 1];
      if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1) snapped.push(pt);
    }
  }
  return compactCommittedLoop(snapped);
}
