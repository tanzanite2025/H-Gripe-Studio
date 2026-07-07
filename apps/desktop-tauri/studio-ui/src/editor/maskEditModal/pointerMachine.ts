// The Mask-Edit stage's pointer state machine, extracted from the editor
// shell. All in-flight gesture state lives in one plain mutable object
// (`PointerGestures`) — imperative by design: a drag mutates at pointer-move
// rate and must never re-render — and the three entry points below hold the
// entire down/move/up decision tree. The shell provides everything else
// (document, tool, drafts, dispatch) through `PointerEnv`, so this module has
// no React state of its own.
import type React from "react";
import { ZOOM_STEP, panBy, rotateTo, zoomAt, type CanvasView } from "../canvasView";
import { activeOps } from "../maskEdit";
import type { BrushStroke, EditPathPoint, MaskDocument } from "../../types/production";
import { pointInPolygon } from "./pathGeometry";
import { hitTestPathOp, translateAnchors } from "./pathEditTools";
import { snapLoopToEdges, type EdgeMap } from "./magneticSnap";
import { shapeVertices, type MaskTool, type PaintTarget, type ShapeKind } from "./../maskTools";
import type { MaskEditAction } from "./actions";
import type { ColorSample, RulerLine } from "./stagePainter";

type Pt = [number, number];
type Box = [number, number, number, number];

/** The active rect/ellipse marquee selection (PS marching ants). */
export interface MarqueeSelection {
  region: Box;
  ellipse: boolean;
}

/** A crop-draft region's corners in TL, TR, BR, BL order. */
export const cropCorners = (r: readonly [number, number, number, number]): Pt[] => [
  [r[0], r[1]],
  [r[2], r[1]],
  [r[2], r[3]],
  [r[0], r[3]],
];

/**
 * In-flight pointer gesture state. Most fields are one drag's lifetime
 * (down → up); `cloneSource` / `patchLoop` / `magneticEdge` persist between
 * gestures (a picked source point, a lasso awaiting its drop drag, the edge
 * map captured at drag start).
 */
export interface PointerGestures {
  /** In-progress freehand stroke (image-space points), null when not drawing. */
  drawing: { points: Pt[] } | null;
  marquee: { start: Pt; end: Pt } | null;
  /** In-progress shape drag (image-space bounding box); committed on release
   * as an ordinary vector path step built from the chosen shape's vertices. */
  shapeDrag: { start: Pt; end: Pt } | null;
  /** In-progress move-tool drag (image-space): committed as a `transform` op. */
  moveDrag: { start: Pt; end: Pt } | null;
  /** Move tool over a committed marquee: drag the selection region itself
   * (PS moves the marching ants) instead of transforming the mask. */
  marqueeMove: { last: Pt; from: Box } | null;
  /** In-progress gradient drag (M10): the start → end ramp vector; Alt at
   * pointer-down records a subtract ramp. */
  gradientDrag: { start: Pt; end: Pt; subtract: boolean } | null;
  /** Clone-stamp source point (image-space), picked by Alt+click; null until
   * picked — painting without a source is inert (PS behaviour). */
  cloneSource: Pt | null;
  /** Dodge / burn direction of the in-progress stroke (Alt at pointer-down
   * burns — darkens — instead of dodging). */
  dodgeBurnMode: "dodge" | "burn";
  /** Sponge direction of the in-progress stroke (Alt at pointer-down softens
   * toward mid-grey instead of pushing toward hard on/off). */
  spongeMode: "saturate" | "desaturate";
  /** Magnetic lasso: an edge map over the underlay's visible window, captured
   * at drag start so the drawn loop can snap to image edges on release. */
  magneticEdge: EdgeMap | null;
  /** Patch tool: the committed lasso loop awaiting its drop drag, and the
   * in-progress drop drag (the loop's translation vector). */
  patchLoop: Pt[] | null;
  patchDrag: { start: Pt; end: Pt } | null;
  /** Perspective-crop quad corner being dragged (TL / TR / BR / BL index). */
  quadCorner: number | null;
  /** Image-crop rect corner being dragged, and the ratio the lock holds
   * through the drag. */
  cropCorner: number | null;
  cropDragRatio: number | null;
  rulerDrag: RulerLine | null;
  /** Path-selection whole-path drag: the last pointer position (image px). */
  wholePathDrag: Pt | null;
  /** Index of the anchor square being dragged in anchor re-edit mode. */
  draggingAnchor: number | null;
  /** Hand tool / Space-hold pan: the last pointer position (screen px). */
  panDrag: { x: number; y: number } | null;
  /** In-progress rotate-view drag: the pointer's start angle about the canvas
   * centre plus the rotation it started from. */
  rotateDrag: { angle: number; rotate: number } | null;
}

