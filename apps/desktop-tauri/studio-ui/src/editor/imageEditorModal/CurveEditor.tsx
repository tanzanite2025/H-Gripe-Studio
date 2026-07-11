// PS-style tone-curve editor: a square 0..255 grid with draggable control
// points over the piecewise-linear curve the adjustment LUT resolves to
// (`adjustmentLut` in maskMorphology.ts). Click the grid to add a point, drag
// a point far outside to remove it. Changes commit on pointer-up so one drag
// is one undo step.

import { useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";

const RANGE = 255;
/** How far (in curve units) a dragged point must leave the grid to be removed. */
const REMOVE_MARGIN = 48;
/** Hit radius (in curve units) for grabbing an existing point. */
const HIT_RADIUS = 14;

export const IDENTITY_CURVE: [number, number][] = [
  [0, 0],
  [255, 255],
];

interface CurveEditorProps {
  /** Sorted-by-x control points, 0..255. Empty / short lists mean identity. */
  points: [number, number][] | undefined;
  onChange: (points: [number, number][]) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function normalized(points: [number, number][] | undefined): [number, number][] {
  const pts = (points ?? [])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [clamp(Math.round(p[0]), 0, RANGE), clamp(Math.round(p[1]), 0, RANGE)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return pts.length >= 2 ? pts : IDENTITY_CURVE.map((p) => [...p] as [number, number]);
}

export function CurveEditor({ points, onChange }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Draft shown while dragging; null when idle (render the committed points).
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const dragIndex = useRef(-1);

  const committed = normalized(points);
  const pts = draft ?? committed;

  // Map a pointer/mouse event onto curve coordinates (y up).
  const toCurve = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * RANGE;
    const y = (1 - (e.clientY - rect.top) / rect.height) * RANGE;
    return [x, y];
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const [x, y] = toCurve(e);
    let next = committed.map((p) => [...p] as [number, number]);
    let index = next.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) <= HIT_RADIUS);
    if (index < 0) {
      const point: [number, number] = [clamp(Math.round(x), 0, RANGE), clamp(Math.round(y), 0, RANGE)];
      index = next.findIndex((p) => p[0] > point[0]);
      if (index < 0) index = next.length;
      next = [...next.slice(0, index), point, ...next.slice(index)];
    }
    dragIndex.current = index;
    setDraft(next);
    svgRef.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (dragIndex.current < 0 || !draft) return;
    const [x, y] = toCurve(e);
    const i = dragIndex.current;
    const next = draft.map((p) => [...p] as [number, number]);
    // Dragging well off the grid removes the point (never below 2 points).
    const out = x < -REMOVE_MARGIN || x > RANGE + REMOVE_MARGIN || y < -REMOVE_MARGIN || y > RANGE + REMOVE_MARGIN;
    if (out && next.length > 2) {
      next.splice(i, 1);
      dragIndex.current = -1;
      setDraft(next);
      return;
    }
    // Keep x strictly between the neighbours so the list stays sorted.
    const lo = i > 0 ? next[i - 1][0] + 1 : 0;
    const hi = i < next.length - 1 ? next[i + 1][0] - 1 : RANGE;
    next[i] = [clamp(Math.round(x), lo, hi), clamp(Math.round(y), 0, RANGE)];
    setDraft(next);
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    dragIndex.current = -1;
    setDraft(null);
    if (JSON.stringify(draft) !== JSON.stringify(committed)) onChange(draft);
  };

  const onDoubleClick = (e: MouseEvent<SVGSVGElement>) => {
    const [x, y] = toCurve(e);
    const i = committed.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) <= HIT_RADIUS);
    if (i >= 0 && committed.length > 2) {
      onChange(committed.filter((_, j) => j !== i));
    }
  };

  const dragging = dragIndex.current >= 0 && draft ? draft[dragIndex.current] : null;
  const toSvg = ([x, y]: [number, number]) => [x, RANGE - y] as const;
  const line = pts.map((p) => toSvg(p).join(",")).join(" ");

  return (
    <div className="mask-curve">
      <svg
        ref={svgRef}
        className="mask-curve-grid"
        viewBox={`0 0 ${RANGE} ${RANGE}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {[1, 2, 3].map((i) => (
          <g key={i} className="mask-curve-gridline">
            <line x1={(i * RANGE) / 4} y1={0} x2={(i * RANGE) / 4} y2={RANGE} />
            <line x1={0} y1={(i * RANGE) / 4} x2={RANGE} y2={(i * RANGE) / 4} />
          </g>
        ))}
        <line className="mask-curve-identity" x1={0} y1={RANGE} x2={RANGE} y2={0} />
        <polyline className="mask-curve-line" points={line} />
        {pts.map((p, i) => {
          const [cx, cy] = toSvg(p);
          return (
            <circle
              key={i}
              className={`mask-curve-point${draft && i === dragIndex.current ? " active" : ""}`}
              cx={cx}
              cy={cy}
              r={5}
            />
          );
        })}
      </svg>
      <div className="mask-curve-readout muted">
        {dragging ? `${dragging[0]} → ${dragging[1]}` : "\u00a0"}
      </div>
    </div>
  );
}
