// Pure canvas painters for the mask-edit stage overlay. Every function takes
// a 2D context plus plain data and draws one scene element — no React state,
// no refs. MaskEditModal assembles the scene; painting lives here.

import { type EditPath, type EditPathPoint } from "../../contracts/maskOps";
import type { ProxyMask } from "../maskMorphology";
import { shapeVertices, type ShapeKind } from "../maskTools";
import type { TargetBounds } from "../studioTarget";
import type { SelectionOutline } from "./selection";

export interface StrokeLike {
  mode: string;
  radius: number;
  points: [number, number][];
  hardness?: number;
  flow?: number;
}

/** A committed or in-progress brush stroke band (blue add / red subtract / amber matte). */
export function paintStroke(ctx: CanvasRenderingContext2D, s: StrokeLike, kind: "paint" | "matte" = "paint") {
  ctx.strokeStyle =
    kind === "matte"
      ? "rgba(244,196,84,0.6)"
      : s.mode === "subtract"
        ? "rgba(244,98,98,0.55)"
        : "rgba(86,168,255,0.55)";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = s.radius * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Soft strokes read as a blurred, flow-capped band (advisory overlay;
  // the proxy / backend stamps are the authoritative soft rasterisation).
  const hardness = s.hardness ?? 1;
  const flow = s.flow ?? 1;
  ctx.save();
  if (hardness < 1) ctx.filter = `blur(${((1 - hardness) * s.radius) / 2}px)`;
  if (flow < 1) ctx.globalAlpha = Math.max(0.15, flow);
  if (s.points.length === 1) {
    const [x, y] = s.points[0];
    ctx.beginPath();
    ctx.arc(x, y, s.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function traceEditPath(ctx: CanvasRenderingContext2D, p: EditPath) {
  if (p.points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(p.points[0].x, p.points[0].y);
  for (let i = 1; i <= p.points.length; i++) {
    const prev = p.points[i - 1];
    const next = p.points[i % p.points.length];
    if (prev.out || next.in) {
      const c1 = prev.out ?? [prev.x, prev.y];
      const c2 = next.in ?? [next.x, next.y];
      ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], next.x, next.y);
    } else {
      ctx.lineTo(next.x, next.y);
    }
  }
  ctx.closePath();
}

function strokeMarchingAnts(ctx: CanvasRenderingContext2D, trace: () => void, phase = 0, width = 2) {
  ctx.save();
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.96)";
  ctx.setLineDash([]);
  trace();
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.92)";
  ctx.setLineDash([7, 5]);
  ctx.lineDashOffset = -phase;
  trace();
  ctx.stroke();
  ctx.restore();
}

function traceSelectionOutline(ctx: CanvasRenderingContext2D, selection: SelectionOutline) {
  ctx.beginPath();
  if (selection.polygon?.length) {
    selection.polygon.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    return;
  }
  const [x0, y0, x1, y1] = selection.region;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (selection.ellipse) {
    ctx.ellipse(left + width / 2, top + height / 2, Math.max(width / 2, 0.5), Math.max(height / 2, 0.5), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(left, top, width, height);
  }
}

/** A committed pen / lasso vector path: translucent fill + outline (bezier
 *  segments where control handles are recorded). */
export function paintPath(ctx: CanvasRenderingContext2D, p: EditPath) {
  if (p.points.length < 2) return;
  traceEditPath(ctx, p);
  ctx.fillStyle =
    p.mode === "subtract"
      ? "rgba(244,98,98,0.3)"
      : p.mode === "intersect"
        ? "rgba(190,120,255,0.3)"
        : "rgba(86,168,255,0.3)";
  ctx.strokeStyle = p.mode === "subtract" ? "rgba(244,98,98,0.9)" : p.mode === "intersect" ? "rgba(190,120,255,0.9)" : "rgba(86,168,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.fill("evenodd");
  ctx.stroke();
}

/** A closed work path in the image editor: solid outline, not a selection. */
export function paintWorkPath(ctx: CanvasRenderingContext2D, points: [number, number][]) {
  if (points.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  trace();
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(47,124,246,0.96)";
  trace();
  ctx.stroke();
  ctx.restore();
}

/** A closed work selection in the image editor: solid outline until the user
 * explicitly turns it into an active marching-ants selection. */
export function paintSelectionDraft(ctx: CanvasRenderingContext2D, selection: SelectionOutline) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  traceSelectionOutline(ctx, selection);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(47,124,246,0.96)";
  traceSelectionOutline(ctx, selection);
  ctx.stroke();
  ctx.restore();
}

export function paintTargetBounds(ctx: CanvasRenderingContext2D, bounds: TargetBounds, phase = 0) {
  if (bounds.kind === "none" || bounds.kind === "document" || bounds.kind === "selection" || bounds.kind === "path") return;
  const [x0, y0, x1, y1] = bounds.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const color =
    bounds.kind === "mask"
      ? "rgba(82,214,255,0.92)"
      : bounds.kind === "node_output"
        ? "rgba(190,120,255,0.86)"
        : "rgba(255,255,255,0.82)";
  ctx.save();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -phase * 0.5;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.strokeStyle = color;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.restore();
}

/** An active lasso selection path: PS-style high-contrast marching ants. */
export function paintPathSelection(ctx: CanvasRenderingContext2D, p: EditPath, phase = 0) {
  if (p.points.length < 2) return;
  strokeMarchingAnts(ctx, () => traceEditPath(ctx, p), phase, 2.25);
}

/** A live lasso loop: PS-style high-contrast marching ants, not a brush band. */
export function paintLassoLoop(ctx: CanvasRenderingContext2D, points: [number, number][], close = false, phase = 0) {
  if (points.length < 2) return;
  strokeMarchingAnts(
    ctx,
    () => {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (close) ctx.closePath();
    },
    phase,
    2.25,
  );
}

/** Solid blue crop edge — readable over white backgrounds. */
const CROP_EDGE = "#2f7cf6";

function dimOutside(
  ctx: CanvasRenderingContext2D,
  region: readonly [number, number, number, number],
  w: number,
  h: number,
) {
  const [x0, y0, x1, y1] = region;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, w, Math.max(0, y0));
  ctx.fillRect(0, y1, w, Math.max(0, h - y1));
  ctx.fillRect(0, y0, Math.max(0, x0), Math.max(0, y1 - y0));
  ctx.fillRect(x1, y0, Math.max(0, w - x1), Math.max(0, y1 - y0));
}

/** Confirmed image-crop step: dim everything outside the kept region. */
export function paintCropDim(
  ctx: CanvasRenderingContext2D,
  region: readonly [number, number, number, number],
  w: number,
  h: number,
) {
  dimOutside(ctx, region, w, h);
  const [x0, y0, x1, y1] = region;
  ctx.strokeStyle = CROP_EDGE;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
}

/** Pending crop-box draft: dim outside, solid blue edge, corner handles. */
export function paintCropDraft(
  ctx: CanvasRenderingContext2D,
  region: readonly [number, number, number, number],
  w: number,
  h: number,
) {
  dimOutside(ctx, region, w, h);
  const [x0, y0, x1, y1] = region;
  ctx.strokeStyle = CROP_EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) {
    ctx.fillStyle = CROP_EDGE;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x - 5, y - 5, 10, 10);
    ctx.fill();
    ctx.stroke();
  }
}

