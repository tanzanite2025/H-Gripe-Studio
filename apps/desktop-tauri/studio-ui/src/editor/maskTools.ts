// Mask-Edit tool registry (Subject Mask card).
//
// The Mask-Edit modal renders its toolbar from this registry rather than
// hard-coding buttons. A `planned` tool renders greyed ("coming soon") and is
// not selectable. This mirrors the frozen contract in
// `docs/cards/subject-mask-matte.md` (§ "Mask-Edit tool registry").

import type { ExecLane } from "./execLanes";

export type ToolStatus = "ready" | "planned";

/**
 * What a paint tool's strokes are recorded onto (M4 tool/target decoupling):
 * the active mask layer's edit stack, or the document-level trimap matting
 * band. The same brush can therefore paint either target without switching
 * to a dedicated tool.
 */
export type PaintTarget = "layer" | "matte";

/** How a tool behaves on the canvas, which drives pointer handling. */
export type ToolKind =
  // Freehand paint that records a `brush_strokes` entry.
  | "paint"
  // Single click that records an `operations` entry seeded at the click point.
  | "click"
  // Single click that records a SAM 2 point prompt (`points` entry).
  | "point"
  // Freehand paint that records a `matte_strokes` entry: the trimap unknown
  // band the matter resolves into soft alpha (hair / fur / glass).
  | "matte"
  // Whole-mask operation with no canvas interaction (records an `operations` entry).
  | "global"
  // Drag a marquee that records an `operations` entry with a rect region.
  | "marquee"
  // Drag on the canvas to move the mask: records a `transform` op with the
  // drag's `dx`/`dy` (Ctrl+T opens the numeric free-transform panel).
  | "transform"
  // Vector path selection: pen (click anchors, bezier-capable) / lasso
  // (freehand). Recorded as an `EditPath`; the backend rasterises the closed
  // polygon and boolean-combines it with the mask (add/subtract/intersect).
  | "path"
  // Canvas navigation (M8): hand pans the zoomed view, zoom clicks in/out.
  // Records nothing — the view is a CSS transform, never part of the document.
  | "view"
  // Drag a start → end vector that records a `gradient` op: a linear ramp
  // (full selection at the start fading to none at the end) unioned into or
  // cut away from the mask (M10).
  | "gradient"
  // Freehand paint that records a `heal` op: the painted region is rebuilt
  // smoothly from the surrounding mask (PS spot-healing brush).
  | "heal"
  // Alt+click picks a source point, then painting records a `clone` op:
  // the stroke copies the mask from the source-offset region (PS clone stamp).
  | "clone"
  // Freehand paint that records a `history_brush` op: the painted region is
  // restored to the layer's initial state — the mask as it was before any
  // edit steps (PS history brush with the source set to the opening state).
  | "history"
  // Freehand paint that records a `dodge_burn` op: the painted region is
  // locally lightened (dodge) or, with Alt held, darkened (burn).
  | "dodge"
  // Click samples the image colour under the cursor from the underlay (PS
  // eyedropper) — a pure read: nothing is recorded on the document.
  | "sample"
  // Drag a bounding box that commits a geometric shape (triangle / polygon /
  // star / line) as an ordinary vector path step (PS shape tools on a mask).
  | "shape";

export interface MaskTool {
  id: string;
  /** Short label shown on the toolbar button. */
  label: string;
  /** `ready` tools are interactive; `planned` render greyed and disabled. */
  status: ToolStatus;
  kind: ToolKind;
  /** `add` builds the mask up, `subtract` cuts it away (paint/marquee tools). */
  mode?: "add" | "subtract";
  /**
   * Execution lane this tool's work runs in (see `execLanes.ts`):
   * - `interactive`: drawn instantly on the canvas (paint / marquee / path);
   * - `preview`: cheap geometry / morphology, proxy-previewable;
   * - `render`: model inference or real-pixel work gated behind the GPU queue.
   */
  lane: ExecLane;
  /** One-line tooltip describing the Phase 1 behaviour. */
  hint: string;
  /**
   * Targets this tool can act on (paint tools only). Absent ⇒ the tool is
   * bound to its single implicit target (`layer` for paint/marquee/path,
   * `matte` for the matting band tool).
   */
  targets?: readonly PaintTarget[];
}