export function createPointerGestures(): PointerGestures {
  return {
    drawing: null,
    marquee: null,
    shapeDrag: null,
    moveDrag: null,
    marqueeMove: null,
    gradientDrag: null,
    cloneSource: null,
    dodgeBurnMode: "dodge",
    spongeMode: "saturate",
    magneticEdge: null,
    patchLoop: null,
    patchDrag: null,
    quadCorner: null,
    cropCorner: null,
    cropDragRatio: null,
    rulerDrag: null,
    wholePathDrag: null,
    draggingAnchor: null,
    panDrag: null,
    rotateDrag: null,
  };
}

/**
 * Everything the machine reads from / writes back into the editor shell.
 * Values are snapshots of the shell's state at event time; callbacks land
 * results back on the document (dispatch) or the shell's drafts (setters).
 */
export interface PointerEnv {
  tool: MaskTool;
  toolId: string;
  workspace: "image" | "mask";
  spacePan: boolean;
  dims: { w: number; h: number };
  doc: MaskDocument;
  activeLayerKind: string;
  lastMarquee: MarqueeSelection | null;
  editingPath: number | null;
  anchorDraft: EditPathPoint[] | null;
  penAnchors: Pt[];
  cropDraft: Box | null;
  quadDraft: Pt[] | null;
  paintTarget: PaintTarget;
  tolerance: number;
  brushSize: number;
  brushHardness: number;
  brushFlow: number;
  brushSpacing: number;
  pathMode: "add" | "subtract" | "intersect";
  shapeKind: ShapeKind;
  shapeSides: number;
  cropLock: boolean;
  /** Pointer event → image-space pixel coordinates. */
  toImage(e: React.PointerEvent): Pt;
  /** The canvas's untransformed on-screen size (the clamp space for pan). */
  viewBase(): [number, number];
  /** The pointer's angle (degrees) about the canvas centre on screen. */
  pointerAngle(e: React.PointerEvent): number;
  /** The view's current rotation (degrees). */
  viewRotate(): number;
  canvasRect(): DOMRect | null;
  setView(update: (v: CanvasView) => CanvasView): void;
  dispatch(action: MaskEditAction): void;
  commitPath(toolName: string, pts: Pt[]): void;
  closePenPath(): void;
  setPenAnchors: React.Dispatch<React.SetStateAction<Pt[]>>;
  setAnchorDraft: React.Dispatch<React.SetStateAction<EditPathPoint[] | null>>;
  startPathEdit(index: number): void;
  setCropDraft: React.Dispatch<React.SetStateAction<Box | null>>;
  setCropAspect(v: string): void;
  confirmCropDraft(draft: Box): void;
  setQuadDraft: React.Dispatch<React.SetStateAction<Pt[] | null>>;
  setLastMarquee: React.Dispatch<React.SetStateAction<MarqueeSelection | null>>;
  setMoveDraft(v: Pt | null): void;
  setRulerLine(v: RulerLine | null): void;
  setColorSamples: React.Dispatch<React.SetStateAction<ColorSample[]>>;
  sampleUnderlay(pt: Pt, onSample?: (hex: string) => void): void;
  captureEdgeMap(): void;
  /** Surface the 选项 tab (marquee size readout / manual inputs). */
  selectOptionsTab(): void;
  nextId(prefix: string): string;
  redraw(): void;
  forceRedraw(): void;
}