/** Perspective-crop quad draft: dashed outline plus draggable corner squares. */
export function paintQuadDraft(ctx: CanvasRenderingContext2D, quad: readonly [number, number][]) {
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  quad.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [x, y] of quad) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.rect(x - 4, y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
}

/** The live retouch band colour: green heal / violet clone / amber history
 *  brush / white dodge / near-black burn. */
export function retouchBandColor(kind: "heal" | "clone" | "history" | "dodge", dodgeBurn: "dodge" | "burn"): string {
  if (kind === "heal") return "rgba(120,220,140,0.45)";
  if (kind === "clone") return "rgba(190,140,255,0.45)";
  if (kind === "history") return "rgba(255,196,90,0.45)";
  return dodgeBurn === "burn" ? "rgba(30,30,40,0.45)" : "rgba(255,255,255,0.45)";
}

/** A live retouch band marking the painted region. */
export function paintRetouchBand(ctx: CanvasRenderingContext2D, points: [number, number][], radius: number, band: string) {
  ctx.strokeStyle = band;
  ctx.fillStyle = band;
  ctx.lineWidth = radius * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0][0], points[0][1], radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

/** Clone-stamp source marker: a crosshair at the Alt-picked source point. */
export function paintCloneSource(ctx: CanvasRenderingContext2D, [sx, sy]: [number, number]) {
  ctx.strokeStyle = "rgba(190,140,255,0.95)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx - 7, sy);
  ctx.lineTo(sx + 7, sy);
  ctx.moveTo(sx, sy - 7);
  ctx.lineTo(sx, sy + 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx, sy, 4, 0, Math.PI * 2);
  ctx.stroke();
}

/** Anchor re-editing: dashed outline of the draft path plus draggable anchor
 *  squares (the dragged anchor is highlighted). */
export function paintAnchorDraft(ctx: CanvasRenderingContext2D, anchors: EditPathPoint[], dragging: number | null) {
  ctx.strokeStyle = "rgba(120,230,140,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  anchors.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  anchors.forEach((p, i) => {
    ctx.fillStyle = dragging === i ? "rgba(255,214,90,0.95)" : "rgba(120,230,140,0.95)";
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
  });
}

/** Pending pen path: anchor squares + dashed polyline; the first anchor is
 *  highlighted (clicking it closes the path). */
export function paintPenAnchors(ctx: CanvasRenderingContext2D, anchors: [number, number][], phase = 0) {
  if (anchors.length > 1) {
    strokeMarchingAnts(
      ctx,
      () => {
        ctx.beginPath();
        anchors.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      },
      phase,
      2.25,
    );
  }
  anchors.forEach(([x, y], i) => {
    const size = i === 0 ? 10 : 8;
    ctx.fillStyle = i === 0 ? "rgba(120,230,140,0.98)" : "rgba(47,124,246,0.98)";
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x - size / 2, y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  });
}

