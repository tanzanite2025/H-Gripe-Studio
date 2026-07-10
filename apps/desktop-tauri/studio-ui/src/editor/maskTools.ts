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
  // Vector path selection: pen anchors plus edge-guided / polygonal lasso
  // variants. Recorded as an `EditPath`; the backend rasterises the closed
  // polygon and boolean-combines it with the mask (add/subtract/intersect).
  | "path"
  // Canvas navigation (M8): hand pans the zoomed view, rotate-view rotates it.
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
  | "shape"
  // Click a committed path step on the canvas to re-open it for editing.
  // Commits through the ordinary anchor-edit flow (M2).
  | "path_edit";

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
  { id: "pencil", label: "Pencil", status: "ready", kind: "paint", mode: "add", lane: "interactive", hint: "Pencil: hard-edged strokes — a brush with hardness and flow pinned to 100%.", targets: ["layer", "matte"] },
  { id: "point", label: "Point (SAM 2)", status: "ready", kind: "point", lane: "render", hint: "Left-click the subject to include, right-click to exclude — SAM 2 segments from your points (auto modes)." },
  { id: "wand", label: "Wand", status: "ready", kind: "click", lane: "render", hint: "Flood-fill a region by colour similarity (wand_tolerance)." },
  { id: "paint_bucket", label: "Paint bucket", status: "ready", kind: "click", lane: "render", hint: "Paint bucket: click to flood-fill similar colours into the mask (tolerance-driven, like the wand)." },
  { id: "magic_eraser", label: "Magic eraser", status: "ready", kind: "click", mode: "subtract", lane: "render", hint: "Magic eraser: click to erase similar colours out of the mask — a wand flood-fill that subtracts." },
  { id: "quick_select", label: "Quick selection", status: "ready", kind: "paint", mode: "add", lane: "render", hint: "Quick selection: paint over the subject — each point seeds a tolerance flood-fill and the fills union into the mask." },
  { id: "object_select", label: "Object selection", status: "ready", kind: "marquee", lane: "render", hint: "Object selection: drag a box — the segmenter (SAM 2 when weights resolve, the builtin fallback otherwise) masks the object inside it on run." },
  { id: "background_eraser", label: "Background eraser", status: "ready", kind: "paint", mode: "subtract", lane: "render", hint: "Background eraser: paint and pixels matching the colour under the brush centre are erased from the mask (tolerance-keyed)." },
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
  { id: "pattern_stamp", label: "Pattern stamp", status: "ready", kind: "clone", lane: "preview", hint: "Pattern stamp: paint a repeating checker pattern into the mask (a revisable step)." },
  { id: "healing_brush", label: "Healing brush", status: "ready", kind: "heal", lane: "preview", hint: "Healing brush: Alt+click picks a source, then paint blends the mask from the source offset with feathered edges (a revisable step)." },
  { id: "patch", label: "Patch", status: "ready", kind: "heal", lane: "preview", hint: "Patch: draw a closed region, then drag it onto clean texture — the region is refilled from where you dropped it, edges feathered (a revisable step)." },
  { id: "remove", label: "Remove", status: "ready", kind: "heal", lane: "render", hint: "Remove: brush over an object — the stroke seeds the segmenter and the segmented object is subtracted from the mask on run." },
  { id: "content_aware_move", label: "Content-aware move", status: "ready", kind: "heal", lane: "preview", hint: "Content-aware move: draw a closed region, then drag it to its new place — the region moves there and the hole behind it is healed from its surroundings (a revisable step)." },
  { id: "red_eye", label: "Red eye", status: "ready", kind: "click", lane: "render", hint: "Red eye: click a red reflection — the contiguous red-dominant region floods into the mask." },
  { id: "history_brush", label: "History brush", status: "ready", kind: "history", lane: "preview", hint: "History brush: paint a region back to the layer's initial state — the mask before any edit steps (a revisable step)." },
  { id: "art_history_brush", label: "Art history brush", status: "ready", kind: "history", lane: "preview", hint: "Art history brush: paint stylised strokes that restore the layer's initial state through a deterministic jitter (a revisable step)." },
  { id: "dodge_burn", label: "Dodge / burn", status: "ready", kind: "dodge", lane: "preview", hint: "Dodge / burn: paint to locally lighten the mask (Alt-drag darkens) — a revisable step." },
  { id: "sponge", label: "Sponge", status: "ready", kind: "dodge", lane: "preview", hint: "Sponge: paint to push the mask toward hard on/off (Alt-drag softens toward mid-grey) — a revisable step." },
  { id: "eyedropper", label: "Eyedropper", status: "ready", kind: "sample", lane: "interactive", hint: "Eyedropper: click to sample the image colour under the cursor — the swatch shows in tool options." },
  { id: "color_sampler", label: "Color sampler", status: "ready", kind: "sample", lane: "interactive", hint: "Color sampler: click to pin up to four persistent colour readouts — listed in tool options, markers on the canvas." },
  { id: "pen", label: "Pen", status: "ready", kind: "path", lane: "interactive", hint: "Click to place anchor points; click the first point (or Close path) to close — rasterised + boolean-combined on run." },
  { id: "freeform_pen", label: "Freeform pen", status: "ready", kind: "path", lane: "interactive", hint: "Freeform pen: drag a freehand path; released, it closes into a path selection." },
  { id: "curvature_pen", label: "Curvature pen", status: "ready", kind: "path", lane: "interactive", hint: "Curvature pen: click points and a smooth closed curve is fitted through them on close." },
  { id: "path_select", label: "Path selection", status: "ready", kind: "path_edit", lane: "interactive", hint: "Path selection: click a committed path to select it, then drag to move the whole path (Done commits)." },
  { id: "shape", label: "Shape", status: "ready", kind: "shape", lane: "interactive", hint: "Drag a box — the chosen shape (triangle / polygon / star / line) commits as an ordinary path step (add / subtract / intersect)." },
  { id: "magnetic_lasso", label: "Magnetic lasso", status: "ready", kind: "path", lane: "interactive", hint: "Magnetic lasso: drag a loop and the points snap to nearby image edges on release." },
  { id: "polygon_lasso", label: "Polygonal lasso", status: "ready", kind: "path", lane: "interactive", hint: "Polygonal lasso: click straight segments around the subject; click the first point (or Close path) to close." },
  { id: "gradient", label: "Gradient", status: "ready", kind: "gradient", mode: "add", lane: "interactive", hint: "Drag start → end: a linear ramp from full selection to none, as a revisable step (Alt-drag subtracts)." },
  { id: "move", label: "Move", status: "ready", kind: "transform", lane: "preview", hint: "Drag to move the mask; Ctrl+T opens free transform (move / scale / rotate as a revisable step)." },
  { id: "crop", label: "Crop", status: "ready", kind: "marquee", lane: "preview", hint: "Drag a crop box — the mask is cleared outside it (a revisable step)." },
  { id: "hand", label: "Hand", status: "ready", kind: "view", lane: "interactive", hint: "Drag to pan the zoomed view (or hold Space with any tool)." },
  { id: "rotate_view", label: "Rotate view", status: "ready", kind: "view", lane: "interactive", hint: "Drag to rotate the view around its centre — screen-space only, the mask is untouched (Esc resets, Ctrl+0 fits and resets)." },
  // Planned tools: greyed placeholders holding their PS toolbar slot (and
  // reserved key) until each ships. Keep `planned` after every `ready` entry.
  { id: "color_replacement", label: "Color replacement", status: "planned", kind: "paint", lane: "render", hint: "Color replacement: paint a new hue while keeping texture (planned — colour has no meaning on a grayscale mask)." },
  { id: "mixer_brush", label: "Mixer brush", status: "planned", kind: "paint", lane: "render", hint: "Mixer brush: blends colours like wet paint (planned — colour has no meaning on a grayscale mask)." },
  { id: "type_horizontal", label: "Horizontal type", status: "planned", kind: "shape", lane: "interactive", hint: "Horizontal type: click to place editable text (planned)." },
  { id: "type_vertical", label: "Vertical type", status: "planned", kind: "shape", lane: "interactive", hint: "Vertical type: click to place vertical editable text (planned)." },
] as const;