export function pointerDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): void {
  const { tool, dims } = env;
  // Canvas navigation (M8): hand tool / Space-hold pans; zoom tool clicks
  // in (Alt+click out) anchored at the cursor. Neither records anything.
  if (env.spacePan || tool.id === "hand") {
    g.panDrag = { x: e.clientX, y: e.clientY };
    return;
  }
  if (tool.id === "zoom") {
    const rect = env.canvasRect();
    if (!rect) return;
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const factor = e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP;
    env.setView((v) => zoomAt(v, factor, cx, cy, ...env.viewBase()));
    return;
  }
  if (tool.id === "rotate_view") {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    g.rotateDrag = { angle: env.pointerAngle(e), rotate: env.viewRotate() };
    return;
  }
  if (env.editingPath != null && env.anchorDraft) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = env.toImage(e);
    if (tool.id === "path_select") {
      // Path selection: any drag moves the whole selected path.
      g.wholePathDrag = [x, y];
      return;
    }
    // Anchor re-editing mode: grab the nearest anchor square, if any.
    const grabRadius = Math.max(10, dims.w * 0.012);
    let best = -1;
    let bestDist = grabRadius;
    env.anchorDraft.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    g.draggingAnchor = best >= 0 ? best : null;
    return;
  }
  if (tool.status !== "ready") return;
  // Adjustment layers carry no edit stack — canvas edits that would record
  // onto the active layer are ignored; document-level matte strokes / SAM
  // points still land.
  const activeIsAdjustment = env.activeLayerKind === "adjustment";
  const toMatteTarget = tool.kind === "matte" || (tool.kind === "paint" && env.paintTarget === "matte");
  if (activeIsAdjustment && tool.kind !== "point" && !toMatteTarget) return;
  (e.target as Element).setPointerCapture?.(e.pointerId);
  const pt = env.toImage(e);
  if (tool.kind === "path_edit") {
    // Path / direct selection: click near a committed path outline to
    // re-open it through the ordinary anchor-edit flow (M2).
    const hit = hitTestPathOp(activeOps(env.doc), pt, Math.max(10, dims.w * 0.012));
    if (hit >= 0) env.startPathEdit(hit);
    return;
  }
  if (tool.kind === "path") {
    if (tool.id === "lasso" || tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
      if (tool.id === "magnetic_lasso") env.captureEdgeMap();
      g.drawing = { points: [pt] };
      env.forceRedraw();
      return;
    }
    // Anchor tools (pen / polygonal lasso / curvature pen): clicking near
    // the first anchor closes the path.
    const closeRadius = Math.max(8, dims.w * 0.01);
    const first = env.penAnchors[0];
    if (env.penAnchors.length >= 3 && first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) <= closeRadius) {
      env.closePenPath();
      return;
    }
    env.setPenAnchors((prev) => [...prev, pt]);
    return;
  }
  if (tool.id === "patch" || tool.id === "content_aware_move") {
    // Patch / content-aware move: a drag from inside the pending loop
    // drops it; anywhere else starts a fresh lasso.
    const loop = g.patchLoop;
    if (loop && pointInPolygon(pt, loop)) {
      g.patchDrag = { start: pt, end: pt };
    } else {
      g.patchLoop = null;
      g.drawing = { points: [pt] };
    }
    env.forceRedraw();
    return;
  }
  if (tool.id === "crop" && env.workspace === "image") {
    // Image crop: drag a box, adjust its corners, then click inside to
    // confirm — the crop lands on the document's edit stack (undoable via
    // history) and the stage dims everything outside the kept region.
    const draft = env.cropDraft;
    if (draft) {
      const grabRadius = Math.max(10, dims.w * 0.012);
      const idx = cropCorners(draft).findIndex(
        ([qx, qy]) => Math.hypot(qx - pt[0], qy - pt[1]) <= grabRadius,
      );
      if (idx >= 0) {
        g.cropCorner = idx;
        // Ratio lock holds the box's proportions through the corner drag;
        // a free drag drops any picked preset.
        const bw = Math.abs(draft[2] - draft[0]);
        const bh = Math.abs(draft[3] - draft[1]);
        g.cropDragRatio = env.cropLock && bh >= 1 ? bw / bh : null;
        if (!env.cropLock) env.setCropAspect("");
        return;
      }
      if (pt[0] >= draft[0] && pt[0] <= draft[2] && pt[1] >= draft[1] && pt[1] <= draft[3]) {
        env.confirmCropDraft(draft);
        return;
      }
      env.setCropDraft(null);
    }
    g.marquee = { start: pt, end: pt };
    env.forceRedraw();
    return;
  }
  if (tool.id === "perspective_crop") {
    // Perspective crop: drag corners of the pending quad, click inside it
    // to commit, or drag a fresh box.
    const quad = env.quadDraft;
    if (quad) {
      const grabRadius = Math.max(10, dims.w * 0.012);
      const idx = quad.findIndex(([qx, qy]) => Math.hypot(qx - pt[0], qy - pt[1]) <= grabRadius);
      if (idx >= 0) {
        g.quadCorner = idx;
        return;
      }
      env.setQuadDraft(null);
      if (pointInPolygon(pt, quad)) {
        env.dispatch({ type: "op", op: { type: "perspective_crop", region: quad.flat() } });
        return;
      }
    }
    g.marquee = { start: pt, end: pt };
    env.forceRedraw();
    return;
  }
  if (tool.id === "pattern_stamp") {
    // Pattern stamp paints the fixed checker — no source point needed.
    g.drawing = { points: [pt] };
    env.forceRedraw();
    return;
  }
  if (tool.kind === "clone" || tool.id === "healing_brush") {
    // Alt+click picks the source; painting without one is inert.
    if (e.altKey) {
      g.cloneSource = pt;
      env.forceRedraw();
      return;
    }
    if (!g.cloneSource) return;
    g.drawing = { points: [pt] };
    env.forceRedraw();
  } else if (tool.kind === "paint" || tool.kind === "matte" || tool.kind === "heal" || tool.kind === "history" || tool.kind === "dodge") {
    if (tool.id === "sponge") g.spongeMode = e.altKey ? "desaturate" : "saturate";
    else if (tool.kind === "dodge") g.dodgeBurnMode = e.altKey ? "burn" : "dodge";
    g.drawing = { points: [pt] };
    env.forceRedraw();
  } else if (tool.kind === "transform") {
    const r = env.lastMarquee?.region;
    if (r && pt[0] >= r[0] && pt[0] <= r[2] && pt[1] >= r[1] && pt[1] <= r[3]) {
      g.marqueeMove = { last: pt, from: r };
    } else {
      g.moveDrag = { start: pt, end: pt };
    }
    env.forceRedraw();
  } else if (tool.kind === "gradient") {
    g.gradientDrag = { start: pt, end: pt, subtract: e.altKey };
    env.forceRedraw();
  } else if (tool.kind === "marquee") {
    g.marquee = { start: pt, end: pt };
    env.forceRedraw();
  } else if (tool.kind === "shape") {
    g.shapeDrag = { start: pt, end: pt };
    env.forceRedraw();
  } else if (tool.kind === "click") {
    if (tool.id === "red_eye") {
      // Red eye: the contiguous red-dominant region around the click
      // floods into the mask on run.
      env.dispatch({ type: "op", op: { type: "red_eye", region: pt } });
      return;
    }
    // Wand-family flood fill, seeded at the click: the paint bucket adds
    // like the wand; the magic eraser records mode "subtract" and the
    // backend clears the flooded region instead.
    env.dispatch({
      type: "op",
      op: { type: "wand", amount: env.tolerance, region: pt, ...(tool.mode === "subtract" ? { mode: "subtract" } : null) },
    });
  } else if (tool.kind === "sample") {
    // Sample tools are pure view reads — nothing lands on the document.
    if (tool.id === "ruler") {
      g.rulerDrag = { start: pt, end: pt };
      env.forceRedraw();
    } else if (tool.id === "color_sampler") {
      // Pin up to four persistent readouts (PS colour sampler).
      env.sampleUnderlay(pt, (hex) =>
        env.setColorSamples((prev) => (prev.length >= 4 ? prev : [...prev, { x: pt[0], y: pt[1], hex }])),
      );
    } else {
      env.sampleUnderlay(pt);
    }
  } else if (tool.kind === "point") {
    // SAM 2 point prompt: left button includes (positive), right button
    // excludes (negative). Right-click's context menu is suppressed by the
    // stage.
    const label = e.button === 2 ? 0 : 1;
    env.dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
  }
}

