// H-Gripe's default data wire: a lightweight structured polyline with one 45
// degree diagonal cut.

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeRouteOptions {
  sourcePosition?: string;
  targetPosition?: string;
  stubLength?: number;
}

export const EDGE_PORT_STUB_LENGTH = 22;

export function pointsToPath(points: Pt[]): string {
  return simplifyPoints(points)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)},${round(p.y)}`)
    .join(" ");
}

export function chamferPoints(s: Pt, t: Pt): Pt[] {
  return chamferCorePoints(s, t);
}

export function portedChamferPoints(s: Pt, t: Pt, options: EdgeRouteOptions = {}): Pt[] {
  const sourceStub = offsetPortPoint(
    s,
    options.sourcePosition ?? inferredSourcePosition(s, t),
    options.stubLength,
  );
  const targetStub = offsetPortPoint(
    t,
    options.targetPosition ?? inferredTargetPosition(s, t),
    options.stubLength,
  );
  return simplifyPoints([s, ...chamferCorePoints(sourceStub, targetStub), t]);
}

function chamferCorePoints(s: Pt, t: Pt): Pt[] {
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

export function portedChamferPath(s: Pt, t: Pt, options: EdgeRouteOptions = {}): string {
  return pointsToPath(portedChamferPoints(s, t, options));
}

export function routedEdgePoints(
  s: Pt,
  t: Pt,
  waypoints: readonly Pt[] = [],
  options?: EdgeRouteOptions,
): Pt[] {
  if (!options) return waypoints.length > 0 ? [s, ...waypoints, t] : chamferPoints(s, t);
  const sourceStub = offsetPortPoint(
    s,
    options.sourcePosition ?? inferredSourcePosition(s, t),
    options.stubLength,
  );
  const targetStub = offsetPortPoint(
    t,
    options.targetPosition ?? inferredTargetPosition(s, t),
    options.stubLength,
  );
  return waypoints.length > 0
    ? simplifyPoints([s, sourceStub, ...waypoints, targetStub, t])
    : portedChamferPoints(s, t, options);
}

export function routedEdgePath(
  s: Pt,
  t: Pt,
  waypoints: readonly Pt[] = [],
  options?: EdgeRouteOptions,
): string {
  return pointsToPath(routedEdgePoints(s, t, waypoints, options));
}

// Bounded memo over endpoint coordinates. Edge components re-render (and
// remount, with viewport culling) far more often than their geometry changes,
// so identical endpoint pairs reuse the built path string.
const PATH_CACHE_LIMIT = 4096;
const pathCache = new Map<string, string>();

export function cachedChamferPath(s: Pt, t: Pt): string {
  return cachedRoutedEdgePath(s, t);
}

export function cachedRoutedEdgePath(
  s: Pt,
  t: Pt,
  waypoints: readonly Pt[] = [],
  options?: EdgeRouteOptions,
): string {
  const waypointKey = waypoints.map((point) => `${point.x},${point.y}`).join(";");
  const optionKey = options
    ? `${options.sourcePosition ?? ""},${options.targetPosition ?? ""},${options.stubLength ?? ""}`
    : "";
  const key = `${s.x},${s.y}|${waypointKey}|${t.x},${t.y}|${optionKey}`;
  const hit = pathCache.get(key);
  if (hit !== undefined) return hit;
  const path = routedEdgePath(s, t, waypoints, options);
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

function offsetPortPoint(point: Pt, position: string, stubLength = EDGE_PORT_STUB_LENGTH): Pt {
  const length = Math.max(0, stubLength);
  switch (position) {
    case "left":
      return { x: point.x - length, y: point.y };
    case "right":
      return { x: point.x + length, y: point.y };
    case "top":
      return { x: point.x, y: point.y - length };
    case "bottom":
      return { x: point.x, y: point.y + length };
    default:
      return point;
  }
}

function inferredSourcePosition(s: Pt, t: Pt): string {
  return t.x >= s.x ? "right" : "left";
}

function inferredTargetPosition(s: Pt, t: Pt): string {
  return t.x >= s.x ? "left" : "right";
}

function simplifyPoints(points: Pt[]): Pt[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    return !prev || Math.abs(prev.x - p.x) > 0.5 || Math.abs(prev.y - p.y) > 0.5;
  });
}
