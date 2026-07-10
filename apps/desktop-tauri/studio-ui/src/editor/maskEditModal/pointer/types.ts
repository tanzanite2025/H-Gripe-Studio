// Shared contracts of the Mask-Edit pointer state machine: the mutable
// in-flight gesture record (`PointerGestures`) and the environment the tool
// modules read from / write back into the editor shell (`PointerEnv`). The
// per-tool-type handlers live in the sibling modules; pointerMachine.ts only
// dispatches.
import type React from "react";
import type { CanvasView } from "../../canvasView";
import { type EditPathPoint } from "../../../contracts/maskOps";
import { type MaskDocument } from "../../../contracts/maskDocument";
import type { EdgeMap, MagneticSnapSettings } from "../magneticSnap";
import type { MaskTool, PaintTarget, ShapeKind } from "../../maskTools";
import type { MaskEditAction } from "../actions";
import type { ColorSample, RulerLine } from "../stagePainter";

export type Pt = [number, number];
export type Box = [number, number, number, number];

/** The active rect/ellipse marquee selection (PS marching ants). */
export interface MarqueeSelection {
  region: Box;
  ellipse: boolean;
  polygon?: Pt[];
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
 * map captured at drag start). One plain mutable object — imperative by
 * design: a drag mutates at pointer-move rate and must never re-render.
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
  /** Last stable live snap point. Keeps magnetic lasso from jumping between
   * neighbouring edges when the cursor jitters. */
  magneticLock: { point: Pt; score: number } | null;
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
    magneticLock: null,
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
  magnetic: MagneticSnapSettings;
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
  setWorkSelection: React.Dispatch<React.SetStateAction<MarqueeSelection | null>>;
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
