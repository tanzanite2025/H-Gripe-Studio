// Stage scene assembly: pure functions that turn the shell's state into the
// host vector overlay scene (committed geometry stroked over rendered frames
// at view-window detail) and the canvas overlay painting pass (live gesture
// feedback plus the fallback stage when no host frame presents). The shell
// keeps only thin memo/callback wrappers around these.
import type { ViewportOverlayItem, ViewportOverlayScene } from "../../bridge/viewport";
import { activeTargetKind, isBrushOp, isPathOp, type MaskDocument, type EditPathPoint } from "../../types/production";
import { layerOpStacks } from "../maskEdit";
import type { MaskTool, PaintTarget, ShapeKind } from "../maskTools";
import type { ProxyMask } from "../maskMorphology";
import { hexToRgb } from "./ColorPicker";
import { flattenEditPath } from "./pathGeometry";
import type { PointerGestures } from "./pointer/types";
import {
  paintAnchorDraft,
  paintCloneSource,
  paintColorSamples,
  paintCropDim,
  paintCropDraft,
  paintDragArrow,
  paintLassoLoop,
  paintMarquee,
  paintPath,
  paintPenAnchors,
  paintPreviewOverlay,
  paintQuadDraft,
  paintQuickMask,
  paintRetouchBand,
  paintRuler,
  paintSamPoints,
  paintShapeDraft,
  paintStroke,
  paintWorkSelection,
  retouchBandColor,
  type ColorSample,
  type RulerLine,
} from "./stagePainter";

export interface MarqueeSelection {
  region: [number, number, number, number];
  ellipse: boolean;
  polygon?: [number, number][];
}

export interface OverlaySceneArgs {
  /** Product surface using the shared stage. Mask history overlays belong
   * to the mask workspace; image editing shows committed pixels instead. */
  workspace: "image" | "mask";
  /** Previous render's frame dims (the scene is built before the viewport
   * hook runs; a selection is only made after the frame has settled). */
  frameDims: { w: number; h: number };
  /** A morphology preview runs: the proxy tint already folds the committed
   * paths in, so the vector overlay drops them (mirrors the canvas skip). */
  previewing: boolean;
  doc: MaskDocument;
  /** Index of the path op being anchor-re-edited on the active layer. */
  editingPath: number | null;
  lastMarquee: MarqueeSelection | null;
  /** Marching-ants dash phase in surface pixels; advances over time so the
   * committed marquee's ants flow. */
  antsPhase: number;
  toolId: string;
  rulerLine: RulerLine | null;
  colorSamples: ColorSample[];
}

/** The committed geometry stroked host-side over rendered frames (WGPU
 * migration: interactive overlays on the live surface), so outlines stay one
 * screen pixel wide at any zoom instead of scaling with a document-size
 * canvas. Live drags stay on the canvas for zero-latency feedback. */