/** Path tools that place anchors click-by-click and close via "Close path". */
export const ANCHOR_PATH_TOOLS: readonly string[] = ["pen", "polygon_lasso", "curvature_pen"];

/** Path tools that record a freehand drag loop, closed on pointer-up. */
export const FREEHAND_PATH_TOOLS: readonly string[] = ["freeform_pen", "magnetic_lasso"];

/**
 * A Photoshop toolbar slot (PS_TOOLBAR_PARITY_PLAN § "Proposed Registry
 * Shape"): one visible toolbar button owning a PS shortcut letter and a
 * flyout of tool variants. `variants` lists `MASK_TOOLS` ids in flyout
 * order; planned variants render greyed and disabled, holding the PS slot
 * shape until they ship.
 */
export interface PsToolSlot {
  id: string;
  /** The PS single-letter shortcut this slot owns (display only). */
  shortcut?: string;
  label: string;
  variants: readonly string[];
}

/**
 * The left toolbar as Photoshop slot sections (rendered with separators).
 * Slot order follows Photoshop's tool-slot order (V / M / L / W / C / I,
 * then J / B / S / Y / E / G / O, then P / T / A / U, then navigation);
 * every canvas tool id appears in exactly one slot (pinned by a registry
 * test). Whole-mask operations are not tools in the user's hand, so they
 * live in the right-panel Mask Ops group (`MASK_OPS`), not here (plan step 4).
 */
