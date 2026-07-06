// H-Gripe's default data wire: a lightweight structured polyline with one 45
// degree diagonal cut.

export interface Pt {
  x: number;
  y: number;
}

export function pointsToPath(points: Pt[]): string {
  return simplifyPoints(points)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)},${round(p.y)}`)
    .join(" ");
}

export function chamferPoints(s: Pt, t: Pt): Pt[] {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < 1 || absDy < 1) return [s, t];

  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  const lead = clamp(absDx * 0.22, 28, 96, Math.max(0, absDx - absDy));
  const diagonalRun = Math.min(absDy, Math.max(0, absDx - lead));

  if (diagonalRun < 4) return [s, t];

  const p1 = { x: s.x + sx * lead, y: s.y };
  const p2 = { x: p1.x + sx * diagonalRun, y: s.y + sy * diagonalRun };

  return [s, p1, p2, t];
}

export function chamferPath(s: Pt, t: Pt): string {
  return pointsToPath(chamferPoints(s, t));
}

// Bounded memo over endpoint coordinates. Edge components re-render (and
// remount, with viewport culling) far more often than their geometry changes,
// so identical endpoint pairs reuse the built path string.
const PATH_CACHE_LIMIT = 4096;
const pathCache = new Map<string, string>();

export function cachedChamferPath(s: Pt, t: Pt): string {
  const key = `${s.x},${s.y},${t.x},${t.y}`;
  const hit = pathCache.get(key);
  if (hit !== undefined) return hit;
  const path = chamferPath(s, t);
  if (pathCache.size >= PATH_CACHE_LIMIT) pathCache.clear();
  pathCache.set(key, path);
  return path;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(value: number, min: number, max: number, hardMax = max): number {
  const cappedMax = Math.max(0, Math.min(max, hardMax));
  return Math.min(cappedMax, Math.max(Math.min(min, cappedMax), value));
}

function simplifyPoints(points: Pt[]): Pt[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    return !prev || Math.abs(prev.x - p.x) > 0.5 || Math.abs(prev.y - p.y) > 0.5;
  });
}
