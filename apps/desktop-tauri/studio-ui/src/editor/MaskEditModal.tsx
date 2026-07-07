import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNodeOutputSource } from "../viewport/useNodeOutputSource";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../viewport/view";
import type { ViewportMaskOverlay, ViewportOverlayItem, ViewportOverlayScene } from "../bridge/viewport";
import {
  ANCHOR_PATH_TOOLS,
  MASK_TOOLS,
  maskTool,
  DEFAULT_TOOL_ID,
  type MaskTool,
  PS_SLOTS,
  psSlotOf,
  type PaintTarget,
  type ShapeKind,
} from "./maskTools";
import { useShortcutScope, type ShortcutHandlers } from "../shortcuts";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS } from "../shortcuts/scopes/maskEdit";
import { useT } from "../i18n";
import { PreviewLane } from "../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "./maskMorphology";
import { FIT_VIEW, WHEEL_ZOOM_STEP, rotateTo, viewWindow, zoom100, zoomAt, zoomIn, zoomOut, type CanvasView } from "./canvasView";
import { applyDoc } from "./gradeKernel";
import { compileImageAdjustments } from "./imageCompile";
import { fromMaskDocument } from "./imageDocument";
import {
  activeOps,
  canRedo,
  canUndo,
  composeTransforms,
  editCount,
  initEditState,
  layerOpStacks,
  type TransformParams,
} from "./maskEdit";
import type {
  EditPathPoint,
  LayerAdjustment,
  MaskDocument,
} from "../types/production";
import { activeTargetKind, isBrushOp, isPathOp } from "../types/production";
import { maskEditReducer, type MaskEditAction } from "./maskEditModal/actions";
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
  retouchBandColor,
} from "./maskEditModal/stagePainter";
import { catmullRomClosed, flattenEditPath } from "./maskEditModal/pathGeometry";
import { buildEdgeMap } from "./maskEditModal/magneticSnap";
import type { RulerLine } from "./maskEditModal/stagePainter";
import { PanelDock, type DockPanel } from "./maskEditModal/PanelDock";
import { useDockLayout, type DockLayoutState } from "./maskEditModal/dockLayout";
import "./maskEditModal/maskEditModal.css";
import { MaskToolbar } from "./maskEditModal/MaskToolbar";
import { MaskOpsPanel } from "./maskEditModal/MaskOpsPanel";
import { MaskStage } from "./maskEditModal/MaskStage";
import { ToolOptionsPanel } from "./maskEditModal/ToolOptionsPanel";
import { LayersPanel } from "./maskEditModal/LayersPanel";
import { HistoryPanel } from "./maskEditModal/HistoryPanel";
import { InfoPanel } from "./maskEditModal/InfoPanel";
import { AdjustmentsPanel } from "./maskEditModal/AdjustmentsPanel";
import { ChannelsPanel } from "./maskEditModal/ChannelsPanel";
import { PathsPanel } from "./maskEditModal/PathsPanel";
import { ColorPicker, hexToRgb } from "./maskEditModal/ColorPicker";
import { createPointerGestures, pointerDown, pointerMove, pointerUp, type PointerEnv } from "./maskEditModal/pointerMachine";
import { useCropTool } from "./maskEditModal/useCropTool";
import { useColorTools, type ColorToolsEnv } from "./maskEditModal/useColorTools";
import { useDialogDrafts } from "./maskEditModal/useDialogDrafts";
import { ImageSizeDialog } from "./maskEditModal/ImageSizeDialog";
import { CropPanel } from "./maskEditModal/CropPanel";
import { MarqueeSizePanel } from "./maskEditModal/MarqueeSizePanel";

// Default logical canvas size when no backing image is available (browser
// preview mocks the backend, so the connected image often has no decodable
// thumbnail). Edits are recorded in this pixel space and the backend rasterises
// them against the real image on run.
const DEFAULT_W = 960;
const DEFAULT_H = 640;

/** Idle time after the last view change before the underlay re-renders at
 * the new window's detail; the CSS transform carries the motion until then. */
const VIEW_SETTLE_MS = 120;

interface MaskEditModalProps {
  title: string;
  /** Backing image path (best-effort underlay); may be missing in preview. */
  imagePath?: string | null;
  /** Node whose output backs the underlay, for a `node_output` target. */
  nodeId?: string | null;
  initial: MaskDocument | null;
  /** Magic-wand colour tolerance from the node's param. */
  wandTolerance: number;
  onCommit: (edits: MaskDocument) => void;
  onClose: () => void;
  /** Draft sink: called on every edit so a host can keep the in-progress
   * document across editor remounts (e.g. the image editor's tab switches). */
  onDocChange?: (doc: MaskDocument) => void;
  /** Optional bar content (e.g. the unified editor's tool-group switcher). */
  headerExtra?: ReactNode;
  /** Leftmost bar slot (e.g. the image editor's save light). */
  headerLeft?: ReactNode;
  /** Bar content centred over the whole bar (e.g. the collapse arrow). A
   * function form receives `requestClose`, which plays the slide-out
   * animation before the host's `onClose`. */
  headerCenter?: ReactNode | ((requestClose: () => void) => ReactNode);
  /** A full-width row under the bar (e.g. the open-document tab strip). */
  headerTabs?: ReactNode;
  /** Editor name shown after the title (defaults to "mask editor"). */
  editorName?: string;
  /** Hide the title span (a host whose header carries document tabs). */
  hideTitle?: boolean;
  /** Product surface using this heavy pixel editor. */
  workspace?: "image" | "mask";
}