// Order here is the toolbar order. Keep `ready` tools first, `planned` last,
// matching the contract table.
export const MASK_TOOLS: readonly MaskTool[] = [
  { id: "brush", label: "Brush", status: "ready", kind: "paint", mode: "add", lane: "interactive", hint: "Paint mask in.", targets: ["layer", "matte"] },
  { id: "eraser", label: "Eraser", status: "ready", kind: "paint", mode: "subtract", lane: "interactive", hint: "Paint mask out." },
  { id: "point", label: "Point (SAM 2)", status: "ready", kind: "point", lane: "render", hint: "Left-click the subject to include, right-click to exclude — SAM 2 segments from your points (auto modes)." },
  { id: "wand", label: "Wand", status: "ready", kind: "click", lane: "render", hint: "Flood-fill a region by colour similarity (wand_tolerance)." },
  { id: "rect", label: "Rect", status: "ready", kind: "marquee", mode: "add", lane: "interactive", hint: "Marquee add a rectangle." },
  { id: "ellipse", label: "Ellipse", status: "ready", kind: "marquee", mode: "add", lane: "interactive", hint: "Marquee add an ellipse." },
  { id: "invert", label: "Invert", status: "ready", kind: "global", lane: "preview", hint: "Invert the whole mask." },
  { id: "fill_holes", label: "Fill holes", status: "ready", kind: "global", lane: "preview", hint: "Close interior holes." },
  { id: "smooth", label: "Smooth", status: "ready", kind: "global", lane: "preview", hint: "Morphological open/close." },
  { id: "grow", label: "Grow", status: "ready", kind: "global", lane: "preview", hint: "Dilate the mask by N px." },
  { id: "shrink", label: "Shrink", status: "ready", kind: "global", lane: "preview", hint: "Erode the mask by N px." },
  { id: "feather", label: "Feather", status: "ready", kind: "global", lane: "preview", hint: "Gaussian-feather the mask edge." },
  { id: "blur", label: "Blur", status: "ready", kind: "global", lane: "preview", hint: "Gaussian-blur the whole mask by N px (a revisable filter step)." },
  { id: "sharpen", label: "Sharpen", status: "ready", kind: "global", lane: "preview", hint: "Unsharp-mask sharpen the mask edge by N px (a revisable filter step)." },
  { id: "matting", label: "Matting", status: "ready", kind: "matte", lane: "render", hint: "Paint the trimap unknown band over hair / fur / glass — the matter resolves it into soft alpha." },
  { id: "heal", label: "Heal", status: "ready", kind: "heal", lane: "preview", hint: "Spot-healing brush: paint over a blemish — the region is rebuilt smoothly from the surrounding mask (a revisable step)." },
  { id: "clone", label: "Clone", status: "ready", kind: "clone", lane: "preview", hint: "Clone stamp: Alt+click picks a source point, then paint copies the mask from the source offset (a revisable step)." },
  { id: "history_brush", label: "History brush", status: "ready", kind: "history", lane: "preview", hint: "History brush: paint a region back to the layer's initial state — the mask before any edit steps (a revisable step)." },
  { id: "dodge_burn", label: "Dodge / burn", status: "ready", kind: "dodge", lane: "preview", hint: "Dodge / burn: paint to locally lighten the mask (Alt-drag darkens) — a revisable step." },
  { id: "eyedropper", label: "Eyedropper", status: "ready", kind: "sample", lane: "interactive", hint: "Eyedropper: click to sample the image colour under the cursor — the swatch shows in tool options." },
  { id: "pen", label: "Pen", status: "ready", kind: "path", lane: "interactive", hint: "Click to place anchor points; click the first point (or Close path) to close — rasterised + boolean-combined on run." },
  { id: "shape", label: "Shape", status: "ready", kind: "shape", lane: "interactive", hint: "Drag a box — the chosen shape (triangle / polygon / star / line) commits as an ordinary path step (add / subtract / intersect)." },
  { id: "lasso", label: "Lasso", status: "ready", kind: "path", lane: "interactive", hint: "Drag a freehand loop around the subject; released, it closes into a path selection." },
  { id: "gradient", label: "Gradient", status: "ready", kind: "gradient", mode: "add", lane: "interactive", hint: "Drag start → end: a linear ramp from full selection to none, as a revisable step (Alt-drag subtracts)." },
  { id: "move", label: "Move", status: "ready", kind: "transform", lane: "preview", hint: "Drag to move the mask; Ctrl+T opens free transform (move / scale / rotate as a revisable step)." },
  { id: "crop", label: "Crop", status: "ready", kind: "marquee", lane: "preview", hint: "Drag a crop box — the mask is cleared outside it (a revisable step)." },
  { id: "hand", label: "Hand", status: "ready", kind: "view", lane: "interactive", hint: "Drag to pan the zoomed view (or hold Space with any tool)." },
  { id: "rotate_view", label: "Rotate view", status: "ready", kind: "view", lane: "interactive", hint: "Drag to rotate the view around its centre — screen-space only, the mask is untouched (Esc resets, Ctrl+0 fits and resets)." },
  { id: "zoom", label: "Zoom", status: "ready", kind: "view", lane: "interactive", hint: "Click to zoom in at that point, Alt+click to zoom out (Ctrl+0 fit, Ctrl+1 100%)." },
  // Planned tools: greyed placeholders holding their PS toolbar slot (and
  // reserved key) until each ships. Keep `planned` after every `ready` entry.
] as const;

