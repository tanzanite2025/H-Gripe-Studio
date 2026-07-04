// Pure canvas painters for the mask-edit stage overlay. Every function takes
// a 2D context plus plain data and draws one scene element — no React state,
// no refs. MaskEditModal assembles the scene; painting lives here.

import type { EditPath, EditPathPoint } from "../../types/production";
import type { ProxyMask } from "../maskMorphology";
import { shapeVertices, type ShapeKind } from "../maskTools";

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

/** A committed pen / lasso vector path: translucent fill + outline (bezier
 *  segments where control handles are recorded). */
export function paintPath(ctx: CanvasRenderingContext2D, p: EditPath) {
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

/** A live lasso loop: thin dashed outline, not a brush band. */
export function paintLassoLoop(ctx: CanvasRenderingContext2D, points: [number, number][], close = false) {
  ctx.strokeStyle = "rgba(86,168,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  if (close) ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
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
export function paintPenAnchors(ctx: CanvasRenderingContext2D, anchors: [number, number][]) {
  ctx.strokeStyle = "rgba(86,168,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  anchors.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  anchors.forEach(([x, y], i) => {
    ctx.fillStyle = i === 0 ? "rgba(120,230,140,0.95)" : "rgba(86,168,255,0.95)";
    ctx.fillRect(x - 3, y - 3, 6, 6);
  });
}

/** SAM 2 point prompts: numbered crosshair markers. Positive (include) points
 *  are green and draw a `+`; negative (exclude) points are red and draw a `−`,
 *  mirroring SAM 2's point_labels. */
export function paintSamPoints(ctx: CanvasRenderingContext2D, points: { x: number; y: number; label: number }[]) {
  points.forEach(({ x, y, label }, i) => {
    const colour = label === 0 ? "rgba(244,98,98,0.95)" : "rgba(120,230,140,0.95)";
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
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
export function paintColorSamples(ctx: CanvasRenderingContext2D, samples: readonly ColorSample[]) {
  samples.forEach(({ x, y, hex }, i) => {
    ctx.fillStyle = hex;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(String(i + 1), x + 9, y - 7);
  });
}

/** Ruler line: endpoint ticks plus a distance / angle readout at the midpoint. */
export function paintRuler(ctx: CanvasRenderingContext2D, { start, end }: RulerLine) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
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

/** Live marquee drag: a dashed rect / ellipse outline. */
export function paintMarquee(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  ellipse: boolean,
) {
  const [x1, y1] = start;
  const [x2, y2] = end;
  ctx.strokeStyle = "rgba(86,168,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  if (ellipse) {
    ctx.beginPath();
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  ctx.setLineDash([]);
}