export function buildViewportOverlayScene(args: OverlaySceneArgs): ViewportOverlayScene | null {
  const { workspace, frameDims, previewing, doc, editingPath, lastMarquee, antsPhase, toolId, rulerLine, colorSamples } = args;
  if (frameDims.w <= 0 || frameDims.h <= 0) return null;
  const items: ViewportOverlayItem[] = [];
  let animatedSelection = false;
  // Committed pen / lasso paths: the same loops the canvas painter fills
  // and outlines, flattened to straight segments and normalized.
  if (workspace === "mask" && !previewing) {
    const activeTarget = activeTargetKind(doc);
    doc.layers.forEach((layer, li) => {
      if (!layer.visible) return;
      layerOpStacks(layer).forEach(({ target, ops }) => ops.forEach((op, i) => {
        if (op.disabled || (li === doc.active && target === activeTarget && i === editingPath)) return;
        if (isBrushOp(op) && op.points.length > 0) {
          // Committed brush-stroke bands, mirroring `paintStroke`: mode
          // colour at 0.55, dimmed further by a sub-1 flow.
          const [r, g, b] = op.mode === "subtract" ? [244, 98, 98] : [86, 168, 255];
          const flow = op.flow ?? 1;
          items.push({
            kind: "band",
            points: op.points.map(([x, y]) => [x / frameDims.w, y / frameDims.h] as [number, number]),
            radius: Math.min(1, op.radius / frameDims.w),
            color: [r / 255, g / 255, b / 255, 0.55 * (flow < 1 ? Math.max(0.15, flow) : 1)],
          });
          return;
        }
        if (!isPathOp(op) || op.points.length < 2) return;
        const [r, g, b] =
          op.mode === "subtract" ? [244, 98, 98] : op.mode === "intersect" ? [190, 120, 255] : [86, 168, 255];
        items.push({
          kind: "polygon",
          points: flattenEditPath(op.points).map(
            ([x, y]) => [x / frameDims.w, y / frameDims.h] as [number, number],
          ),
          stroke: [r / 255, g / 255, b / 255, 0.9],
          fill: [r / 255, g / 255, b / 255, 0.3],
        });
      }));
    });
  }
  // Matte strokes (amber) render whether or not a preview runs, like the
  // canvas painter.
  if (workspace === "mask") {
    for (const s of doc.matte_strokes) {
      if (s.points.length === 0) continue;
      items.push({
        kind: "band",
        points: s.points.map(([x, y]) => [x / frameDims.w, y / frameDims.h] as [number, number]),
        radius: Math.min(1, s.radius / frameDims.w),
        color: [244 / 255, 196 / 255, 84 / 255, 0.6],
      });
    }
  }
  if (lastMarquee && workspace === "mask") {
    if (lastMarquee.polygon) {
      // Polygon lasso selections are painted on the DOM edit canvas instead
      // of the host overlay. The canvas sits above both PNG and native WGPU
      // underlays, so closing the lasso cannot disappear while the host
      // surface catches up or lacks polygon-dash support.
    } else {
      const [x0, y0, x1, y1] = lastMarquee.region;
      items.push({
        kind: "marquee",
        region: [x0 / frameDims.w, y0 / frameDims.h, x1 / frameDims.w, y1 / frameDims.h],
        ...(lastMarquee.ellipse ? { ellipse: true } : null),
      });
    }
    animatedSelection = true;
  }
  const norm = (x: number, y: number): [number, number] => [x / frameDims.w, y / frameDims.h];
  // The committed ruler line (shown while the ruler tool is in hand):
  // endpoint ticks plus the measurement line; the readout text stays on the
  // canvas (the host strokes geometry only).
  if (toolId === "ruler" && rulerLine) {
    const amber: [number, number, number, number] = [1, 214 / 255, 90 / 255, 0.95];
    items.push({
      kind: "polyline",
      points: [norm(...rulerLine.start), norm(...rulerLine.end)],
      stroke: amber,
    });
    for (const [x, y] of [rulerLine.start, rulerLine.end]) {
      items.push({ kind: "marker", center: norm(x, y), shape: "disc", size: 3.5, stroke: amber });
    }
  }
  // Colour-sampler pins: a disc filled with the sampled colour; the
  // numbered label stays on the canvas.
  for (const { x, y, hex } of colorSamples) {
    const [r, g, b] = hexToRgb(hex) ?? [0, 0, 0];
    items.push({
      kind: "marker",
      center: norm(x, y),
      shape: "disc",
      size: 6,
      stroke: [1, 1, 1, 0.9],
      fill: [r / 255, g / 255, b / 255, 1],
    });
  }
  // SAM point prompts: `+` include / `−` exclude crosshairs with a centre
  // dot; the numbered label stays on the canvas.
  if (workspace === "mask") {
    for (const { x, y, label } of doc.points) {
      const colour: [number, number, number, number] =
        label === 0 ? [244 / 255, 98 / 255, 98 / 255, 0.95] : [120 / 255, 230 / 255, 140 / 255, 0.95];
      items.push({
        kind: "marker",
        center: norm(x, y),
        shape: label === 0 ? "minus" : "cross",
        size: 9,
        stroke: colour,
      });
      items.push({ kind: "marker", center: norm(x, y), shape: "disc", size: 3, stroke: colour, fill: colour });
    }
  }
  return items.length > 0 ? { items, ...(animatedSelection ? { phase: antsPhase } : null) } : null;
}