export function pointerMove(env: PointerEnv, g: PointerGestures, e: React.PointerEvent): void {
  const { dims } = env;
  if (g.rotateDrag) {
    const { angle, rotate } = g.rotateDrag;
    env.setView((v) => rotateTo(v, rotate + env.pointerAngle(e) - angle));
    return;
  }
  if (g.panDrag) {
    const dx = e.clientX - g.panDrag.x;
    const dy = e.clientY - g.panDrag.y;
    g.panDrag = { x: e.clientX, y: e.clientY };
    env.setView((v) => panBy(v, dx, dy, ...env.viewBase()));
    return;
  }
  if (g.wholePathDrag) {
    const [x, y] = env.toImage(e);
    const [px, py] = g.wholePathDrag;
    g.wholePathDrag = [x, y];
    env.setAnchorDraft((prev) => (prev ? translateAnchors(prev, x - px, y - py) : prev));
    return;
  }
  if (g.draggingAnchor != null) {
    const [x, y] = env.toImage(e);
    const idx = g.draggingAnchor;
    env.setAnchorDraft((prev) => (prev ? prev.map((p, i) => (i === idx ? { ...p, x, y } : p)) : prev));
    return;
  }
  if (g.rulerDrag) {
    g.rulerDrag.end = env.toImage(e);
    env.redraw();
    return;
  }
  if (g.quadCorner != null) {
    const p = env.toImage(e);
    const idx = g.quadCorner;
    env.setQuadDraft((prev) => (prev ? prev.map((q, i) => (i === idx ? p : q)) : prev));
    return;
  }
  if (g.cropCorner != null) {
    const p = env.toImage(e);
    const idx = g.cropCorner;
    env.setCropDraft((prev) => {
      if (!prev) return prev;
      const [x0, y0, x1, y1] = prev;
      const next: [number, number, number, number] =
        idx === 0
          ? [p[0], p[1], x1, y1]
          : idx === 1
            ? [x0, p[1], p[0], y1]
            : idx === 2
              ? [x0, y0, p[0], p[1]]
              : [p[0], y0, x1, p[1]];
      const ratio = g.cropDragRatio;
      if (ratio) {
        // Locked ratio: the dragged corner's vertical edge follows the
        // width, growing away from the fixed edge.
        const h = Math.abs(next[2] - next[0]) / ratio;
        if (idx === 0 || idx === 1) next[1] = y1 - h;
        else next[3] = y0 + h;
      }
      return next;
    });
    return;
  }
  if (g.patchDrag) {
    g.patchDrag.end = env.toImage(e);
    env.redraw();
    return;
  }
  if (g.drawing) {
    g.drawing.points.push(env.toImage(e));
    env.redraw();
  } else if (g.marqueeMove) {
    const pt = env.toImage(e);
    const { last } = g.marqueeMove;
    const dx = pt[0] - last[0];
    const dy = pt[1] - last[1];
    g.marqueeMove.last = pt;
    env.setLastMarquee((prev) => {
      if (!prev) return prev;
      const [x0, y0, x1, y1] = prev.region;
      const w = x1 - x0;
      const h = y1 - y0;
      const nx = Math.max(0, Math.min(x0 + dx, dims.w - w));
      const ny = Math.max(0, Math.min(y0 + dy, dims.h - h));
      return { ...prev, region: [nx, ny, nx + w, ny + h] };
    });
  } else if (g.moveDrag) {
    g.moveDrag.end = env.toImage(e);
    if (env.workspace === "image") {
      const { start, end } = g.moveDrag;
      env.setMoveDraft([end[0] - start[0], end[1] - start[1]]);
    }
    env.redraw();
  } else if (g.gradientDrag) {
    g.gradientDrag.end = env.toImage(e);
    env.redraw();
  } else if (g.marquee) {
    g.marquee.end = env.toImage(e);
    env.redraw();
  } else if (g.shapeDrag) {
    g.shapeDrag.end = env.toImage(e);
    env.redraw();
  }
}

