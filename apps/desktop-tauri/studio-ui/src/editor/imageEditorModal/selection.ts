import { pointInPolygon } from "./pathGeometry";
import type { SelectionAlphaClip } from "../../contracts/imageEditOps";

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
  | "point"
  | "mask"
  | "path"
  | "manual";

export type SelectionCombineMode = "replace" | "add" | "subtract" | "intersect";

export interface SelectionGeometry {
  region: SelectionBox;
  ellipse: boolean;
  polygon?: SelectionPoint[];
  selectionAlpha?: SelectionAlphaClip;
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
  selectionAlpha?: SelectionAlphaClip;
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

export function createSelectionAlphaDraft(
  region: SelectionBox,
  selectionAlpha: SelectionAlphaClip,
  source: SelectionSource,
): SelectionDraft {
  return {
    region: [...region] as SelectionBox,
    ellipse: false,
    selectionAlpha: {
      width: Math.max(1, Math.round(selectionAlpha.width)),
      height: Math.max(1, Math.round(selectionAlpha.height)),
      startsWith: selectionAlpha.startsWith,
      runs: selectionAlpha.runs.map((run) => Math.max(0, Math.round(run))),
    },
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
  const { polygon: _polygon, selectionAlpha: _selectionAlpha, ...rest } = selection;
  return {
    ...rest,
    region: [...region] as SelectionBox,
    ellipse,
  } as T;
}

export function resizeSelectionDraftBox(
  draft: SelectionDraft,
  width: number,
  height: number,
  dims: { w: number; h: number },
): SelectionDraft {
  const cw = Math.max(2, Math.min(Math.round(width), Math.max(2, dims.w)));
  const ch = Math.max(2, Math.min(Math.round(height), Math.max(2, dims.h)));
  const x0 = Math.max(0, Math.min(Math.min(draft.region[0], draft.region[2]), Math.max(0, dims.w - cw)));
  const y0 = Math.max(0, Math.min(Math.min(draft.region[1], draft.region[3]), Math.max(0, dims.h - ch)));
  return replaceSelectionBox(draft, [x0, y0, x0 + cw, y0 + ch], draft.ellipse);
}

/** One selection overlay scene both renderers (SVG/2D canvas and the WGPU
 * host) consume: the solid draft outline and the marching-ants active
 * selection are mutually exclusive — a draft always suppresses the ants. */
export interface SelectionOverlayScene {
  draft: SelectionGeometry | null;
  ants: SelectionGeometry | null;
}

export function buildSelectionOverlayScene(
  draft: SelectionDraft | null | undefined,
  active: ActiveSelection | null | undefined,
): SelectionOverlayScene {
  if (draft) return { draft, ants: null };
  if (active) return { draft: null, ants: active };
  return { draft: null, ants: null };
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
      return "point";
    default:
      return "manual";
  }
}

export function commitSelectionDraft(draft: SelectionDraft): ActiveSelection {
  return {
    region: [...draft.region] as SelectionBox,
    ellipse: draft.ellipse,
    ...(draft.polygon ? { polygon: draft.polygon.map(([x, y]) => [x, y] as SelectionPoint) } : null),
    ...(draft.selectionAlpha
      ? { selectionAlpha: { ...draft.selectionAlpha, runs: [...draft.selectionAlpha.runs] } }
      : null),
    ...(draft.source ? { source: draft.source } : null),
    combineMode: draft.combineMode ?? "replace",
    antiAlias: true,
  };
}

export function selectionClipFromActive(selection: ActiveSelection): SelectionClip {
  if (selection.selectionAlpha) {
    return {
      region: [...selection.region] as SelectionBox,
      selectionAlpha: {
        ...selection.selectionAlpha,
        runs: [...selection.selectionAlpha.runs],
      },
    };
  }
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
  if (selection.selectionAlpha) {
    return pointInSelectionAlpha(point, selection.region, selection.selectionAlpha);
  }
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

function pointInSelectionAlpha(
  point: SelectionPoint,
  region: SelectionBox,
  selectionAlpha: SelectionAlphaClip,
): boolean {
  const x0 = Math.min(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]);
  const localX = Math.floor(point[0] - x0);
  const localY = Math.floor(point[1] - y0);
  const width = Math.max(1, Math.round(selectionAlpha.width));
  const height = Math.max(1, Math.round(selectionAlpha.height));
  if (localX < 0 || localY < 0 || localX >= width || localY >= height) return false;
  let index = localY * width + localX;
  let value = selectionAlpha.startsWith;
  for (const rawRun of selectionAlpha.runs) {
    const run = Math.max(0, Math.round(rawRun));
    if (index < run) return value > 0;
    index -= run;
    value = value > 0 ? 0 : 255;
  }
  return false;
}