export const PS_TOOL_SECTIONS: readonly (readonly PsToolSlot[])[] = [
  [
    { id: "move", shortcut: "V", label: "Move", variants: ["move"] },
    { id: "marquee", shortcut: "M", label: "Marquee", variants: ["rect", "ellipse"] },
    { id: "lasso", shortcut: "L", label: "Lasso", variants: ["magnetic_lasso", "polygon_lasso"] },
    { id: "selection", shortcut: "W", label: "Selection", variants: ["object_select", "quick_select", "wand", "point"] },
    { id: "crop", shortcut: "C", label: "Crop", variants: ["crop"] },
    { id: "sample", shortcut: "I", label: "Sample", variants: ["eyedropper", "color_sampler"] },
  ],
  [
    { id: "repair", shortcut: "J", label: "Repair", variants: ["heal", "remove", "healing_brush", "patch", "content_aware_move", "red_eye"] },
    { id: "brush", shortcut: "B", label: "Brush", variants: ["brush", "pencil", "color_replacement", "mixer_brush", "matting"] },
    { id: "stamp", shortcut: "S", label: "Stamp", variants: ["clone", "pattern_stamp"] },
    { id: "history", shortcut: "Y", label: "History", variants: ["history_brush", "art_history_brush"] },
    { id: "eraser", shortcut: "E", label: "Eraser", variants: ["eraser", "background_eraser", "magic_eraser"] },
    { id: "fill", shortcut: "G", label: "Fill", variants: ["gradient", "paint_bucket"] },
    { id: "dodge", shortcut: "O", label: "Dodge", variants: ["dodge_burn", "sponge"] },
  ],
  [
    { id: "pen", shortcut: "P", label: "Pen", variants: ["pen", "freeform_pen", "curvature_pen"] },
    { id: "type", shortcut: "T", label: "Type", variants: ["type_horizontal", "type_vertical"] },
    { id: "path_select", shortcut: "A", label: "Path Select", variants: ["path_select"] },
    { id: "shape", shortcut: "U", label: "Shape", variants: ["shape"] },
  ],
  [
    { id: "hand", shortcut: "H", label: "Hand", variants: ["hand"] },
    { id: "rotate_view", shortcut: "R", label: "Rotate View", variants: ["rotate_view"] },
  ],
] as const;

/**
 * Flat per-section view of the slot registry (separator-delimited id lists),
 * derived from `PS_TOOL_SECTIONS` so the two can never drift.
 */
export const MASK_TOOL_GROUPS: readonly (readonly string[])[] = PS_TOOL_SECTIONS.map(
  (section) => section.flatMap((slot) => slot.variants),
);

/**
 * Slot-variant view (section → slot → variant ids), derived from
 * `PS_TOOL_SECTIONS` for consumers that only need the id nesting.
 */
export const MASK_TOOL_SLOTS: readonly (readonly (readonly string[])[])[] =
  PS_TOOL_SECTIONS.map((section) => section.map((slot) => slot.variants));

/** Flat slot list (section order preserved), for slot lookups. */
export const PS_SLOTS: readonly PsToolSlot[] = PS_TOOL_SECTIONS.flat();

/** The PS slot a tool id lives in (undefined for right-panel mask ops). */
export function psSlotOf(toolId: string): PsToolSlot | undefined {
  return PS_SLOTS.find((slot) => slot.variants.includes(toolId));
}

/**
 * Whole-mask operations (`kind: "global"`), in the order the right-panel
 * Mask Ops group lists them. Left toolbar = the tool in the user's hand;
 * these apply to the whole mask, so they live in the right rail instead
 * (PS_TOOLBAR_PARITY_PLAN § "Move Out Of The Left Toolbar").
 */
export const MASK_OPS: readonly string[] = ["invert", "fill_holes", "smooth", "grow", "shrink", "feather", "blur", "sharpen"];

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
 * pen / magnetic-lasso step.
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