export function pointerUp(env: PointerEnv, g: PointerGestures): void {
  const { tool, dims } = env;
  if (g.rotateDrag) {
    g.rotateDrag = null;
    return;
  }
  if (g.panDrag) {
    g.panDrag = null;
    return;
  }
  if (g.wholePathDrag) {
    g.wholePathDrag = null;
    env.forceRedraw();
    return;
  }
  if (g.draggingAnchor != null) {
    g.draggingAnchor = null;
    env.forceRedraw();
    return;
  }
  if (g.rulerDrag) {
    const { start, end } = g.rulerDrag;
    g.rulerDrag = null;
    env.setRulerLine(Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1 ? { start, end } : null);
    env.forceRedraw();
    return;
  }
  if (g.quadCorner != null) {
    g.quadCorner = null;
    return;
  }
  if (g.cropCorner != null) {
    g.cropCorner = null;
    g.cropDragRatio = null;
    env.setCropDraft((prev) =>
      prev
        ? [
            Math.min(prev[0], prev[2]),
            Math.min(prev[1], prev[3]),
            Math.max(prev[0], prev[2]),
            Math.max(prev[1], prev[3]),
          ]
        : prev,
    );
    return;
  }
  if (g.patchDrag) {
    const { start, end } = g.patchDrag;
    g.patchDrag = null;
    const loop = g.patchLoop;
    if (loop && Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
      // Patch: covered pixel `p` refills from `p + [dx, dy]` — the drop
      // site is the clean-texture source. Content-aware move instead
      // moves the loop by `[dx, dy]` and heals the hole behind it.
      env.dispatch({ type: "op", op: { type: tool.id === "content_aware_move" ? "content_aware_move" : "patch", points: loop, dx: end[0] - start[0], dy: end[1] - start[1] } });
      g.patchLoop = null;
    }
    env.forceRedraw();
    return;
  }
  if (g.drawing) {
    const pts = g.drawing.points;
    g.drawing = null;
    if (tool.id === "lasso" || tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
      // The magnetic lasso snaps the drawn loop to nearby image edges at
      // commit time (the search window scales with the drawn size).
      const edge = tool.id === "magnetic_lasso" ? g.magneticEdge : null;
      env.commitPath(tool.id, edge ? snapLoopToEdges(edge, pts, Math.max(6, dims.w * 0.008)) : pts);
      g.magneticEdge = null;
      env.forceRedraw();
      return;
    }
    if (tool.id === "quick_select") {
      // Quick selection: every stroke point seeds a tolerance flood-fill on
      // the real image; the fills union into the mask on run.
      env.dispatch({ type: "op", op: { type: "quick_select", amount: env.tolerance, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.id === "background_eraser") {
      // Background eraser: pixels inside the brush discs matching the
      // colour under each stamp's centre are erased on run.
      env.dispatch({ type: "op", op: { type: "background_eraser", amount: env.brushSize, points: pts, tolerance: env.tolerance } });
      env.forceRedraw();
      return;
    }
    if (tool.id === "healing_brush") {
      // Healing brush: like the clone stamp but the copied patch blends
      // through a feathered edge (source fixed at the drag start).
      const src = g.cloneSource;
      if (src) {
        const [dx, dy] = [src[0] - pts[0][0], src[1] - pts[0][1]];
        env.dispatch({ type: "op", op: { type: "healing_brush", amount: env.brushSize, points: pts, dx, dy } });
      }
      env.forceRedraw();
      return;
    }
    if (tool.id === "sponge") {
      env.dispatch({ type: "op", op: { type: "sponge", amount: env.brushSize, points: pts, mode: g.spongeMode } });
      env.forceRedraw();
      return;
    }
    if (tool.id === "patch" || tool.id === "content_aware_move") {
      // The released lasso becomes the pending loop; the next drag from
      // inside it records the op.
      g.patchLoop = pts.length >= 3 ? pts : null;
      env.forceRedraw();
      return;
    }
    if (tool.id === "remove") {
      // Remove (M16): the stroke seeds the segmenter; the segmented
      // object is subtracted from the mask on run.
      env.dispatch({ type: "op", op: { type: "remove", amount: env.brushSize, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.id === "pattern_stamp") {
      // Pattern stamp (M16): covered pixels take the repeating checker
      // pattern on replay.
      env.dispatch({ type: "op", op: { type: "pattern_stamp", amount: env.brushSize, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.id === "art_history_brush") {
      // Art history brush (M16): the stroke restores the layer's initial
      // state through a deterministic jitter on replay.
      env.dispatch({ type: "op", op: { type: "art_history_brush", amount: env.brushSize, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.kind === "heal") {
      // Spot-heal (M13): the stroke records a `heal` op — the painted
      // region is rebuilt from its surroundings on replay.
      env.dispatch({ type: "op", op: { type: "heal", amount: env.brushSize, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.kind === "dodge") {
      // Dodge / burn (M13): the stroke records a `dodge_burn` op — Alt at
      // pointer-down burns (darkens), otherwise dodges (lightens).
      env.dispatch({ type: "op", op: { type: "dodge_burn", amount: env.brushSize, points: pts, mode: g.dodgeBurnMode } });
      env.forceRedraw();
      return;
    }
    if (tool.kind === "history") {
      // History brush (M13): the stroke records a `history_brush` op — the
      // painted region is restored to the layer's pre-edit state on replay.
      env.dispatch({ type: "op", op: { type: "history_brush", amount: env.brushSize, points: pts } });
      env.forceRedraw();
      return;
    }
    if (tool.kind === "clone") {
      // Clone stamp (M13): the source offset is fixed at the drag start
      // (PS aligned mode) — painted pixel `p` copies from `p + [dx, dy]`.
      const src = g.cloneSource;
      if (src) {
        const [dx, dy] = [src[0] - pts[0][0], src[1] - pts[0][1]];
        env.dispatch({ type: "op", op: { type: "clone", amount: env.brushSize, points: pts, dx, dy } });
      }
      env.forceRedraw();
      return;
    }
    // The pencil is a brush with hardness / flow pinned to 100% (a hard
    // aliased stamp); its strokes never record the soft-brush fields.
    const hardTool = tool.id === "pencil";
    const stroke: BrushStroke = {
      id: env.nextId("stroke"),
      mode: tool.mode ?? "add",
      radius: env.brushSize,
      points: pts,
      // Soft-brush fields are recorded only for soft strokes so hard
      // strokes keep the legacy shape (and byte-identical replay).
      ...(!hardTool && (env.brushHardness < 1 || env.brushFlow < 1)
        ? { hardness: env.brushHardness, flow: env.brushFlow, spacing: env.brushSpacing }
        : null),
    };
    const toMatte = tool.kind === "matte" || (tool.kind === "paint" && env.paintTarget === "matte");
    env.dispatch({ type: toMatte ? "matte_stroke" : "stroke", stroke });
  } else if (g.marqueeMove) {
    // The moved selection is already live in `lastMarquee`; nothing lands
    // on the edit stack (the selection is not a mask edit).
    g.marqueeMove = null;
  } else if (g.moveDrag) {
    const { start, end } = g.moveDrag;
    g.moveDrag = null;
    env.setMoveDraft(null);
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      env.dispatch({ type: "op", op: { type: "transform", dx, dy } });
    }
    env.forceRedraw();
  } else if (g.gradientDrag) {
    const { start, end, subtract } = g.gradientDrag;
    g.gradientDrag = null;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
      env.dispatch({
        type: "op",
        op: { type: "gradient", region: [start[0], start[1], end[0], end[1]], mode: subtract ? "subtract" : "add" },
      });
    }
    env.forceRedraw();
  } else if (g.marquee) {
    const { start, end } = g.marquee;
    g.marquee = null;
    const region = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
    if (region[2] - region[0] > 1 && region[3] - region[1] > 1) {
      if (tool.id === "crop" && env.workspace === "image") {
        // The box becomes an adjustable rect; the commit happens on the
        // click inside it. A fresh free-form box carries no preset.
        env.setCropAspect("");
        env.setCropDraft(region as [number, number, number, number]);
      } else if (tool.id === "perspective_crop") {
        // The box becomes an adjustable quad; the commit happens on the
        // click inside it.
        env.setQuadDraft([
          [region[0], region[1]],
          [region[2], region[1]],
          [region[2], region[3]],
          [region[0], region[3]],
        ]);
      } else if (tool.id === "rect" || tool.id === "ellipse") {
        // PS marquee: the drag only defines the selection — nothing lands
        // on the edit stack until a subsequent operation uses it.
        env.setLastMarquee({
          region: region as [number, number, number, number],
          ellipse: tool.id === "ellipse",
        });
        // Surface the selection's size readout / manual inputs: they live
        // on the 选项 tab, which may be behind another tab in its group.
        env.selectOptionsTab();
      } else {
        env.dispatch({ type: "op", op: { type: tool.id, region } });
      }
    } else if (tool.id === "rect" || tool.id === "ellipse") {
      // A plain click with a marquee tool drops the selection (PS deselect).
      env.setLastMarquee(null);
    }
    env.forceRedraw();
  } else if (g.shapeDrag) {
    const { start, end } = g.shapeDrag;
    g.shapeDrag = null;
    const pts = shapeVertices(env.shapeKind, [start[0], start[1], end[0], end[1]], env.shapeSides, env.brushSize);
    if (pts.length >= 3) {
      env.dispatch({
        type: "path",
        path: {
          id: env.nextId("path"),
          mode: env.pathMode,
          tool: "shape",
          closed: true,
          points: pts.map(([x, y]) => ({ x, y })),
        },
      });
    }
    env.forceRedraw();
  }
}