/** SAM 2 point prompts: numbered crosshair markers. Positive (include) points
 *  are green and draw a `+`; negative (exclude) points are red and draw a `−`,
 *  mirroring SAM 2's point_labels. */
export function paintSamPoints(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number; label: number }[],
  labelsOnly = false,
) {
  points.forEach(({ x, y, label }, i) => {
    const colour = label === 0 ? "rgba(244,98,98,0.95)" : "rgba(120,230,140,0.95)";
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    if (!labelsOnly) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 9, y);
      ctx.lineTo(x + 9, y);
      if (label !== 0) {
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x, y + 9);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText(String(i + 1), x + 11, y - 6);
  });
}

/** A pinned colour-sampler readout (session-local view read, never recorded). */
export interface ColorSample {
  x: number;
  y: number;
  hex: string;
}

/** A ruler measurement drag (image px; session-local view read). */
export interface RulerLine {
  start: [number, number];
  end: [number, number];
}

/** Colour-sampler pins: numbered circle markers filled with the sampled colour. */
export function paintColorSamples(
  ctx: CanvasRenderingContext2D,
  samples: readonly ColorSample[],
  labelsOnly = false,
) {
  samples.forEach(({ x, y, hex }, i) => {
    if (!labelsOnly) {
      ctx.fillStyle = hex;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(String(i + 1), x + 9, y - 7);
  });
}

/** Ruler line: endpoint ticks plus a distance / angle readout at the midpoint. */
export function paintRuler(ctx: CanvasRenderingContext2D, { start, end }: RulerLine, labelsOnly = false) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (!labelsOnly) {
    ctx.strokeStyle = "rgba(255,214,90,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(end[0], end[1]);
    ctx.stroke();
    for (const [x, y] of [start, end]) {
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  ctx.fillStyle = "rgba(255,214,90,0.95)";
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillText(`${Math.round(dist)}px ∠${angle.toFixed(1)}°`, (start[0] + end[0]) / 2 + 8, (start[1] + end[1]) / 2 - 8);
}

/** Paint a proxy mask (scaled up to document size) as a tinted overlay.
 *  `alpha(a)` maps a 0–255 mask value to the overlay's per-pixel alpha. */
function paintProxy(
  ctx: CanvasRenderingContext2D,
  proxy: ProxyMask,
  w: number,
  h: number,
  rgb: [number, number, number],
  alpha: (a: number) => number,
) {
  const tmp = document.createElement("canvas");
  tmp.width = proxy.w;
  tmp.height = proxy.h;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  const img = tctx.createImageData(proxy.w, proxy.h);
  for (let i = 0; i < proxy.data.length; i++) {
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = alpha(proxy.data[i]);
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, w, h);
}

/** Morphology preview: the proxy result as a blue tint; soft alpha (feather)
 *  reads through the per-pixel opacity. */
export function paintPreviewOverlay(ctx: CanvasRenderingContext2D, proxy: ProxyMask, w: number, h: number) {
  paintProxy(ctx, proxy, w, h, [86, 168, 255], (a) => Math.round(a * 0.55));
}

/** Quick mask (Q): PS-style ruby overlay — tint the *unselected* area red so
 *  the selection reads as the clear region. */
export function paintQuickMask(ctx: CanvasRenderingContext2D, proxy: ProxyMask, w: number, h: number) {
  paintProxy(ctx, proxy, w, h, [224, 32, 32], (a) => Math.round((255 - a) * 0.5));
}

/** Live move-tool / gradient drag: an arrow from the grab point to the cursor
 *  (the gradient's ramp runs along it, full → none). */
export function paintDragArrow(ctx: CanvasRenderingContext2D, start: [number, number], end: [number, number]) {
  const [x1, y1] = start;
  const [x2, y2] = end;
  ctx.strokeStyle = "rgba(255,214,90,0.95)";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 10 * Math.cos(angle - 0.4), y2 - 10 * Math.sin(angle - 0.4));
  ctx.lineTo(x2 - 10 * Math.cos(angle + 0.4), y2 - 10 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

/** Live shape drag: a dashed outline of the shape the release will commit. */
export function paintShapeDraft(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  start: [number, number],
  end: [number, number],
  sides: number,
  radius: number,
) {
  const pts = shapeVertices(kind, [start[0], start[1], end[0], end[1]], sides, radius);
  if (pts.length < 3) return;
  ctx.strokeStyle = "rgba(86,168,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Live marquee drag: high-contrast marching ants — a solid white underlay
 *  stroke with black dashes on top, readable over any background. */
export function paintMarquee(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  ellipse: boolean,
  phase = 0,
) {
  strokeMarchingAnts(ctx, () => traceSelectionOutline(ctx, {
    region: [start[0], start[1], end[0], end[1]],
    ellipse,
  }), phase, 2.25);
}
