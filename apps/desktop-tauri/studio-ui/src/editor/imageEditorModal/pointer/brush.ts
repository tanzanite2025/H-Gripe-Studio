// Brush-family tools: paint / matte strokes, the retouch brushes (heal,
// dodge/burn, history, sponge, clone, healing brush, pattern stamp, remove,
// art history brush, quick select, background eraser). All of them draw a
// freehand stroke and commit it on release.
import type React from "react";
import { type BrushStroke } from "../../../contracts/imageEditOps";
import type { PointerEnv, PointerGestures, Pt } from "./types";

export function brushDown(env: PointerEnv, g: PointerGestures, e: React.PointerEvent, pt: Pt): void {
  const { tool } = env;
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
    return;
  }
  if (tool.id === "sponge") g.spongeMode = e.altKey ? "desaturate" : "saturate";
  else if (tool.kind === "dodge") g.dodgeBurnMode = e.altKey ? "burn" : "dodge";
  g.drawing = { points: [pt] };
  env.forceRedraw();
}

/** Release of a brush-family drag: the stroke commits as its tool's op. */
export function commitStroke(env: PointerEnv, g: PointerGestures, pts: Pt[]): void {
  const { tool } = env;
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
}
