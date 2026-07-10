import { pointInPolygon } from "./pathGeometry";

export type SelectionPoint = [number, number];
export type SelectionBox = [number, number, number, number];

export type SelectionSource =
  | "rect_marquee"
  | "ellipse_marquee"
  | "pen"
  | "polygon_lasso"
  | "magnetic_lasso"
  | "object_select"
  | "quick_select"
  | "magic_wand"
  | "sam2"
  | "mask"
  | "path"
  | "manual";

export type SelectionCombineMode = "replace" | "add" | "subtract" | "intersect";

export interface SelectionGeometry {
  region: SelectionBox;
  ellipse: boolean;
  polygon?: SelectionPoint[];
}

export interface SelectionDraft extends SelectionGeometry {
  status?: "drafting" | "closed";
  source?: SelectionSource;
  combineMode?: SelectionCombineMode;
}

export interface ActiveSelection extends SelectionGeometry {
  source?: SelectionSource;
  combineMode?: SelectionCombineMode;
  antiAlias?: boolean;
}

export interface SelectionClip {
  region: SelectionBox;
  ellipse?: boolean;
  points?: SelectionPoint[];
}

export type SelectionOutline = SelectionGeometry;

export function selectionBoundsFromPoints(points: readonly SelectionPoint[]): SelectionBox {
  if (points.length === 0) return [0, 0, 0, 0];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function createPolygonSelection(
  points: readonly SelectionPoint[],
  source: SelectionSource = "polygon_lasso",
): SelectionDraft {
  return {
    region: selectionBoundsFromPoints(points),
    ellipse: false,
    polygon: points.map(([x, y]) => [x, y] as SelectionPoint),
    status: "closed",
    source,
    combineMode: "replace",
  };
}

export function createBoxSelection(
  region: SelectionBox,
  ellipse = false,
  source: SelectionSource = ellipse ? "ellipse_marquee" : "rect_marquee",
): SelectionDraft {
  return {
    region: [...region] as SelectionBox,
    ellipse,
    status: "closed",
    source,
    combineMode: "replace",
  };
}

export function replaceSelectionBox<T extends SelectionGeometry>(
  selection: T,
  region: SelectionBox,
  ellipse = selection.ellipse,
): T {
  const { polygon: _polygon, ...rest } = selection;
  return {
    ...rest,
    region: [...region] as SelectionBox,
    ellipse,
  } as T;
}

export function selectionSourceFromToolId(toolId: string): SelectionSource {
  switch (toolId) {
    case "rect":
      return "rect_marquee";
    case "ellipse":
      return "ellipse_marquee";
    case "pen":
    case "curvature_pen":
      return "pen";
    case "polygon_lasso":
      return "polygon_lasso";
    case "magnetic_lasso":
      return "magnetic_lasso";
    case "object_select":
      return "object_select";
    case "quick_select":
      return "quick_select";
    case "wand":
      return "magic_wand";
    case "point":
      return "path";
    default:
      return "manual";
  }
}

export function commitSelectionDraft(draft: SelectionDraft): ActiveSelection {
  return {
    region: [...draft.region] as SelectionBox,
    ellipse: draft.ellipse,
    ...(draft.polygon ? { polygon: draft.polygon.map(([x, y]) => [x, y] as SelectionPoint) } : null),
    ...(draft.source ? { source: draft.source } : null),
    combineMode: draft.combineMode ?? "replace",
    antiAlias: true,
  };
}

export function selectionClipFromActive(selection: ActiveSelection): SelectionClip {
  if (selection.polygon && selection.polygon.length >= 3) {
    return {
      region: [...selection.region] as SelectionBox,
      points: selection.polygon.map(([x, y]) => [x, y] as SelectionPoint),
    };
  }
  return {
    region: [...selection.region] as SelectionBox,
    ...(selection.ellipse ? { ellipse: true } : null),
  };
}

export function pointInSelection(point: SelectionPoint, selection: SelectionGeometry): boolean {
  if (selection.polygon) return pointInPolygon(point, selection.polygon);
  const [x0, y0, x1, y1] = selection.region;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const [x, y] = point;
  if (x < left || x > right || y < top || y > bottom) return false;
  if (!selection.ellipse) return true;
  const rx = Math.max((right - left) / 2, 1);
  const ry = Math.max((bottom - top) / 2, 1);
  const cx = left + rx;
  const cy = top + ry;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}