export interface StagePaintArgs {
  workspace: "image" | "mask";
  dims: { w: number; h: number };
  /** Transparency preview: dark backdrop so the mask reads clearly. */
  overlayOnly: boolean;
  underlay: string | null;
  presented: boolean;
  previewing: boolean;
  doc: MaskDocument;
  editingPath: number | null;
  tool: MaskTool;
  brushSize: number;
  brushHardness: number;
  brushFlow: number;
  paintTarget: PaintTarget;
  penAnchors: [number, number][];
  anchorDraft: EditPathPoint[] | null;
  preview: ProxyMask | null;
  quickMask: boolean;
  quickProxy: ProxyMask | null;
  shapeKind: ShapeKind;
  shapeSides: number;
  colorSamples: ColorSample[];
  rulerLine: RulerLine | null;
  quadDraft: [number, number][] | null;
  cropDraft: [number, number, number, number] | null;
  cropRegion: [number, number, number, number] | null;
  lastMarquee: MarqueeSelection | null;
  workSelection: MarqueeSelection | null;
  antsPhase: number;
  gestures: PointerGestures;
}

/** One canvas overlay painting pass: committed geometry for the fallback
 * stage (no host frame), plus live gesture feedback and text labels. The
 * underlay presents separately (an image layer under this canvas at the
 * rendered window's rect), so the canvas stays transparent where the image
 * shows through. */