let strokeSeq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${strokeSeq++}`;

// The editor shell slides up from the bottom only on a fresh open. A
// document-tab switch remounts the shell (the host keys it per document), so
// an unmount stamps a handoff window during which the next mount skips the
// entrance animation.
let shellHandoffAt = 0;
const SHELL_HANDOFF_MS = 300;

// Ops an active marquee selection does NOT confine: whole-mask reshapes keep
// their global meaning even while a selection is up (PS transforms / crops
// the selection contents, which the mask model has no notion of).
const UNCLIPPED_OPS = new Set(["transform", "crop", "perspective_crop", "select_all"]);

// Default right-rail dock layout, mirroring PS: a 调整/属性 top group (plus
// the mask-specific tool options / mask ops / info tabs) over a growing
// 图层/通道/路径 group (plus history). Users re-dock tabs by dragging; the
// result persists.
const DOCK_STORAGE_KEY = "hgripe.studio.maskDock.v2";
const DEFAULT_DOCK_LAYOUT: DockLayoutState = {
  groups: [
    { tabs: ["adjustments", "options", "mask_ops", "info"], active: "options" },
    { tabs: ["layers", "channels", "paths", "history"], active: "layers" },
  ],
  railWidth: 320,
};
const IMAGE_DOCK_STORAGE_KEY = "hgripe.studio.imageDock.v5";
// The image workspace is its own product surface: no mask-only docks
// (paths / mask-ops / tool options are mask concepts — the mask workspace
// keeps them).
const IMAGE_DOCK_LAYOUT: DockLayoutState = {
  groups: [
    { tabs: ["adjustments"], active: "adjustments" },
    { tabs: ["layers", "channels", "history"], active: "layers" },
  ],
  railWidth: 360,
};

export function MaskEditModal({
  title,
  imagePath,
  nodeId,
  initial,
  wandTolerance,
  onCommit,
  onClose,
  onDocChange,
  headerExtra,
  headerLeft,
  headerCenter,
  headerTabs,
  editorName,
  hideTitle,
  workspace = "mask",
}: MaskEditModalProps) {
  const t = useT();
  // Slide-up entrance / slide-down exit. `entering`/`closing` gate the native
  // surface presentation off while the shell moves (the PNG transport slides
  // with the DOM; the native surface window would not).
  const [animateEnter] = useState(() => Date.now() - shellHandoffAt > SHELL_HANDOFF_MS);
  const [entering, setEntering] = useState(animateEnter);
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => setClosing(true), []);
  useEffect(() => {
    return () => {
      shellHandoffAt = Date.now();
    };
  }, []);
  useEffect(() => {
    // Safety valve: if the entrance animation never fires (e.g. reduced
    // motion), still land the shell so presentation can start.
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), 600);
    return () => window.clearTimeout(timer);
  }, [entering]);
  const [state, rawDispatch] = useReducer(maskEditReducer, initial, initEditState);
  // Mirror the in-progress document out to the host so it survives remounts
  // (e.g. the image editor's document-tab switches).
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  useEffect(() => {
    onDocChangeRef.current?.(state.current);
  }, [state]);
  // Open on the move tool (PS V) — reaching for the brush is opt-in, so a
  // stray first drag never paints the mask.
  const [toolId, setToolId] = useState<string>("move");
  // Last-used variant per multi-tool PS slot: the slot button's visible face,
  // and what the slot's shortcut letter re-selects.
  const [slotFaces, setSlotFaces] = useState<Record<string, string>>({});
  const [brushSize, setBrushSize] = useState(24);
  // Soft-brush parameters (M4): hardness / flow are 0..1 (1 = the legacy hard
  // stamp), spacing is the stamp interval as a fraction of the diameter.
  const [brushHardness, setBrushHardness] = useState(1);
  const [brushFlow, setBrushFlow] = useState(1);
  const [brushSpacing, setBrushSpacing] = useState(0.25);
  // What paint strokes are recorded onto (M4 tool/target decoupling): the
  // active mask layer, or the trimap matting band.
  const [paintTarget, setPaintTarget] = useState<PaintTarget>("layer");
  const [amount, setAmount] = useState(4);
  const [tolerance, setTolerance] = useState(wandTolerance);
  const [overlayOnly, setOverlayOnly] = useState(false);
  // Quick-mask (Q): PS-style ruby overlay of the unselected area.
  const [quickMask, setQuickMask] = useState(false);
  const [quickProxy, setQuickProxy] = useState<ProxyMask | null>(null);
  // Morphology preview proxy (grow/shrink/feather/smooth), recomputed by the
  // preview lane effect below.
  const [preview, setPreview] = useState<ProxyMask | null>(null);
  // Boolean mode the next committed pen / lasso path combines with.
  const [pathMode, setPathMode] = useState<"add" | "subtract" | "intersect">("add");
  // PS-style right rail: tabbed dock groups driven by a persisted layout
  // (drag a tab to re-dock it; drag the rail edge to resize).
  const dock = useDockLayout(
    workspace === "image" ? IMAGE_DOCK_STORAGE_KEY : DOCK_STORAGE_KEY,
    workspace === "image" ? IMAGE_DOCK_LAYOUT : DEFAULT_DOCK_LAYOUT,
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Canvas navigation (M8): zoom/pan applied as a CSS transform on the stage
  // frame — the render path and pointer→image mapping are untouched by it.
  const [view, setView] = useState<CanvasView>(FIT_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Underlay presentation goes through the viewport host (WGPU migration
  // Phase 2): the image is targeted by reference — a `node_output` target
  // when a node id is given, a registered image resource otherwise — and the
  // host renders the frame; in browser preview it stays null and we draw a
  // checkerboard so the user can still paint in the correct pixel space.
  // The requested frame is the canvas view's visible window, so underlay
  // detail follows the zoom (rendered through the viewport's cached proxy).
  // Debounced: during a wheel zoom / pan drag the stage's CSS transform (and
  // the surface placement following it) carries the motion frame-to-frame;
  // the host re-renders the window at matching detail once the view settles,
  // instead of a full render round-trip per input event.
  // The selection tint (morphology preview / quick-mask ruby) composites
  // host-side over the rendered frame, so it follows the view window's
  // detail; when no host frame presents (browser preview) the canvas
  // painters below draw the same tint locally.
  const previewing = isPreviewableOp(toolId) && preview != null;
  const viewportMaskOverlay = useMemo<ViewportMaskOverlay | null>(() => {
    const proxy = previewing && preview ? preview : quickMask && quickProxy ? quickProxy : null;
    if (!proxy) return null;
    return previewing && preview
      ? { w: proxy.w, h: proxy.h, data: proxy.data, rgb: [86, 168, 255], alpha: 0.55 }
      : { w: proxy.w, h: proxy.h, data: proxy.data, rgb: [224, 32, 32], alpha: 0.5, invert: true };
  }, [previewing, preview, quickMask, quickProxy]);
  // The active rect/ellipse marquee selection (PS-style): marching ants stay
  // visible across tools, subsequent edit steps are confined to it (`clip`),
  // and Ctrl+D / a plain marquee click deselects.
  const [lastMarquee, setLastMarquee] = useState<{
    region: [number, number, number, number];
    ellipse: boolean;
  } | null>(null);
  const lastMarqueeRef = useRef(lastMarquee);
  lastMarqueeRef.current = lastMarquee;
  // Anchor re-editing (M2): index of the path op being re-edited plus a local
  // draft of its anchors; committed as one undoable step on Done / Enter.
  const [editingPath, setEditingPath] = useState<number | null>(null);
  // Colour wells / picker / eyedropper sample / sampler pins and underlay
  // pixel sampling (see useColorTools). The env ref is re-assigned every
  // render further down, once the viewport hook has run.
  const colorEnvRef = useRef<ColorToolsEnv | null>(null);
  const colors = useColorTools(colorEnvRef);
  const {
    fgColor,
    bgColor,
    colorPicker,
    setColorPicker,
    sampledColor,
    colorSamples,
    setColorSamples,
    resetColors,
    swapColors,
    commitPickedColor,
    requestColorPick,
    sampleUnderlay,
  } = colors;
  // Ruler measurement: the last committed drag (session-local view read).
  const [rulerLine, setRulerLine] = useState<RulerLine | null>(null);
  // The committed marquee's marching ants stroke host-side over rendered
  // frames (WGPU migration: interactive overlays on the live surface), so
  // the outline stays one screen pixel wide at any zoom instead of scaling
  // with a document-size canvas. The live drag stays on the canvas for
  // zero-latency feedback; only the committed selection goes to the host.
  // `dims` is derived from the viewport hook below; the scene reads the
  // previous render's value through this ref (a selection is only made after
  // the frame — and so `dims` — has settled).
  const frameDimsRef = useRef({ w: DEFAULT_W, h: DEFAULT_H });
  const frameDims = frameDimsRef.current;
  const viewportOverlayScene = useMemo<ViewportOverlayScene | null>(() => {
    if (frameDims.w <= 0 || frameDims.h <= 0) return null;
    const items: ViewportOverlayItem[] = [];
    // Committed pen / lasso paths: the same loops the canvas painter fills
    // and outlines, flattened to straight segments and normalized. While a
    // morphology preview runs, the proxy tint already folds the paths in, so
    // the vector overlay drops them (mirrors the canvas skip).
    if (!previewing) {
      const activeTarget = activeTargetKind(state.current);
      state.current.layers.forEach((layer, li) => {
        if (!layer.visible) return;
        layerOpStacks(layer).forEach(({ target, ops }) => ops.forEach((op, i) => {
          if (op.disabled || (li === state.current.active && target === activeTarget && i === editingPath)) return;
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
    for (const s of state.current.matte_strokes) {
      if (s.points.length === 0) continue;
      items.push({
        kind: "band",
        points: s.points.map(([x, y]) => [x / frameDims.w, y / frameDims.h] as [number, number]),
        radius: Math.min(1, s.radius / frameDims.w),
        color: [244 / 255, 196 / 255, 84 / 255, 0.6],
      });
    }
    if (lastMarquee) {
      const [x0, y0, x1, y1] = lastMarquee.region;
      items.push({
        kind: "marquee",
        region: [x0 / frameDims.w, y0 / frameDims.h, x1 / frameDims.w, y1 / frameDims.h],
        ...(lastMarquee.ellipse ? { ellipse: true } : null),
      });
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
    for (const { x, y, label } of state.current.points) {
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
    return items.length > 0 ? { items } : null;
  }, [lastMarquee, frameDims.w, frameDims.h, previewing, state, editingPath, toolId, rulerLine, colorSamples]);
  const source = useNodeOutputSource(nodeId, imagePath);
  // Native surface presentation (surface swap): the underlay presents on a
  // surface window placed under the anchor's rect while the view is one the
  // surface can represent — a rotated view or the transparency preview hides
  // it and frames fall back to the PNG transport. The brush/path/marquee
  // canvas is DOM, so it keeps compositing above the hole.
  const underlayAnchorRef = useRef<HTMLDivElement | null>(null);
  // Image-workspace crop: the last confirmed crop step on any visible layer.
  // The stage dims everything outside the kept region so the crop reads as a
  // document state (undoable via history), not a one-shot action.
  const cropRegion = useMemo(() => {
    if (workspace !== "image") return null;
    let last: [number, number, number, number] | null = null;
    for (const layer of state.current.layers) {
      if (!layer.visible) continue;
      for (const op of layer.ops) {
        if (op.type === "crop" && op.region && op.region.length >= 4) {
          last = [op.region[0], op.region[1], op.region[2], op.region[3]];
        }
      }
    }
    return last;
  }, [workspace, state]);
  // Image-workspace layer transform (move tool / free transform): the render
  // target does not apply `transform` ops to the image, so the stage carries
  // the composed committed transforms — plus the in-progress move drag — as a
  // CSS transform on the presented window; the move reads live on screen.
  const [moveDraft, setMoveDraft] = useState<[number, number] | null>(null);
  const imageTransform = useMemo(() => {
    if (workspace !== "image") return null;
    let t: TransformParams | null = null;
    for (const layer of state.current.layers) {
      if (!layer.visible) continue;
      for (const op of layer.ops) {
        if (isPathOp(op) || isBrushOp(op) || op.type !== "transform" || op.disabled) continue;
        const params = { dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 };
        t = t ? composeTransforms(t, params) : params;
      }
    }
    if (moveDraft) {
      const base = t ?? { dx: 0, dy: 0, scale: 1, rotate: 0 };
      t = { ...base, dx: base.dx + moveDraft[0], dy: base.dy + moveDraft[1] };
    }
    return t && (t.dx !== 0 || t.dy !== 0 || t.scale !== 1 || t.rotate !== 0) ? t : null;
  }, [workspace, state, moveDraft]);
  const targetViewportView = useMemo(() => {
    // Image-workspace layer transform (move tool / free transform): while a
    // layer is moved/scaled, the displayed underlay must be the full layer
    // frame. Moving a cropped viewport window creates a visible hard edge
    // inside the stage, because that surface/PNG only contains the old view.
    if (imageTransform) return IDENTITY_VIEW;
    const canvas = canvasRef.current;
    // The stage rect bounds what is visible of the transformed frame; the
    // window must cover it even when the frame's base rect is smaller.
    const stage = canvas?.closest<HTMLElement>(".mask-edit-stage");
    return viewWindow(
      view,
      canvas?.offsetWidth ?? 0,
      canvas?.offsetHeight ?? 0,
      stage?.clientWidth ?? 0,
      stage?.clientHeight ?? 0,
    );
  }, [view, imageTransform]);
  const [viewportView, setViewportView] = useState(targetViewportView);
  useEffect(() => {
    if (
      targetViewportView.zoom === viewportView.zoom &&
      targetViewportView.panX === viewportView.panX &&
      targetViewportView.panY === viewportView.panY
    )
      return;
    if (imageTransform) {
      setViewportView(targetViewportView);
      return;
    }
    const timer = setTimeout(() => setViewportView(targetViewportView), VIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [targetViewportView, viewportView, imageTransform]);
  // Image-workspace adjustment preview (image-kernel K2): the adjustment
  // stack compiles to a grade document and grades the displayed frame on the
  // f32 kernel — the same maths the video grade dialog runs. Null in the
  // mask workspace (adjustments there tone-map the mask, not the image) and
  // for stacks the grade kernel cannot express yet.
  const gradePreview = useMemo(() => {
    if (workspace !== "image") return null;
    const compiled = compileImageAdjustments(fromMaskDocument(state.current));
    return compiled && compiled.layers.some((l) => l.visible && l.ops.length > 0) ? compiled : null;
  }, [workspace, state]);
  // Image workspace: the underlay frame is the background pixel layer's
  // content, so hiding the bottom pixel layer hides the frame — the stage
  // shows the transparency checkerboard instead (PS: hidden Background).
  const baseHidden = useMemo(() => {
    if (workspace !== "image") return false;
    const base = state.current.layers.find((l) => l.kind !== "adjustment");
    return base ? !base.visible : false;
  }, [workspace, state]);
  // Grading needs frame pixels, so it forces the PNG transport (a natively
  // presented surface frame has no readable data URL). Any image-layer
  // transform also uses the full-frame PNG path for now: transforming a
  // cropped view-window texture exposes hard edges inside the visible stage.
  const presentEnabled =
    !overlayOnly && !baseHidden && !view.rotate && !imageTransform && !gradePreview && !entering && !closing;
  const underlayViewportView = imageTransform ? IDENTITY_VIEW : viewportView;
  // The anchor moves under CSS transforms (view zoom/pan and the layer
  // transform) without firing the resize observer: re-measure on either.
  const placementKey = useMemo(() => ({ view, imageTransform }), [view, imageTransform]);
  const viewport = useViewportUnderlay(
    "image_edit",
    source,
    1280,
    underlayViewportView,
    viewportMaskOverlay,
    underlayAnchorRef,
    presentEnabled,
    viewportOverlayScene,
    placementKey,
    // Un-debounced view: every zoom/pan tick re-presents the surface's
    // cached frame as a GPU crop (the fast path) while `viewportView` above
    // waits for the settle re-render.
    imageTransform ? null : targetViewportView,
  );
  const underlay = viewport.underlay;
  const presented = viewport.presented;
  const frameView = viewport.frameView;
  const dims = viewport.dims ?? { w: DEFAULT_W, h: DEFAULT_H };
  frameDimsRef.current = dims;

  // The graded copy of the underlay frame: decode → f32 surface → `applyDoc`
  // → re-encode. Recomputes when the frame or the adjustment stack changes;
  // the ungraded frame keeps showing until the graded one lands.
  const [gradedUnderlay, setGradedUnderlay] = useState<string | null>(null);
  useEffect(() => {
    if (!gradePreview || !underlay) {
      setGradedUnderlay(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const data = new Float32Array(id.data.length);
      for (let i = 0; i < id.data.length; i++) data[i] = id.data[i] / 255;
      applyDoc(gradePreview, { w: c.width, h: c.height, data, space: "srgb" });
      for (let i = 0; i < id.data.length; i++) {
        id.data[i] = Math.round(Math.min(Math.max(data[i], 0), 1) * 255);
      }
      ctx.putImageData(id, 0, 0);
      if (!cancelled) setGradedUnderlay(c.toDataURL());
    };
    img.src = underlay;
    return () => {
      cancelled = true;
    };
  }, [gradePreview, underlay]);

  // All in-flight pointer gesture state (drags, picked sources, pending
  // loops) — one plain mutable object, mutated at pointer-move rate without
  // re-rendering. See pointerMachine.ts.
  const gestures = useRef(createPointerGestures()).current;
  // PS-style brush cursor ring (positioned imperatively on pointer move).
  const brushCursorEl = useRef<HTMLDivElement | null>(null);
  // PS selection semantics: an active marquee is only a selection — it never
  // lands on the edit stack itself. Instead, edit steps recorded while it is
  // active carry it as their `clip`, so replay confines their effect to the
  // selection. Whole-mask reshapes (transform / crop / select-all) stay global.
  const dispatch = useCallback((action: MaskEditAction) => {
    const lm = lastMarqueeRef.current;
    if (lm) {
      const clip = { region: lm.region, ...(lm.ellipse ? { ellipse: true } : null) };
      if (action.type === "stroke") {
        action = { ...action, stroke: { ...action.stroke, clip } };
      } else if (action.type === "path") {
        action = { ...action, path: { ...action.path, clip } };
      } else if (action.type === "op" && !UNCLIPPED_OPS.has(action.op.type)) {
        action = { ...action, op: { ...action.op, clip } };
      }
    }
    rawDispatch(action);
  }, []);
  // Floating size panel beside the selection: a local W×H draft, re-seeded
  // whenever the committed marquee changes.
  const [marqueeDraft, setMarqueeDraft] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    if (lastMarquee) {
      const [x0, y0, x1, y1] = lastMarquee.region;
      setMarqueeDraft({ w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
    }
  }, [lastMarquee]);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("polygon");
  const [shapeSides, setShapeSides] = useState(5);
  // Crop tool: the adjustable rect / perspective-quad drafts and the floating
  // panel's controls (see useCropTool).
  const crop = useCropTool(dims, dispatch);
  const { quadDraft, setQuadDraft, cropDraft, setCropDraft, setCropAspect, cropLock, confirmCropDraft } = crop;
  // Pending pen anchors (image-space) awaiting a close-path click.
  const [penAnchors, setPenAnchors] = useState<[number, number][]>([]);
  const [anchorDraft, setAnchorDraft] = useState<EditPathPoint[] | null>(null);
  const [, forceRedraw] = useState(0);

  // Preview lane for morphology ops: a live, best-effort proxy render of
  // grow/shrink/feather/smooth so a slider drag shows roughly what Apply will
  // do — off the global run lock, latest-wins so rapid drags don't pile up
  // (docs/cards/editor-resource-model.md § "Four lanes" → Preview).
  const previewLane = useRef(new PreviewLane());
  // Persistent proxy render cache (M7): per-layer surfaces are reused across
  // rebuilds and the composite recomputes dirty tiles only, so a slider drag
  // or brush commit on a large document stays cheap.
  const proxyCache = useRef(new ProxyLayerCache());
  // Space-hold pan (PS): any tool pans while Space is down.
  const [spacePan, setSpacePan] = useState(false);
  // Screen-mode cycle (PS `F`): 0 full UI → 1 panels hidden → 2 canvas only.
  const [screenMode, setScreenMode] = useState<0 | 1 | 2>(0);

  const tool = maskTool(toolId) ?? MASK_TOOLS[0];

  // The canvas's untransformed on-screen size (the clamp space for pan).
  // `offsetWidth`/`offsetHeight` are layout sizes, unaffected by the view's
  // CSS transform, so they stay correct under rotation.
  const viewBase = useCallback((): [number, number] => {
    const canvas = canvasRef.current;
    if (!canvas) return [1, 1];
    return [canvas.offsetWidth || 1, canvas.offsetHeight || 1];
  }, []);

  // Alt+wheel / Ctrl+wheel zooms about the cursor with any tool in hand (PS
  // Alt+scroll). A native non-passive listener: React's synthetic `onWheel`
  // is passive at the root, so `preventDefault` (needed to stop page scroll /
  // browser pinch-zoom) would be ignored there.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY === 0 && e.deltaX === 0) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      // Alt+wheel on some platforms reports the delta on the X axis.
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const factor = delta < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      setView((v) => zoomAt(v, factor, cx, cy, ...viewBase()));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [viewBase]);

  // The pointer's angle (degrees) about the canvas centre on screen.
  const pointerAngle = (e: React.PointerEvent): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  };

  // Space keyup ends the hold-to-pan (keydown arrives via the shortcut scope).
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") {
        setSpacePan(false);
        gestures.panDrag = null;
      }
    };
    window.addEventListener("keyup", up);
    return () => window.removeEventListener("keyup", up);
  }, []);
  const activeLayerKind = state.current.layers[state.current.active]?.kind ?? "mask";

  const penPendingRef = useRef(false);
  penPendingRef.current = penAnchors.length > 0;
  const editingPathRef = useRef<number | null>(null);
  editingPathRef.current = editingPath;
  const anchorDraftRef = useRef<EditPathPoint[] | null>(null);
  anchorDraftRef.current = anchorDraft;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Dialog drafts: the free-transform panel (Ctrl+T), fill dialog (Shift+F5)
  // and Image Size dialog (Ctrl+Alt+I) clusters (see useDialogDrafts).
  const dialogs = useDialogDrafts(dims, dispatch, stateRef);
  const { transformDraft, setTransformDraft, editingTransform, closeTransformPanel, fillDraft, setFillDraft, imageSizeDraft, setImageSizeDraft } = dialogs;

  const startPathEdit = (index: number) => {
    const op = activeOps(state.current)[index];
    if (!op || !isPathOp(op)) return;
    setPenAnchors([]);
    setEditingPath(index);
    setAnchorDraft(op.points.map((p) => ({ ...p })));
  };

  const commitPathEdit = useCallback(() => {
    if (editingPathRef.current != null && anchorDraftRef.current) {
      dispatch({ type: "path_anchors", index: editingPathRef.current, points: anchorDraftRef.current });
    }
    setEditingPath(null);
    setAnchorDraft(null);
  }, []);

  const cancelPathEdit = useCallback(() => {
    setEditingPath(null);
    setAnchorDraft(null);
  }, []);

  // PS-aligned shortcuts, registered into the mask-edit scope (src/shortcuts):
  // active only while this modal is mounted, shadowing the canvas shortcuts.
  const selectTool = (id: string) => {
    if (!ANCHOR_PATH_TOOLS.includes(id)) setPenAnchors([]);
    cancelPathEdit();
    if (id !== "patch") {
      gestures.patchLoop = null;
      gestures.patchDrag = null;
    }
    if (id !== "perspective_crop") setQuadDraft(null);
    setToolId(id);
    const slot = psSlotOf(id);
    if (slot && slot.variants.length > 1) setSlotFaces((f) => ({ ...f, [slot.id]: id }));
  };

  // A slot's PS letter selects the slot's visible face — the remembered
  // last-used variant, falling back to the first ready one (PS: the shortcut
  // picks the slot, not a fixed tool).
  const selectSlot = (slotId: string) => {
    const slot = PS_SLOTS.find((s) => s.id === slotId);
    if (!slot) return;
    const ready = slot.variants.filter((id) => maskTool(id)?.status === "ready");
    if (ready.length === 0) return;
    const remembered = slotFaces[slotId];
    selectTool(remembered && ready.includes(remembered) ? remembered : ready[0]);
  };

  // Shift+letter cycles the slot's ready variants (PS "Shift cycles tools").
  const cycleSlot = (slotId: string) => {
    const slot = PS_SLOTS.find((s) => s.id === slotId);
    if (!slot) return;
    const ready = slot.variants.filter((id) => maskTool(id)?.status === "ready");
    if (ready.length === 0) return;
    const at = ready.indexOf(toolId);
    if (at === -1) {
      selectSlot(slotId);
      return;
    }
    selectTool(ready[(at + 1) % ready.length]);
  };

  const openFreeTransform = () => {
    selectTool("move");
    dialogs.openFreeTransform();
  };

  // The colour tools read the shell through this env at call time (see
  // useColorTools); re-assigned every render so it always sees current values.
  colorEnvRef.current = {
    toolId,
    toolKind: tool.kind,
    selectTool,
    setToolId,
    setPathMode,
    setPaintTarget,
    underlay,
    presented,
    viewportHost: viewport.host,
    frameView,
    dims,
  };

  const shortcutHandlers: ShortcutHandlers = {
    tool_brush: () => selectSlot("brush"),
    tool_eraser: () => selectSlot("eraser"),
    tool_wand: () => selectSlot("selection"),
    tool_pen: () => selectSlot("pen"),
    tool_lasso: () => selectSlot("lasso"),
    tool_rect: () => selectSlot("marquee"),
    tool_ellipse: () => cycleSlot("marquee"),
    tool_gradient: () => selectSlot("fill"),
    tool_move: () => selectSlot("move"),
    tool_crop: () => selectSlot("crop"),
    free_transform: () => openFreeTransform(),
    // PS `A`: the path-selection slot (path / direct selection tools).
    tool_path_select: () => selectSlot("path_select"),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    redo_alt: () => dispatch({ type: "redo" }),
    step_backward: () => dispatch({ type: "undo" }),
    clear: () => {
      // PS Ctrl+D: with an active selection, deselect; otherwise clear edits.
      if (lastMarqueeRef.current) setLastMarquee(null);
      else dispatch({ type: "clear" });
    },
    select_all: () => dispatch({ type: "op", op: { type: "select_all" } }),
    delete_selection: () => dispatch({ type: "op", op: { type: "delete" } }),
    reselect: () => dispatch({ type: "reselect" }),
    duplicate: () => dispatch({ type: "layer_duplicate" }),
    invert: () => dispatch({ type: "op", op: { type: "invert" } }),
    brush_smaller: () => setBrushSize((s) => Math.max(1, s - 4)),
    brush_larger: () => setBrushSize((s) => Math.min(96, s + 4)),
    brush_softer: () => setBrushHardness((h) => Math.max(0, Math.round((h - 0.25) * 100) / 100)),
    brush_harder: () => setBrushHardness((h) => Math.min(1, Math.round((h + 0.25) * 100) / 100)),
    default_colors: () => resetColors(),
    quick_mask: () => setQuickMask((v) => !v),
    tool_healing: () => selectSlot("repair"),
    tool_clone: () => selectSlot("stamp"),
    tool_history_brush: () => selectSlot("history"),
    tool_dodge_burn: () => selectSlot("dodge"),
    tool_eyedropper: () => selectSlot("sample"),
    tool_shape: () => selectSlot("shape"),
    tool_hand: () => selectSlot("hand"),
    tool_rotate_view: () => selectSlot("rotate_view"),
    tool_zoom: () => selectSlot("zoom"),
    screen_mode: () => setScreenMode((m) => ((m + 1) % 3) as 0 | 1 | 2),
    pan_space: () => setSpacePan(true),
    zoom_in: () => setView((v) => zoomIn(v, ...viewBase())),
    zoom_out: () => setView((v) => zoomOut(v, ...viewBase())),
    zoom_fit: () => setView(FIT_VIEW),
    zoom_100: () => setView((v) => zoom100(v, dims.w, ...viewBase())),
    adjust_levels: () => dispatch({ type: "layer_add_adjustment", adjType: "levels" }),
    adjust_curve: () => dispatch({ type: "layer_add_adjustment", adjType: "curve" }),
    fill_dialog: () => dialogs.openFillDialog(),
    image_size: () => dialogs.openImageSize(),
    feather_dialog: () => {
      // The feather "dialog" is the existing preview lane: pick the radius
      // with the amount slider, then Apply commits a revisable `feather` op.
      selectTool("feather");
    },
    swap_mode: () => swapColors(),
    close_path: () => {
      if (editingPathRef.current != null) {
        commitPathEdit();
        return;
      }
      if (!penPendingRef.current || penAnchors.length < 3) return false;
      closePenPath();
    },
    cancel: () => {
      // Anchor re-editing, an open dialog draft, or a pending pen path
      // swallows the first Escape.
      if (editingPathRef.current != null) cancelPathEdit();
      else if (dialogs.cancelDialog()) return;
      else if (penPendingRef.current) setPenAnchors([]);
      else if (toolId === "rotate_view" && viewRef.current.rotate) setView((v) => rotateTo(v, 0));
      // The image editor closes only via the header's collapse arrow;
      // Escape never dismisses it (the mask editor keeps PS behaviour).
      else if (workspace !== "image") requestClose();
    },
    toggle_overlay: () => setOverlayOnly((v) => !v),
  };
  useShortcutScope(MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS, shortcutHandlers);

  // Map a pointer event to image-pixel coordinates: offset from the rendered
  // centre (the transform's fixed point), un-rotated and un-scaled back into
  // the canvas's untransformed layout space, then scaled to image pixels.
  const toImage = useCallback(
    (e: React.PointerEvent): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const rad = (-(view.rotate ?? 0) * Math.PI) / 180;
      const ux = (dx * Math.cos(rad) - dy * Math.sin(rad)) / view.zoom;
      const uy = (dx * Math.sin(rad) + dy * Math.cos(rad)) / view.zoom;
      const baseW = canvas.offsetWidth || 1;
      const baseH = canvas.offsetHeight || 1;
      const x = ((ux + baseW / 2) / baseW) * dims.w;
      const y = ((uy + baseH / 2) / baseH) * dims.h;
      return [Math.round(x), Math.round(y)];
    },
    [dims.w, dims.h],
  );

  const viewportHost = viewport.host;
  // Magnetic lasso: capture the underlay's visible window as an edge map at
  // drag start (async — the frame decodes first). The map lands in
  // `magneticEdge` for the commit-time snap; with no underlay (browser
  // preview) it stays null and the lasso commits unsnapped.
  const captureEdgeMap = useCallback(() => {
    gestures.magneticEdge = null;
    const winW = Math.max(1, Math.round(dims.w / frameView.zoom));
    const winH = Math.max(1, Math.round(dims.h / frameView.zoom));
    const offX = Math.round(frameView.panX * dims.w);
    const offY = Math.round(frameView.panY * dims.h);
    if (!underlay) {
      if (!presented || !viewportHost || !viewportHost.isOpen) return;
      viewportHost
        .readPixels()
        .then((px) => {
          // The readback is at the frame's own resolution; only a readback
          // matching the window maps 1:1 onto image-space coordinates.
          if (px.width !== winW || px.height !== winH) return;
          gestures.magneticEdge = buildEdgeMap(px.pixels, px.width, px.height, offX, offY);
        })
        .catch(() => {
          /* leave unsnapped */
        });
      return;
    }
    const img = new Image();
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = winW;
      off.height = winH;
      const ctx = off.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, winW, winH);
      const { data } = ctx.getImageData(0, 0, winW, winH);
      gestures.magneticEdge = buildEdgeMap(data, winW, winH, offX, offY);
    };
    img.src = underlay;
  }, [underlay, presented, viewportHost, frameView, dims.w, dims.h]);

  // Redraw the overlay: committed brush strokes and the in-progress
  // stroke/marquee. The underlay presents separately (an image layer under
  // this canvas at the rendered window's rect), so the canvas stays
  // transparent where the image shows through.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
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
    if (!previewing && !underlay && !presented) {
      const activeTarget = activeTargetKind(state.current);
      state.current.layers.forEach((layer, li) => {
        if (!layer.visible) return;
        layerOpStacks(layer).forEach(({ target, ops }) => ops.forEach((op, i) => {
          if (op.disabled || (li === state.current.active && target === activeTarget && i === editingPath)) return;
          if (isBrushOp(op)) paintStroke(ctx, op);
          else if (isPathOp(op)) paintPath(ctx, op);
        }));
      });
    }
    if (!underlay && !presented) {
      state.current.matte_strokes.forEach((s) => paintStroke(ctx, s, "matte"));
    }
    const live = gestures.drawing;
    if (live) {
      if (tool.kind === "path" || tool.id === "patch" || tool.id === "content_aware_move") {
        paintLassoLoop(ctx, live.points);
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
    if (penAnchors.length > 0) paintPenAnchors(ctx, penAnchors);
    // With a host frame, sampler pins / ruler / SAM markers stroke host-side
    // (the viewport overlay scene) — the canvas keeps only the text labels.
    // The live ruler drag stays fully on the canvas for zero-latency feedback.
    const hostFrame = Boolean(underlay || presented);
    if (colorSamples.length > 0) paintColorSamples(ctx, colorSamples, hostFrame);
    const rl = gestures.rulerDrag ?? (tool.id === "ruler" ? rulerLine : null);
    if (rl) paintRuler(ctx, rl, hostFrame && gestures.rulerDrag == null);
    paintSamPoints(ctx, state.current.points, hostFrame);
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
    if (mq) paintMarquee(ctx, mq.start, mq.end, tool.id === "ellipse");
    else if (lastMarquee && !underlay && !presented) {
      // The committed ants stroke host-side over the presented frame; the
      // canvas only draws them when no host frame presents (browser preview).
      const [x0, y0, x1, y1] = lastMarquee.region;
      paintMarquee(ctx, [x0, y0], [x1, y1], lastMarquee.ellipse);
    }
    const pl = gestures.patchLoop;
    if (pl) {
      const pd = gestures.patchDrag;
      const [ox, oy] = pd ? [pd.end[0] - pd.start[0], pd.end[1] - pd.start[1]] : [0, 0];
      paintLassoLoop(ctx, pd ? pl.map(([x, y]) => [x + ox, y + oy] as [number, number]) : pl, true);
      if (pd) paintDragArrow(ctx, pd.start, pd.end);
    }
    if (quadDraft) paintQuadDraft(ctx, quadDraft);
    if (cropDraft) paintCropDraft(ctx, cropDraft, dims.w, dims.h);
    else if (cropRegion) paintCropDim(ctx, cropRegion, dims.w, dims.h);
  }, [dims.w, dims.h, cropRegion, overlayOnly, underlay, presented, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy, shapeKind, shapeSides, colorSamples, rulerLine, quadDraft, cropDraft, lastMarquee]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Recompute the morphology preview whenever the active op, its amount, or the
  // underlying edits change. The compute is cheap (a downscaled proxy) but is
  // routed through PreviewLane so an in-flight job is superseded by the next
  // slider tick rather than blocking it.
  useEffect(() => {
    if (!isPreviewableOp(toolId)) {
      setPreview(null);
      previewLane.current.cancel();
      return;
    }
    let disposed = false;
    void previewLane.current
      .run<ProxyMask | null>(async (signal) => {
        const { mask, scale } = buildProxyMask(state.current, dims, { cache: proxyCache.current });
        if (signal.cancelled) return null;
        return applyOp(mask, toolId, Math.max(0, Math.round(amount * scale)));
      })
      .then((outcome) => {
        if (!disposed && outcome.status === "applied" && outcome.value) setPreview(outcome.value);
      });
    return () => {
      disposed = true;
    };
  }, [toolId, amount, state.current, dims]);

  // Rebuild the quick-mask proxy whenever the overlay is on and the document
  // changes (cheap: a downscaled rasterisation, and only on committed edits).
  useEffect(() => {
    if (!quickMask) {
      setQuickProxy(null);
      return;
    }
    setQuickProxy(buildProxyMask(state.current, dims, { cache: proxyCache.current }).mask);
  }, [quickMask, state.current, dims]);

  // Commit a closed path (straight anchors; no handles from the UI). The
  // tool name is recorded for provenance — the rasteriser only reads
  // mode / closed / points, so every path tool replays identically.
  const commitPath = (toolName: string, pts: [number, number][]) => {
    if (pts.length < 3) return;
    dispatch({
      type: "path",
      path: {
        id: nextId("path"),
        mode: pathMode,
        tool: toolName,
        closed: true,
        points: pts.map(([x, y]) => ({ x, y })),
      },
    });
  };

  const closePenPath = () => {
    // The curvature pen smooths at commit time: a closed Catmull-Rom curve
    // through the anchors, sampled into an ordinary dense path polygon.
    if (toolId === "curvature_pen") commitPath(toolId, catmullRomClosed(penAnchors));
    else commitPath(toolId, penAnchors);
    setPenAnchors([]);
  };

  // Pointer gestures: the shell only captures the pointer, serves one-shot
  // requests (the armed colour pick) and keeps the brush ring on the cursor;
  // the whole down/move/up decision tree lives in pointerMachine.ts.
  const pointerEnv = (): PointerEnv => ({
    tool,
    toolId,
    workspace,
    spacePan,
    dims,
    doc: state.current,
    activeLayerKind,
    lastMarquee,
    editingPath,
    anchorDraft,
    penAnchors,
    cropDraft,
    quadDraft,
    paintTarget,
    tolerance,
    brushSize,
    brushHardness,
    brushFlow,
    brushSpacing,
    pathMode,
    shapeKind,
    shapeSides,
    cropLock,
    toImage,
    viewBase,
    pointerAngle,
    viewRotate: () => viewRef.current.rotate ?? 0,
    canvasRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    setView,
    dispatch,
    commitPath,
    closePenPath,
    setPenAnchors,
    setAnchorDraft,
    startPathEdit,
    setCropDraft,
    setCropAspect,
    confirmCropDraft,
    setQuadDraft,
    setLastMarquee,
    setMoveDraft,
    setRulerLine,
    setColorSamples,
    sampleUnderlay,
    captureEdgeMap,
    selectOptionsTab: () => dock.onSelect("options"),
    nextId,
    redraw,
    forceRedraw: () => forceRedraw((n) => n + 1),
  });

  const onPointerDown = (e: React.PointerEvent) => {
    // Capture the pointer for the whole gesture: events keep flowing when it
    // leaves the canvas (a fast move drag would otherwise end at the edge),
    // and no other element can start a native drag mid-gesture (the no-drop
    // cursor that swallowed the move).
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    // An armed replace-color eyedropper consumes the next canvas click:
    // sample the underlay into the requesting swatch, nothing else fires.
    if (colors.consumeColorPick(toImage(e))) return;
    pointerDown(pointerEnv(), gestures, e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // PS-style brush cursor: follow the pointer (image-space %, so the ring
    // tracks the view transform). Imperative style writes — no re-render.
    const cursorEl = brushCursorEl.current;
    if (cursorEl) {
      const [x, y] = toImage(e);
      cursorEl.style.left = `${(x / dims.w) * 100}%`;
      cursorEl.style.top = `${(y / dims.h) * 100}%`;
      cursorEl.style.display = spacePan ? "none" : "";
    }
    pointerMove(pointerEnv(), gestures, e);
  };

  const onPointerUp = () => {
    // Also reached from the canvas's pointer-leave: hide the brush ring until
    // the pointer is back over the canvas.
    if (brushCursorEl.current) brushCursorEl.current.style.display = "none";
    pointerUp(pointerEnv(), gestures);
  };

  // Clicking a tool: `global` tools are immediate actions (no canvas mode);
  // paint/click/marquee/path tools become the active mode; `planned` tools are inert.
  const onToolClick = (t: MaskTool) => {
    if (t.status !== "ready") return;
    if (!ANCHOR_PATH_TOOLS.includes(t.id)) setPenAnchors([]);
    cancelPathEdit();
    if (t.id !== "patch" && t.id !== "content_aware_move") {
      gestures.patchLoop = null;
      gestures.patchDrag = null;
    }
    if (t.id !== "perspective_crop") setQuadDraft(null);
    if (t.id !== "crop") setCropDraft(null);
    // Picking a marquee tool surfaces its 选项 tab (size readout + manual
    // width/height inputs) so the selection's numbers are in view.
    if (t.id === "rect" || t.id === "ellipse") dock.onSelect("options");
    if (t.kind === "global") {
      // Amount-taking morphology ops (grow/shrink/feather/smooth) enter a live
      // preview mode — the user tunes the amount and commits via Apply. The
      // amount-less ops (invert/fill_holes) still commit immediately.
      if (isPreviewableOp(t.id)) {
        setToolId(t.id);
        return;
      }
      dispatch({ type: "op", op: { type: t.id } });
      return;
    }
    setToolId(t.id);
  };

  // Commit the previewed morphology op as intent (the backend rasterises it on
  // run) and drop back to the brush; the transient proxy preview is discarded.
  const applyPreviewOp = () => {
    dispatch({ type: "op", op: { type: toolId, amount } });
    setToolId(DEFAULT_TOOL_ID);
  };

  const count = editCount(state.current);
  const points = state.current.points;
  const matteStrokes = state.current.matte_strokes;
  const layers = state.current.layers;
  const ops = activeOps(state.current);
  const activeAdjustment =
    activeLayerKind === "adjustment" ? layers[state.current.active]?.adjustment ?? null : null;

  // Patch one field of the active adjustment layer (each change is one undo step).
  const patchAdjustment = (patch: Partial<LayerAdjustment>) => {
    if (!activeAdjustment) return;
    dispatch({
      type: "layer_adjustment",
      index: state.current.active,
      adjustment: { ...activeAdjustment, ...patch },
    });
  };

  const showAmount = useMemo(
    () => tool.kind === "global" || ["grow", "shrink", "feather", "smooth"].includes(toolId),
    [tool.kind, toolId],
  );

  // Brush-sized tools show a ring of the tip's true diameter at the cursor
  // (PS brush cursor); [ / ] resize it live. Same predicate as the size
  // slider in the tool-options panel.
  const usesBrushCursor =
    ["paint", "matte", "heal", "clone", "history", "dodge"].includes(tool.kind) &&
    !["quick_select", "patch", "content_aware_move"].includes(tool.id);

  // Manual marquee size (right rail): build / resize the selection numerically.
  // Anchored at the last marquee's top-left (or the image origin), clamped to
  // the canvas, and recorded as the same rect / ellipse op a drag would make.
  const applyMarqueeSize = (w: number, h: number) => {
    const ellipse = lastMarquee ? lastMarquee.ellipse : toolId === "ellipse";
    const cw = Math.max(2, Math.min(Math.round(w), dims.w));
    const ch = Math.max(2, Math.min(Math.round(h), dims.h));
    const x0 = Math.min(lastMarquee?.region[0] ?? 0, dims.w - cw);
    const y0 = Math.min(lastMarquee?.region[1] ?? 0, dims.h - ch);
    const region: [number, number, number, number] = [x0, y0, x0 + cw, y0 + ch];
    setLastMarquee({ region, ellipse });
    forceRedraw((n) => n + 1);
  };

  return (
    <div className={`media-viewer-backdrop${closing ? " mask-edit-backdrop-leaving" : ""}`} onClick={requestClose}>
      <div
        className={`media-viewer mask-edit${screenMode ? ` mask-screen-${screenMode}` : ""}${animateEnter ? " mask-edit-entering" : ""}${closing ? " mask-edit-leaving" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.animationName === "mask-edit-slide-out") onClose();
          else if (e.animationName === "mask-edit-slide-in") setEntering(false);
        }}
      >
        <div className="media-viewer-bar">
          {headerLeft}
          {hideTitle ? null : (
            <span className="media-viewer-name" title={title}>
              {title} <span className="muted">· {editorName ?? t("mask.editor")}</span>
            </span>
          )}
          {headerExtra}
          {headerCenter ? (
            <div className="media-viewer-bar-center">
              {typeof headerCenter === "function" ? headerCenter(requestClose) : headerCenter}
            </div>
          ) : null}
          <div className="media-viewer-actions">
            <button disabled={!canUndo(state)} onClick={() => dispatch({ type: "undo" })} title={t("mask.undoTitle")}>
              ↶ {t("mask.undo")}
            </button>
            <button disabled={!canRedo(state)} onClick={() => dispatch({ type: "redo" })} title={t("mask.redoTitle")}>
              ↷ {t("mask.redo")}
            </button>
            {workspace === "mask" ? (
              <>
                <button disabled={count === 0} onClick={() => dispatch({ type: "clear" })} title={t("mask.clearTitle")}>
                  {t("mask.clear")}
                </button>
                <button className={overlayOnly ? "active" : ""} onClick={() => setOverlayOnly((v) => !v)} title={t("mask.togglePreviewTitle")}>
                  {overlayOnly ? t("mask.showImage") : t("mask.maskOnly")}
                </button>
                <button className={quickMask ? "active" : ""} onClick={() => setQuickMask((v) => !v)} title={t("mask.quickMaskTitle")}>
                  {t("mask.quickMask")}
                </button>
                <button className="primary" onClick={() => { onCommit(state.current); requestClose(); }} title={t("mask.applyTitle")}>
                  {t("mask.apply")}
                </button>
                <button onClick={requestClose} title={t("mask.closeTitle")}>
                  ✕
                </button>
              </>
            ) : null}
          </div>
        </div>
        {headerTabs ? <div className="media-viewer-tabs-row">{headerTabs}</div> : null}

        <div className="mask-edit-body" style={{ "--mask-rail-w": `${dock.layout.railWidth}px` } as CSSProperties}>
          <MaskToolbar
            toolId={toolId}
            onToolClick={onToolClick}
            faces={slotFaces}
            onPickFace={(slotId, id) => setSlotFaces((f) => ({ ...f, [slotId]: id }))}
            paintMode={tool.mode === "subtract" || (tool.kind === "path" && pathMode === "subtract") ? "subtract" : "add"}
            fgColor={fgColor}
            bgColor={bgColor}
            onPickColor={setColorPicker}
            onSwapColors={swapColors}
            onResetColors={resetColors}
          />

          <MaskStage
            canvasRef={canvasRef}
            dims={dims}
            view={view}
            underlay={baseHidden ? null : (gradedUnderlay ?? underlay)}
            presented={presented}
            baseHidden={baseHidden}
            fallbackDims={viewport.dims == null}
            underlayRef={underlayAnchorRef}
            frameView={frameView}
            imageTransform={imageTransform}
            backend={viewport.backend}
            overlayOnly={overlayOnly}
            spacePan={spacePan}
            toolId={tool.id}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            brushCursor={usesBrushCursor && !spacePan ? { diameter: brushSize * 2 } : null}
            brushCursorRef={brushCursorEl}
          />

          {/* Floating selection-size panel (see MarqueeSizePanel). */}
          {lastMarquee && !gestures.marquee && tool.kind === "marquee" && canvasRef.current ? (
            <MarqueeSizePanel
              region={lastMarquee.region}
              draft={marqueeDraft}
              setDraft={setMarqueeDraft}
              applySize={applyMarqueeSize}
              dims={dims}
              canvasEl={canvasRef.current}
            />
          ) : null}

          {/* Floating crop panel: below the pending crop box (see CropPanel). */}
          {cropDraft && tool.id === "crop" && workspace === "image" && canvasRef.current ? (
            <CropPanel crop={crop} cropDraft={cropDraft} dims={dims} canvasEl={canvasRef.current} />
          ) : null}

          <div
            className="mask-rail-resize"
            role="separator"
            aria-orientation="vertical"
            title={t("mask.railResize")}
            onPointerDown={dock.startRailResize}
          />

          <div className="mask-edit-controls">
            {(() => {
              const panelDefs: Record<string, DockPanel> = {
                options: {
                  id: "options",
                  label: t("mask.panelOptions"),
                  content: (
            <ToolOptionsPanel
              tool={tool}
              toolId={toolId}
              dispatch={dispatch}
              brushSize={brushSize}
              setBrushSize={setBrushSize}
              brushHardness={brushHardness}
              setBrushHardness={setBrushHardness}
              brushFlow={brushFlow}
              setBrushFlow={setBrushFlow}
              brushSpacing={brushSpacing}
              sampledColor={sampledColor}
              colorSamples={colorSamples}
              clearColorSamples={() => setColorSamples([])}
              rulerLine={rulerLine}
              clearRuler={() => setRulerLine(null)}
              shapeKind={shapeKind}
              setShapeKind={setShapeKind}
              shapeSides={shapeSides}
              setShapeSides={setShapeSides}
              setBrushSpacing={setBrushSpacing}
              paintTarget={paintTarget}
              setPaintTarget={setPaintTarget}
              showAmount={showAmount}
              amount={amount}
              setAmount={setAmount}
              applyPreviewOp={applyPreviewOp}
              cancelPreview={() => setToolId(DEFAULT_TOOL_ID)}
              pathMode={pathMode}
              setPathMode={setPathMode}
              penAnchors={penAnchors}
              closePenPath={closePenPath}
              cancelPenPath={() => setPenAnchors([])}
              tolerance={tolerance}
              setTolerance={setTolerance}
              fillDraft={fillDraft}
              setFillDraft={setFillDraft}
              transformDraft={transformDraft}
              setTransformDraft={setTransformDraft}
              editingTransform={editingTransform}
              closeTransformPanel={closeTransformPanel}
              editingPath={editingPath}
              commitPathEdit={commitPathEdit}
              cancelPathEdit={cancelPathEdit}
            />
                  ),
                },
                adjustments: {
                  id: "adjustments",
                  label: t("mask.panelAdjustments"),
                  content: (
                    <AdjustmentsPanel dispatch={dispatch} adjustment={activeAdjustment} patchAdjustment={patchAdjustment} workspace={workspace} requestColorPick={requestColorPick} />
                  ),
                },
                channels: {
                  id: "channels",
                  label: t("mask.panelChannels"),
                  content: (
                    <ChannelsPanel
                      layers={layers}
                      active={state.current.active}
                      dims={dims}
                      quickMask={quickMask}
                      setQuickMask={setQuickMask}
                      workspace={workspace}
                      imagePath={imagePath}
                    />
                  ),
                },
                paths: {
                  id: "paths",
                  label: t("mask.panelPaths"),
                  content: (
                    <PathsPanel
                      ops={ops}
                      editingPath={editingPath}
                      startPathEdit={startPathEdit}
                      cancelPathEdit={cancelPathEdit}
                    />
                  ),
                },
                mask_ops: {
                  id: "mask_ops",
                  label: t("mask.panelMaskOps"),
                  content: <MaskOpsPanel toolId={toolId} onToolClick={onToolClick} />,
                },
                info: {
                  id: "info",
                  label: t("mask.panelInfo"),
                  content: <InfoPanel matteStrokes={matteStrokes} points={points} count={count} />,
                },
                layers: {
                  id: "layers",
                  label: t("mask.layers", { count: layers.length }),
                  content: (
              <LayersPanel
                layers={layers}
                layerGroups={state.current.layerGroups}
                active={state.current.active}
                activeTarget={activeTargetKind(state.current)}
              dims={dims}
              imagePath={imagePath}
              workspace={workspace}
              dispatch={dispatch}
              onBeforeLayerChange={() => {
                if (editingPath != null) cancelPathEdit();
              }}
            />
                  ),
                },
                history: {
                  id: "history",
                  label: t("mask.history", { count: ops.length }),
                  content: (
            <HistoryPanel
              ops={ops}
              dispatch={dispatch}
              editingPath={editingPath}
              startPathEdit={startPathEdit}
              cancelPathEdit={cancelPathEdit}
              editTransformStep={dialogs.editTransformStep}
            />
                  ),
                },
              };
              return dock.layout.groups.map((group, gi) => (
                <PanelDock
                  key={gi}
                  grow={gi === dock.layout.groups.length - 1}
                  active={group.active}
                  onSelect={dock.onSelect}
                  onTabDrop={(id, index) => dock.onTabDrop(id, gi, index)}
                  panels={group.tabs.flatMap((id) => panelDefs[id] ?? [])}
                />
              ));
            })()}
          </div>
        </div>

        {colorPicker ? (
          <ColorPicker
            title={t(colorPicker === "fg" ? "mask.pickerTitleFg" : "mask.pickerTitleBg")}
            initial={colorPicker === "fg" ? fgColor : bgColor}
            onConfirm={commitPickedColor}
            onCancel={() => setColorPicker(null)}
          />
        ) : null}

        {imageSizeDraft ? (
          <ImageSizeDialog
            draft={imageSizeDraft}
            setDraft={setImageSizeDraft}
            dims={dims}
            apply={dialogs.applyImageSize}
            close={() => setImageSizeDraft(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