/**
 * Toolbar groups in Photoshop's toolbar order (selection → paint → vector →
 * whole-mask operations → navigation), rendered with separators between
 * groups so tools sit where a PS user expects them. Every `MASK_TOOLS` id
 * appears in exactly one group (pinned by a registry test).
 */
export const MASK_TOOL_GROUPS: readonly (readonly string[])[] = [
  // Selection block (PS V / M / L / W / C / I row): move, marquees, lasso,
  // wand / SAM points, crop, eyedropper.
  ["move", "rect", "ellipse", "lasso", "wand", "point", "crop", "eyedropper"],
  // Paint / retouch block (PS J / B / S / Y / E / G / O row): heal, brush,
  // matting band, clone stamp, history brush, eraser, gradient, dodge/burn.
  ["heal", "brush", "matting", "clone", "history_brush", "eraser", "gradient", "dodge_burn"],
  // Vector block (PS P / U): pen, shapes.
  ["pen", "shape"],
  // Whole-mask operations (PS menu commands; toolbar buttons here).
  ["invert", "fill_holes", "smooth", "grow", "shrink", "feather", "blur", "sharpen"],
  // Navigation: hand, rotate-view, zoom.
  ["hand", "rotate_view", "zoom"],
] as const;

export const READY_TOOLS = MASK_TOOLS.filter((t) => t.status === "ready");
export const PLANNED_TOOLS = MASK_TOOLS.filter((t) => t.status === "planned");

export function maskTool(id: string): MaskTool | undefined {
  return MASK_TOOLS.find((t) => t.id === id);
}

/** The paint targets a tool can act on (defaults to its implicit target). */
export function toolTargets(tool: MaskTool): readonly PaintTarget[] {
  if (tool.targets) return tool.targets;
  return tool.kind === "matte" ? ["matte"] : ["layer"];
}

/** Shape-tool variants (PS U flyout, mask-relevant subset). */
export type ShapeKind = "triangle" | "polygon" | "star" | "line";

/**
 * The vertex polygon of a shape inscribed in the drag box `[x1,y1,x2,y2]`
 * (image px). `sides` is the vertex count for `polygon` / `star` (min 3);
 * `line` is a thin `thickness`-px rectangle along the drag vector. The
 * result feeds the ordinary path-op rasteriser, so shapes replay like any
 * pen / lasso step.
 */
export function shapeVertices(
  kind: ShapeKind,
  box: [number, number, number, number],
  sides: number,
  thickness = 4,
): [number, number][] {
  const [x1, y1, x2, y2] = box;
  if (kind === "line") {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len === 0) return [];
    const t = Math.max(1, thickness) / 2;
    // Unit normal to the drag vector.
    const nx = (-(y2 - y1) / len) * t;
    const ny = ((x2 - x1) / len) * t;
    return [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ];
  }
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  if (rx === 0 || ry === 0) return [];
  const n = Math.max(3, Math.round(sides));
  const points: [number, number][] = [];
  if (kind === "star") {
    // n outer points interleaved with n half-radius inner points.
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const f = i % 2 === 0 ? 1 : 0.5;
      points.push([cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]);
    }
    return points;
  }
  const count = kind === "triangle" ? 3 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    points.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return points;
}

/** First selectable (ready) tool — the modal's default. */
export const DEFAULT_TOOL_ID = READY_TOOLS[0]?.id ?? "brush";