export function paintStage(ctx: CanvasRenderingContext2D, args: StagePaintArgs): void {
  const {
    workspace,
    dims,
    overlayOnly,
    underlay,
    presented,
    previewing,
    doc,
    editingPath,
    tool,
    brushSize,
    brushHardness,
    brushFlow,
    paintTarget,
    penAnchors,
    anchorDraft,
    preview,
    quickMask,
    quickProxy,
    shapeKind,
    shapeSides,
    colorSamples,
    rulerLine,
    quadDraft,
    cropDraft,
    cropRegion,
    lastMarquee,
    workSelection,
    antsPhase,
    gestures,
  } = args;
  ctx.clearRect(0, 0, dims.w, dims.h);

  if (overlayOnly) {
    // Transparency preview: dark backdrop so the mask reads clearly.
    ctx.fillStyle = "#0c0e14";
    ctx.fillRect(0, 0, dims.w, dims.h);
  }

  // While previewing a morphology op, the proxy overlay already folds in the
  // brush strokes (transformed), so skip the raw stroke overlay to avoid a
  // confusing double-draw; matte strokes / points / marquee still render.
  // Committed brush bands and vector paths render host-side (the viewport
  // overlay scene); the canvas draws them only for the fallback stage.
  if (workspace === "mask" && !previewing && !underlay && !presented) {
    const activeTarget = activeTargetKind(doc);
    doc.layers.forEach((layer, li) => {
      if (!layer.visible) return;
      layerOpStacks(layer).forEach(({ target, ops }) => ops.forEach((op, i) => {
        if (op.disabled || (li === doc.active && target === activeTarget && i === editingPath)) return;
        if (isBrushOp(op)) paintStroke(ctx, op);
        else if (isPathOp(op)) paintPath(ctx, op);
      }));
    });
  }
  if (workspace === "mask" && !underlay && !presented) {
    doc.matte_strokes.forEach((s) => paintStroke(ctx, s, "matte"));
  }
  if (workspace === "image" && !lastMarquee && workSelection) {
    paintWorkSelection(ctx, workSelection);
  }
  const live = gestures.drawing;
  if (live) {
    if (tool.kind === "path" || tool.id === "patch" || tool.id === "content_aware_move") {
      paintLassoLoop(ctx, live.points, false, antsPhase);
    } else if (tool.kind === "heal" || tool.kind === "clone" || tool.kind === "history" || tool.kind === "dodge") {
      paintRetouchBand(ctx, live.points, brushSize, retouchBandColor(tool.kind, gestures.dodgeBurnMode));
    } else {
      const liveMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
      paintStroke(
        ctx,
        { mode: tool.mode ?? "add", radius: brushSize, points: live.points, hardness: brushHardness, flow: brushFlow },
        liveMatte ? "matte" : "paint",
      );
    }
  }

  if ((tool.kind === "clone" || tool.id === "healing_brush") && gestures.cloneSource) paintCloneSource(ctx, gestures.cloneSource);
  if (editingPath != null && anchorDraft) paintAnchorDraft(ctx, anchorDraft, gestures.draggingAnchor);
  if (penAnchors.length > 0) paintPenAnchors(ctx, penAnchors, antsPhase);
  // With a host frame, sampler pins / ruler / SAM markers stroke host-side
  // (the viewport overlay scene) — the canvas keeps only the text labels.
  // The live ruler drag stays fully on the canvas for zero-latency feedback.
  const hostFrame = Boolean(underlay || presented);
  if (colorSamples.length > 0) paintColorSamples(ctx, colorSamples, hostFrame);
  const rl = gestures.rulerDrag ?? (tool.id === "ruler" ? rulerLine : null);
  if (rl) paintRuler(ctx, rl, hostFrame && gestures.rulerDrag == null);
  if (workspace === "mask") paintSamPoints(ctx, doc.points, hostFrame);
  // With a host frame — a PNG underlay or a natively presented surface —
  // the selection tint is composited host-side (the viewport mask
  // overlay); paint it locally only for the fallback stage.
  if (!underlay && !presented) {
    if (previewing && preview) paintPreviewOverlay(ctx, preview, dims.w, dims.h);
    if (quickMask && quickProxy) paintQuickMask(ctx, quickProxy, dims.w, dims.h);
  }

  const md = gestures.moveDrag ?? gestures.gradientDrag;
  if (md) paintDragArrow(ctx, md.start, md.end);
  const sd = gestures.shapeDrag;
  if (sd) paintShapeDraft(ctx, shapeKind, sd.start, sd.end, shapeSides, brushSize);
  const mq = gestures.marquee;
  if (mq) paintMarquee(ctx, mq.start, mq.end, tool.id === "ellipse", antsPhase);
  else if (lastMarquee?.polygon) {
    paintLassoLoop(ctx, lastMarquee.polygon, true, antsPhase);
  } else if (lastMarquee && (workspace === "image" || (!underlay && !presented))) {
    // Image-editor selections must stay on the DOM canvas so every closed
    // selection shape remains visible above PNG / native WGPU underlays.
    const [x0, y0, x1, y1] = lastMarquee.region;
    paintMarquee(ctx, [x0, y0], [x1, y1], lastMarquee.ellipse, antsPhase);
  }
  const pl = gestures.patchLoop;
  if (pl) {
    const pd = gestures.patchDrag;
    const [ox, oy] = pd ? [pd.end[0] - pd.start[0], pd.end[1] - pd.start[1]] : [0, 0];
    paintLassoLoop(ctx, pd ? pl.map(([x, y]) => [x + ox, y + oy] as [number, number]) : pl, true, antsPhase);
    if (pd) paintDragArrow(ctx, pd.start, pd.end);
  }
  if (quadDraft) paintQuadDraft(ctx, quadDraft);
  if (cropDraft) paintCropDraft(ctx, cropDraft, dims.w, dims.h);
  else if (cropRegion) paintCropDim(ctx, cropRegion, dims.w, dims.h);
}
