// Curve primitives (mirror Rust `ops/spline.rs`).

/**
 * Fritsch–Carlson monotone piecewise-cubic through the control points:
 * no overshoot, flat outside the endpoints (mirrors Rust `MonotoneSpline`).
 */
export function monotoneSpline(points: [number, number][]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  const tangents = new Array<number>(n).fill(0);
  if (n >= 2) {
    const d = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - x, 1e-6));
    tangents[0] = d[0];
    tangents[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) tangents[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        tangents[i] = 0;
        tangents[i + 1] = 0;
      } else {
        const a = tangents[i] / d[i];
        const b = tangents[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
          const t = 3 / Math.sqrt(s);
          tangents[i] = t * a * d[i];
          tangents[i + 1] = t * b * d[i];
        }
      }
    }
  }
  return (x: number) => {
    if (n === 0) return x;
    if (n === 1 || x <= xs[0]) return x <= xs[0] ? ys[0] : ys[n - 1];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i + 2 < n && x >= xs[i + 1]) i++;
    const h = Math.max(xs[i + 1] - xs[i], 1e-6);
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * tangents[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * tangents[i + 1]
    );
  };
}

// A hue-domain curve (period 360): points replicated one period below and
// above before building the spline so evaluation wraps seamlessly; no
// points evaluates to `neutral` (mirrors Rust `PeriodicSpline`).
export function periodicSpline(points: [number, number][], neutral: number): (hue: number) => number {
  if (points.length === 0) return () => neutral;
  const base = points
    .map(([x, y]): [number, number] => [((x % 360) + 360) % 360, y])
    .sort((a, b) => a[0] - b[0]);
  const wrapped: [number, number][] = [-360, 0, 360].flatMap((shift) =>
    base.map(([x, y]): [number, number] => [x + shift, y]),
  );
  const spline = monotoneSpline(wrapped);
  return (hue) => spline(((hue % 360) + 360) % 360);
}

// A 0..=1-domain multiplier curve: no points is the identity multiplier 1
// (mirrors Rust `MultiplierSpline`).
export function multiplierSpline(points: [number, number][]): (x: number) => number {
  if (points.length === 0) return () => 1;
  return monotoneSpline(points);
}
