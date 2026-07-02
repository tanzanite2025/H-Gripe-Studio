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
  | "view";

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
  { id: "pen", label: "Pen", status: "ready", kind: "path", lane: "interactive", hint: "Click to place anchor points; click the first point (or Close path) to close — rasterised + boolean-combined on run." },
  { id: "lasso", label: "Lasso", status: "ready", kind: "path", lane: "interactive", hint: "Drag a freehand loop around the subject; released, it closes into a path selection." },
  { id: "move", label: "Move", status: "ready", kind: "transform", lane: "preview", hint: "Drag to move the mask; Ctrl+T opens free transform (move / scale / rotate as a revisable step)." },
  { id: "crop", label: "Crop", status: "ready", kind: "marquee", lane: "preview", hint: "Drag a crop box — the mask is cleared outside it (a revisable step)." },
  { id: "hand", label: "Hand", status: "ready", kind: "view", lane: "interactive", hint: "Drag to pan the zoomed view (or hold Space with any tool)." },
  { id: "zoom", label: "Zoom", status: "ready", kind: "view", lane: "interactive", hint: "Click to zoom in at that point, Alt+click to zoom out (Ctrl+0 fit, Ctrl+1 100%)." },
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

/** First selectable (ready) tool — the modal's default. */
export const DEFAULT_TOOL_ID = READY_TOOLS[0]?.id ?? "brush";
