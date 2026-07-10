import { buildSelectionOverlayScene, type ActiveSelection, type SelectionGeometry, type SelectionPoint, type SelectionDraft } from "./selection";

interface SelectionOverlayProps {
  dims: { w: number; h: number };
  draft?: SelectionDraft | null;
  active?: ActiveSelection | null;
  phase?: number;
}

interface NormalizedSelection {
  left: number;
  top: number;
  width: number;
  height: number;
  ellipse: boolean;
  polygon?: SelectionPoint[];
}

function normalizeSelection(selection: SelectionGeometry): NormalizedSelection | null {
  const [x0, y0, x1, y1] = selection.region;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    ellipse: selection.ellipse,
    ...(selection.polygon && selection.polygon.length >= 3
      ? { polygon: selection.polygon }
      : null),
  };
}

function pointList(points: readonly SelectionPoint[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function SelectionShape({
  selection,
  className,
  phase,
}: {
  selection: NormalizedSelection;
  className: string;
  phase?: number;
}) {
  const shared = {
    className,
    vectorEffect: "non-scaling-stroke",
    style: phase == null ? undefined : { strokeDashoffset: phase },
  };

  if (selection.polygon) {
    return <polygon {...shared} points={pointList(selection.polygon)} />;
  }
  if (selection.ellipse) {
    return (
      <ellipse
        {...shared}
        cx={selection.left + selection.width / 2}
        cy={selection.top + selection.height / 2}
        rx={Math.max(selection.width / 2, 0.5)}
        ry={Math.max(selection.height / 2, 0.5)}
      />
    );
  }
  return (
    <rect
      {...shared}
      x={selection.left}
      y={selection.top}
      width={selection.width}
      height={selection.height}
    />
  );
}

export function SelectionOverlay({ dims, draft = null, active = null, phase = 0 }: SelectionOverlayProps) {
  if (dims.w <= 0 || dims.h <= 0) return null;
  const scene = buildSelectionOverlayScene(draft, active);
  const visibleSelection = scene.draft ?? scene.ants;
  if (!visibleSelection) return null;
  const selection = normalizeSelection(visibleSelection);
  if (!selection) return null;

  if (scene.draft) {
    return (
      <svg
        className="mask-selection-overlay"
        viewBox={`0 0 ${dims.w} ${dims.h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <SelectionShape selection={selection} className="mask-selection-draft-path" />
      </svg>
    );
  }

  return (
    <svg
      className="mask-selection-overlay"
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <SelectionShape selection={selection} className="mask-selection-ants-light" phase={-phase} />
      <SelectionShape selection={selection} className="mask-selection-ants-dark" phase={5 - phase} />
    </svg>
  );
}
