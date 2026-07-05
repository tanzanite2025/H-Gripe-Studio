import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNodeOutputSource } from "../viewport/useNodeOutputSource";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import type { ViewportMaskOverlay, ViewportOverlayItem, ViewportOverlayScene } from "../bridge/viewport";
import {
  ANCHOR_PATH_TOOLS,
  MASK_TOOLS,
  maskTool,
  DEFAULT_TOOL_ID,
  shapeVertices,
  type MaskTool,
  PS_SLOTS,
  psSlotOf,
  type PaintTarget,
  type ShapeKind,
} from "./maskTools";
import { useShortcutScope, type ShortcutHandlers } from "../shortcuts";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS } from "../shortcuts/scopes/maskEdit";
import { useT, type MsgKey } from "../i18n";
import { PreviewLane } from "../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "./maskMorphology";
import { FIT_VIEW, WHEEL_ZOOM_STEP, ZOOM_STEP, panBy, rotateTo, viewWindow, zoom100, zoomAt, zoomIn, zoomOut, type CanvasView } from "./canvasView";
import { applyDoc } from "./gradeKernel";
import { compileImageAdjustments } from "./imageCompile";
import { fromMaskDocument } from "./imageDocument";
import {
  activeOps,
  canRedo,
  canUndo,
  editCount,
  initEditState,
  type TransformParams,
} from "./maskEdit";
import type {
  BrushStroke,
  EditPathPoint,
  ImageResample,
  LayerAdjustment,
  MaskDocument,
} from "../types/production";
import { isBrushOp, isPathOp } from "../types/production";
import { maskEditReducer, type FillDraft, type MaskEditAction } from "./maskEditModal/actions";
import {
  paintAnchorDraft,
  paintCloneSource,
  paintColorSamples,
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
import { catmullRomClosed, flattenEditPath, pointInPolygon } from "./maskEditModal/pathGeometry";
import { buildEdgeMap, snapLoopToEdges, type EdgeMap } from "./maskEditModal/magneticSnap";
import { hitTestPathOp, translateAnchors } from "./maskEditModal/pathEditTools";
import type { ColorSample, RulerLine } from "./maskEditModal/stagePainter";
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

// Default logical canvas size when no backing image is available (browser
// preview mocks the backend, so the connected image often has no decodable
// thumbnail). Edits are recorded in this pixel space and the backend rasterises
// them against the real image on run.
const DEFAULT_W = 960;
const DEFAULT_H = 640;

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
  /** Editor name shown after the title (defaults to "mask editor"). */
  editorName?: string;
  /** Hide the title span (a host whose header carries document tabs). */
  hideTitle?: boolean;
  /** Product surface using this heavy pixel editor. */
  workspace?: "image" | "mask";
}

let strokeSeq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${strokeSeq++}`;

// Ops an active marquee selection does NOT confine: whole-mask reshapes keep
// their global meaning even while a selection is up (PS transforms / crops
// the selection contents, which the mask model has no notion of).
const UNCLIPPED_OPS = new Set(["transform", "crop", "perspective_crop", "select_all"]);

/** Image Size dialog draft: pixel size + linked aspect + resample filter. */
interface ImageSizeDraft {
  w: number;
  h: number;
  linked: boolean;
  resample: ImageResample;
}

const RESAMPLE_OPTIONS: readonly ImageResample[] = ["auto", "nearest", "bilinear", "bicubic"];
const RESAMPLE_KEYS = {
  auto: "mask.imageSizeResampleAuto",
  nearest: "mask.imageSizeResampleNearest",
  bilinear: "mask.imageSizeResampleBilinear",
  bicubic: "mask.imageSizeResampleBicubic",
} as const satisfies Record<ImageResample, MsgKey>;

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
const IMAGE_DOCK_STORAGE_KEY = "hgripe.studio.imageDock.v4";
// The image workspace is its own product surface: no mask-only docks
// (paths / mask-ops are mask concepts — the mask workspace keeps them).
const IMAGE_DOCK_LAYOUT: DockLayoutState = {
  groups: [
    { tabs: ["adjustments", "options"], active: "adjustments" },
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
  editorName,
  hideTitle,
  workspace = "mask",
}: MaskEditModalProps) {
  const t = useT();
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
  // Free-transform panel (M5, Ctrl+T): a numeric draft of move / scale /
  // rotate. `editingTransform` points at the history step being revised
  // (null ⇒ Apply appends a new `transform` op).
  const [transformDraft, setTransformDraft] = useState<TransformParams | null>(null);
  const [editingTransform, setEditingTransform] = useState<number | null>(null);
  // Fill dialog (M11, Shift+F5): a draft of mode + opacity; Apply records a
  // revisable `fill` op.
  const [fillDraft, setFillDraft] = useState<FillDraft | null>(null);
  // Image Size dialog (PS Ctrl+Alt+I): a draft of the output pixel size;
  // 确定 records it on the document as an undoable step.
  const [imageSizeDraft, setImageSizeDraft] = useState<ImageSizeDraft | null>(null);
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
  const viewportView = useMemo(
    () => viewWindow(view, canvasRef.current?.offsetWidth ?? 0, canvasRef.current?.offsetHeight ?? 0),
    [view],
  );
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
  // Color sampler pins (up to four persistent readouts, PS I flyout) — a
  // pure view read, session-local, never recorded on the document.
  const [colorSamples, setColorSamples] = useState<ColorSample[]>([]);
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
      state.current.layers.forEach((layer, li) => {
        if (!layer.visible) return;
        layer.ops.forEach((op, i) => {
          if (op.disabled || (li === state.current.active && i === editingPath)) return;
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
        });
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
  // Grading needs frame pixels, so it forces the PNG transport (a natively
  // presented surface frame has no readable data URL).
  const presentEnabled = !overlayOnly && !view.rotate && !gradePreview;
  const viewport = useViewportUnderlay(
    "image_edit",
    source,
    1280,
    viewportView,
    viewportMaskOverlay,
    underlayAnchorRef,
    presentEnabled,
    viewportOverlayScene,
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

  // In-progress freehand stroke (image-space points), null when not drawing.
  const drawing = useRef<{ points: [number, number][] } | null>(null);
  const marquee = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // PS-style brush cursor ring (positioned imperatively on pointer move).
  const brushCursorEl = useRef<HTMLDivElement | null>(null);
  // PS colour wells: foreground / background colours plus the open picker.
  // The mask itself is grayscale, so a picked colour maps to paint polarity
  // by luminance — a light foreground paints the mask in, a dark one erases.
  const [fgColor, setFgColor] = useState("#ffffff");
  const [bgColor, setBgColor] = useState("#000000");
  const [colorPicker, setColorPicker] = useState<"fg" | "bg" | null>(null);
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
  // In-progress shape drag (image-space bounding box); committed on release
  // as an ordinary vector path step built from the chosen shape's vertices.
  const shapeDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("polygon");
  const [shapeSides, setShapeSides] = useState(5);
  // In-progress move-tool drag (image-space): committed as a `transform` op.
  const moveDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // Move tool over a committed marquee: drag the selection region itself
  // (PS moves the marching ants) instead of transforming the mask.
  const marqueeMove = useRef<{ last: [number, number]; from: [number, number, number, number] } | null>(null);
  // In-progress gradient drag (M10): the start → end ramp vector; Alt at
  // pointer-down records a subtract ramp.
  const gradientDrag = useRef<{ start: [number, number]; end: [number, number]; subtract: boolean } | null>(null);
  // Clone-stamp source point (image-space), picked by Alt+click; null until
  // picked — painting without a source is inert (PS behaviour).
  const cloneSource = useRef<[number, number] | null>(null);
  // Dodge / burn direction of the in-progress stroke (Alt at pointer-down
  // burns — darkens — instead of dodging).
  const dodgeBurnMode = useRef<"dodge" | "burn">("dodge");
  // Sponge direction of the in-progress stroke (Alt at pointer-down softens
  // toward mid-grey instead of pushing toward hard on/off).
  const spongeMode = useRef<"saturate" | "desaturate">("saturate");
  // Magnetic lasso: an edge map over the underlay's visible window, captured
  // at drag start so the drawn loop can snap to image edges on release.
  const magneticEdge = useRef<EdgeMap | null>(null);
  // Patch tool: the committed lasso loop awaiting its drop drag, and the
  // in-progress drop drag (the loop's translation vector).
  const patchLoop = useRef<[number, number][] | null>(null);
  const patchDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // Perspective crop: the adjustable quad draft (TL, TR, BR, BL image-space)
  // between the box drag and the commit click, plus the corner being dragged.
  const [quadDraft, setQuadDraft] = useState<[number, number][] | null>(null);
  const quadCorner = useRef<number | null>(null);
  // Eyedropper sample: the image colour under the last click, as `#rrggbb`;
  // null until sampled (or when there is no underlay to read from).
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const rulerDrag = useRef<RulerLine | null>(null);
  // Path-selection whole-path drag: the last pointer position (image px).
  const wholePathDrag = useRef<[number, number] | null>(null);
  // Pending pen anchors (image-space) awaiting a close-path click.
  const [penAnchors, setPenAnchors] = useState<[number, number][]>([]);
  const [anchorDraft, setAnchorDraft] = useState<EditPathPoint[] | null>(null);
  const draggingAnchor = useRef<number | null>(null);
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
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  // In-progress rotate-view drag: the pointer's start angle about the canvas
  // centre plus the rotation it started from.
  const rotateDrag = useRef<{ angle: number; rotate: number } | null>(null);
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
        panDrag.current = null;
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
  const transformDraftRef = useRef<TransformParams | null>(null);
  transformDraftRef.current = transformDraft;
  const fillDraftRef = useRef<FillDraft | null>(null);
  fillDraftRef.current = fillDraft;
  const imageSizeDraftRef = useRef<ImageSizeDraft | null>(null);
  imageSizeDraftRef.current = imageSizeDraft;

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
      patchLoop.current = null;
      patchDrag.current = null;
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

  const closeTransformPanel = useCallback(() => {
    setTransformDraft(null);
    setEditingTransform(null);
  }, []);

  const openFreeTransform = () => {
    // Ctrl+T re-opens the last transform step for revision when one exists;
    // otherwise it starts a fresh identity draft (PS free transform).
    selectTool("move");
    const ops = activeOps(stateRef.current.current);
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (!isPathOp(op) && !isBrushOp(op) && op.type === "transform") {
        setEditingTransform(i);
        setTransformDraft({ dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 });
        return;
      }
    }
    setEditingTransform(null);
    setTransformDraft({ dx: 0, dy: 0, scale: 1, rotate: 0 });
  };
  // PS `D` (default colours): back to the default brush / add semantics and
  // the default white-over-black wells.
  const resetColors = () => {
    selectTool(DEFAULT_TOOL_ID);
    setPathMode("add");
    setPaintTarget("layer");
    setFgColor("#ffffff");
    setBgColor("#000000");
  };

  // PS `X` (swap colours): swap the wells and flip paint polarity —
  // brush↔eraser, or a path tool's boolean mode.
  const swapColors = () => {
    setFgColor(bgColor);
    setBgColor(fgColor);
    if (toolId === "brush") setToolId("eraser");
    else if (toolId === "eraser") setToolId("brush");
    else if (tool.kind === "path") setPathMode((m) => (m === "add" ? "subtract" : "add"));
  };

  // A picked well colour: in the grayscale mask the foreground's luminance
  // sets the paint polarity (light paints in, dark erases — PS painting on a
  // mask with white/black).
  const commitPickedColor = (hex: string) => {
    if (colorPicker === "bg") setBgColor(hex);
    else {
      setFgColor(hex);
      const rgb = hexToRgb(hex);
      if (rgb) {
        const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
        if (toolId === "brush" && lum < 0.5) setToolId("eraser");
        else if (toolId === "eraser" && lum >= 0.5) setToolId("brush");
      }
    }
    setColorPicker(null);
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
    fill_dialog: () => setFillDraft({ mode: "add", opacity: 100 }),
    image_size: () => {
      const canvas = stateRef.current.current.canvas;
      setImageSizeDraft({ w: canvas?.w ?? dims.w, h: canvas?.h ?? dims.h, linked: true, resample: canvas?.resample ?? "auto" });
    },
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
      // Anchor re-editing, an open transform panel, or a pending pen path
      // swallows the first Escape.
      if (editingPathRef.current != null) cancelPathEdit();
      else if (transformDraftRef.current) closeTransformPanel();
      else if (fillDraftRef.current) setFillDraft(null);
      else if (imageSizeDraftRef.current) setImageSizeDraft(null);
      else if (penPendingRef.current) setPenAnchors([]);
      else if (toolId === "rotate_view" && viewRef.current.rotate) setView((v) => rotateTo(v, 0));
      else onClose();
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

  // Eyedropper: read the underlay pixel at an image-space point by drawing
  // the presented frame — a view window of the image — onto an offscreen
  // canvas at the window's document size. Async (the data URL decodes first);
  // a no-op when there is no underlay or the point is outside the window.
  // A natively presented frame has no data URL: explicit pixel readback
  // (`readPixels`, surface swap Phase S4) answers instead.
  const viewportHost = viewport.host;
  const sampleUnderlay = useCallback(
    (pt: [number, number], onSample?: (hex: string) => void) => {
      const winW = Math.max(1, Math.round(dims.w / frameView.zoom));
      const winH = Math.max(1, Math.round(dims.h / frameView.zoom));
      const x = Math.round(pt[0] - frameView.panX * dims.w);
      const y = Math.round(pt[1] - frameView.panY * dims.h);
      if (x < 0 || y < 0 || x >= winW || y >= winH) return;
      const sample = (r: number, g: number, b: number) => {
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        if (onSample) onSample(hex);
        else setSampledColor(hex);
      };
      if (!underlay) {
        if (!presented || !viewportHost || !viewportHost.isOpen) return;
        viewportHost
          .readPixels()
          .then((px) => {
            const fx = Math.min(px.width - 1, Math.floor((x / winW) * px.width));
            const fy = Math.min(px.height - 1, Math.floor((y / winH) * px.height));
            const i = (fy * px.width + fx) * 4;
            sample(px.pixels[i], px.pixels[i + 1], px.pixels[i + 2]);
          })
          .catch(() => {
            /* keep the previous sample */
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
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        sample(r, g, b);
      };
      img.src = underlay;
    },
    [underlay, presented, viewportHost, frameView, dims.w, dims.h],
  );

  // Magnetic lasso: capture the underlay's visible window as an edge map at
  // drag start (async — the frame decodes first). The map lands in
  // `magneticEdge` for the commit-time snap; with no underlay (browser
  // preview) it stays null and the lasso commits unsnapped.
  const captureEdgeMap = useCallback(() => {
    magneticEdge.current = null;
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
          magneticEdge.current = buildEdgeMap(px.pixels, px.width, px.height, offX, offY);
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
      magneticEdge.current = buildEdgeMap(data, winW, winH, offX, offY);
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
    if (!previewing) {
      state.current.layers.forEach((layer, li) => {
        if (!layer.visible) return;
        layer.ops.forEach((op, i) => {
          if (op.disabled || (li === state.current.active && i === editingPath)) return;
          if (isBrushOp(op)) paintStroke(ctx, op);
          // Committed vector paths render host-side (the viewport overlay
          // scene); the canvas draws them only for the fallback stage.
          else if (isPathOp(op) && !underlay && !presented) paintPath(ctx, op);
        });
      });
    }
    state.current.matte_strokes.forEach((s) => paintStroke(ctx, s, "matte"));
    const live = drawing.current;
    if (live) {
      if (tool.kind === "path" || tool.id === "patch" || tool.id === "content_aware_move") {
        paintLassoLoop(ctx, live.points);
      } else if (tool.kind === "heal" || tool.kind === "clone" || tool.kind === "history" || tool.kind === "dodge") {
        paintRetouchBand(ctx, live.points, brushSize, retouchBandColor(tool.kind, dodgeBurnMode.current));
      } else {
        const liveMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
        paintStroke(
          ctx,
          { mode: tool.mode ?? "add", radius: brushSize, points: live.points, hardness: brushHardness, flow: brushFlow },
          liveMatte ? "matte" : "paint",
        );
      }
    }

    if ((tool.kind === "clone" || tool.id === "healing_brush") && cloneSource.current) paintCloneSource(ctx, cloneSource.current);
    if (editingPath != null && anchorDraft) paintAnchorDraft(ctx, anchorDraft, draggingAnchor.current);
    if (penAnchors.length > 0) paintPenAnchors(ctx, penAnchors);
    // With a host frame, sampler pins / ruler / SAM markers stroke host-side
    // (the viewport overlay scene) — the canvas keeps only the text labels.
    // The live ruler drag stays fully on the canvas for zero-latency feedback.
    const hostFrame = Boolean(underlay || presented);
    if (colorSamples.length > 0) paintColorSamples(ctx, colorSamples, hostFrame);
    const rl = rulerDrag.current ?? (tool.id === "ruler" ? rulerLine : null);
    if (rl) paintRuler(ctx, rl, hostFrame && rulerDrag.current == null);
    paintSamPoints(ctx, state.current.points, hostFrame);
    // With a host frame — a PNG underlay or a natively presented surface —
    // the selection tint is composited host-side (the viewport mask
    // overlay); paint it locally only for the fallback stage.
    if (!underlay && !presented) {
      if (previewing && preview) paintPreviewOverlay(ctx, preview, dims.w, dims.h);
      if (quickMask && quickProxy) paintQuickMask(ctx, quickProxy, dims.w, dims.h);
    }

    const md = moveDrag.current ?? gradientDrag.current;
    if (md) paintDragArrow(ctx, md.start, md.end);
    const sd = shapeDrag.current;
    if (sd) paintShapeDraft(ctx, shapeKind, sd.start, sd.end, shapeSides, brushSize);
    const mq = marquee.current;
    if (mq) paintMarquee(ctx, mq.start, mq.end, tool.id === "ellipse");
    else if (lastMarquee && !underlay && !presented) {
      // The committed ants stroke host-side over the presented frame; the
      // canvas only draws them when no host frame presents (browser preview).
      const [x0, y0, x1, y1] = lastMarquee.region;
      paintMarquee(ctx, [x0, y0], [x1, y1], lastMarquee.ellipse);
    }
    const pl = patchLoop.current;
    if (pl) {
      const pd = patchDrag.current;
      const [ox, oy] = pd ? [pd.end[0] - pd.start[0], pd.end[1] - pd.start[1]] : [0, 0];
      paintLassoLoop(ctx, pd ? pl.map(([x, y]) => [x + ox, y + oy] as [number, number]) : pl, true);
      if (pd) paintDragArrow(ctx, pd.start, pd.end);
    }
    if (quadDraft) paintQuadDraft(ctx, quadDraft);
  }, [dims.w, dims.h, overlayOnly, underlay, presented, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy, shapeKind, shapeSides, colorSamples, rulerLine, quadDraft, lastMarquee]);

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

  const onPointerDown = (e: React.PointerEvent) => {
    // Canvas navigation (M8): hand tool / Space-hold pans; zoom tool clicks
    // in (Alt+click out) anchored at the cursor. Neither records anything.
    if (spacePan || tool.id === "hand") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panDrag.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (tool.id === "zoom") {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const factor = e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP;
      setView((v) => zoomAt(v, factor, cx, cy, ...viewBase()));
      return;
    }
    if (tool.id === "rotate_view") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      rotateDrag.current = { angle: pointerAngle(e), rotate: viewRef.current.rotate ?? 0 };
      return;
    }
    if (editingPath != null && anchorDraft) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const [x, y] = toImage(e);
      if (tool.id === "path_select") {
        // Path selection: any drag moves the whole selected path.
        wholePathDrag.current = [x, y];
        return;
      }
      // Anchor re-editing mode: grab the nearest anchor square, if any.
      const grabRadius = Math.max(10, dims.w * 0.012);
      let best = -1;
      let bestDist = grabRadius;
      anchorDraft.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= bestDist) {
          best = i;
          bestDist = d;
        }
      });
      draggingAnchor.current = best >= 0 ? best : null;
      return;
    }
    if (tool.status !== "ready") return;
    // Adjustment layers carry no edit stack — canvas edits that would record
    // onto the active layer are ignored; document-level matte strokes / SAM
    // points still land.
    const activeIsAdjustment = activeLayerKind === "adjustment";
    const toMatteTarget = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
    if (activeIsAdjustment && tool.kind !== "point" && !toMatteTarget) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pt = toImage(e);
    if (tool.kind === "path_edit") {
      // Path / direct selection: click near a committed path outline to
      // re-open it through the ordinary anchor-edit flow (M2).
      const hit = hitTestPathOp(activeOps(state.current), pt, Math.max(10, dims.w * 0.012));
      if (hit >= 0) startPathEdit(hit);
      return;
    }
    if (tool.kind === "path") {
      if (tool.id === "lasso" || tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
        if (tool.id === "magnetic_lasso") captureEdgeMap();
        drawing.current = { points: [pt] };
        forceRedraw((n) => n + 1);
        return;
      }
      // Anchor tools (pen / polygonal lasso / curvature pen): clicking near
      // the first anchor closes the path.
      const closeRadius = Math.max(8, dims.w * 0.01);
      const first = penAnchors[0];
      if (penAnchors.length >= 3 && first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) <= closeRadius) {
        closePenPath();
        return;
      }
      setPenAnchors((prev) => [...prev, pt]);
      return;
    }
    if (tool.id === "patch" || tool.id === "content_aware_move") {
      // Patch / content-aware move: a drag from inside the pending loop
      // drops it; anywhere else starts a fresh lasso.
      const loop = patchLoop.current;
      if (loop && pointInPolygon(pt, loop)) {
        patchDrag.current = { start: pt, end: pt };
      } else {
        patchLoop.current = null;
        drawing.current = { points: [pt] };
      }
      forceRedraw((n) => n + 1);
      return;
    }
    if (tool.id === "perspective_crop") {
      // Perspective crop: drag corners of the pending quad, click inside it
      // to commit, or drag a fresh box.
      const quad = quadDraft;
      if (quad) {
        const grabRadius = Math.max(10, dims.w * 0.012);
        const idx = quad.findIndex(([qx, qy]) => Math.hypot(qx - pt[0], qy - pt[1]) <= grabRadius);
        if (idx >= 0) {
          quadCorner.current = idx;
          return;
        }
        setQuadDraft(null);
        if (pointInPolygon(pt, quad)) {
          dispatch({ type: "op", op: { type: "perspective_crop", region: quad.flat() } });
          return;
        }
      }
      marquee.current = { start: pt, end: pt };
      forceRedraw((n) => n + 1);
      return;
    }
    if (tool.id === "pattern_stamp") {
      // Pattern stamp paints the fixed checker — no source point needed.
      drawing.current = { points: [pt] };
      forceRedraw((n) => n + 1);
      return;
    }
    if (tool.kind === "clone" || tool.id === "healing_brush") {
      // Alt+click picks the source; painting without one is inert.
      if (e.altKey) {
        cloneSource.current = pt;
        forceRedraw((n) => n + 1);
        return;
      }
      if (!cloneSource.current) return;
      drawing.current = { points: [pt] };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "paint" || tool.kind === "matte" || tool.kind === "heal" || tool.kind === "history" || tool.kind === "dodge") {
      if (tool.id === "sponge") spongeMode.current = e.altKey ? "desaturate" : "saturate";
      else if (tool.kind === "dodge") dodgeBurnMode.current = e.altKey ? "burn" : "dodge";
      drawing.current = { points: [pt] };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "transform") {
      const r = lastMarquee?.region;
      if (r && pt[0] >= r[0] && pt[0] <= r[2] && pt[1] >= r[1] && pt[1] <= r[3]) {
        marqueeMove.current = { last: pt, from: r };
      } else {
        moveDrag.current = { start: pt, end: pt };
      }
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "gradient") {
      gradientDrag.current = { start: pt, end: pt, subtract: e.altKey };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "marquee") {
      marquee.current = { start: pt, end: pt };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "shape") {
      shapeDrag.current = { start: pt, end: pt };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "click") {
      if (tool.id === "red_eye") {
        // Red eye: the contiguous red-dominant region around the click
        // floods into the mask on run.
        dispatch({ type: "op", op: { type: "red_eye", region: pt } });
        return;
      }
      // Wand-family flood fill, seeded at the click: the paint bucket adds
      // like the wand; the magic eraser records mode "subtract" and the
      // backend clears the flooded region instead.
      dispatch({
        type: "op",
        op: { type: "wand", amount: tolerance, region: pt, ...(tool.mode === "subtract" ? { mode: "subtract" } : null) },
      });
    } else if (tool.kind === "sample") {
      // Sample tools are pure view reads — nothing lands on the document.
      if (tool.id === "ruler") {
        rulerDrag.current = { start: pt, end: pt };
        forceRedraw((n) => n + 1);
      } else if (tool.id === "color_sampler") {
        // Pin up to four persistent readouts (PS colour sampler).
        sampleUnderlay(pt, (hex) =>
          setColorSamples((prev) => (prev.length >= 4 ? prev : [...prev, { x: pt[0], y: pt[1], hex }])),
        );
      } else {
        sampleUnderlay(pt);
      }
    } else if (tool.kind === "point") {
      // SAM 2 point prompt: left button includes (positive), right button
      // excludes (negative). Right-click's context menu is suppressed below.
      const label = e.button === 2 ? 0 : 1;
      dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
    }
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
    if (rotateDrag.current) {
      const { angle, rotate } = rotateDrag.current;
      setView((v) => rotateTo(v, rotate + pointerAngle(e) - angle));
      return;
    }
    if (panDrag.current) {
      const dx = e.clientX - panDrag.current.x;
      const dy = e.clientY - panDrag.current.y;
      panDrag.current = { x: e.clientX, y: e.clientY };
      setView((v) => panBy(v, dx, dy, ...viewBase()));
      return;
    }
    if (wholePathDrag.current) {
      const [x, y] = toImage(e);
      const [px, py] = wholePathDrag.current;
      wholePathDrag.current = [x, y];
      setAnchorDraft((prev) => (prev ? translateAnchors(prev, x - px, y - py) : prev));
      return;
    }
    if (draggingAnchor.current != null) {
      const [x, y] = toImage(e);
      const idx = draggingAnchor.current;
      setAnchorDraft((prev) => (prev ? prev.map((p, i) => (i === idx ? { ...p, x, y } : p)) : prev));
      return;
    }
    if (rulerDrag.current) {
      rulerDrag.current.end = toImage(e);
      redraw();
      return;
    }
    if (quadCorner.current != null) {
      const p = toImage(e);
      const idx = quadCorner.current;
      setQuadDraft((prev) => (prev ? prev.map((q, i) => (i === idx ? p : q)) : prev));
      return;
    }
    if (patchDrag.current) {
      patchDrag.current.end = toImage(e);
      redraw();
      return;
    }
    if (drawing.current) {
      drawing.current.points.push(toImage(e));
      redraw();
    } else if (marqueeMove.current) {
      const pt = toImage(e);
      const { last } = marqueeMove.current;
      const dx = pt[0] - last[0];
      const dy = pt[1] - last[1];
      marqueeMove.current.last = pt;
      setLastMarquee((prev) => {
        if (!prev) return prev;
        const [x0, y0, x1, y1] = prev.region;
        const w = x1 - x0;
        const h = y1 - y0;
        const nx = Math.max(0, Math.min(x0 + dx, dims.w - w));
        const ny = Math.max(0, Math.min(y0 + dy, dims.h - h));
        return { ...prev, region: [nx, ny, nx + w, ny + h] };
      });
    } else if (moveDrag.current) {
      moveDrag.current.end = toImage(e);
      redraw();
    } else if (gradientDrag.current) {
      gradientDrag.current.end = toImage(e);
      redraw();
    } else if (marquee.current) {
      marquee.current.end = toImage(e);
      redraw();
    } else if (shapeDrag.current) {
      shapeDrag.current.end = toImage(e);
      redraw();
    }
  };

  const onPointerUp = () => {
    // Also reached from the canvas's pointer-leave: hide the brush ring until
    // the pointer is back over the canvas.
    if (brushCursorEl.current) brushCursorEl.current.style.display = "none";
    if (rotateDrag.current) {
      rotateDrag.current = null;
      return;
    }
    if (panDrag.current) {
      panDrag.current = null;
      return;
    }
    if (wholePathDrag.current) {
      wholePathDrag.current = null;
      forceRedraw((n) => n + 1);
      return;
    }
    if (draggingAnchor.current != null) {
      draggingAnchor.current = null;
      forceRedraw((n) => n + 1);
      return;
    }
    if (rulerDrag.current) {
      const { start, end } = rulerDrag.current;
      rulerDrag.current = null;
      setRulerLine(Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1 ? { start, end } : null);
      forceRedraw((n) => n + 1);
      return;
    }
    if (quadCorner.current != null) {
      quadCorner.current = null;
      return;
    }
    if (patchDrag.current) {
      const { start, end } = patchDrag.current;
      patchDrag.current = null;
      const loop = patchLoop.current;
      if (loop && Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
        // Patch: covered pixel `p` refills from `p + [dx, dy]` — the drop
        // site is the clean-texture source. Content-aware move instead
        // moves the loop by `[dx, dy]` and heals the hole behind it.
        dispatch({ type: "op", op: { type: tool.id === "content_aware_move" ? "content_aware_move" : "patch", points: loop, dx: end[0] - start[0], dy: end[1] - start[1] } });
        patchLoop.current = null;
      }
      forceRedraw((n) => n + 1);
      return;
    }
    if (drawing.current) {
      const pts = drawing.current.points;
      drawing.current = null;
      if (tool.id === "lasso" || tool.id === "freeform_pen" || tool.id === "magnetic_lasso") {
        // The magnetic lasso snaps the drawn loop to nearby image edges at
        // commit time (the search window scales with the drawn size).
        const edge = tool.id === "magnetic_lasso" ? magneticEdge.current : null;
        commitPath(tool.id, edge ? snapLoopToEdges(edge, pts, Math.max(6, dims.w * 0.008)) : pts);
        magneticEdge.current = null;
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "quick_select") {
        // Quick selection: every stroke point seeds a tolerance flood-fill on
        // the real image; the fills union into the mask on run.
        dispatch({ type: "op", op: { type: "quick_select", amount: tolerance, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "background_eraser") {
        // Background eraser: pixels inside the brush discs matching the
        // colour under each stamp's centre are erased on run.
        dispatch({ type: "op", op: { type: "background_eraser", amount: brushSize, points: pts, tolerance } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "healing_brush") {
        // Healing brush: like the clone stamp but the copied patch blends
        // through a feathered edge (source fixed at the drag start).
        const src = cloneSource.current;
        if (src) {
          const [dx, dy] = [src[0] - pts[0][0], src[1] - pts[0][1]];
          dispatch({ type: "op", op: { type: "healing_brush", amount: brushSize, points: pts, dx, dy } });
        }
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "sponge") {
        dispatch({ type: "op", op: { type: "sponge", amount: brushSize, points: pts, mode: spongeMode.current } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "patch" || tool.id === "content_aware_move") {
        // The released lasso becomes the pending loop; the next drag from
        // inside it records the op.
        patchLoop.current = pts.length >= 3 ? pts : null;
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "remove") {
        // Remove (M16): the stroke seeds the segmenter; the segmented
        // object is subtracted from the mask on run.
        dispatch({ type: "op", op: { type: "remove", amount: brushSize, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "pattern_stamp") {
        // Pattern stamp (M16): covered pixels take the repeating checker
        // pattern on replay.
        dispatch({ type: "op", op: { type: "pattern_stamp", amount: brushSize, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.id === "art_history_brush") {
        // Art history brush (M16): the stroke restores the layer's initial
        // state through a deterministic jitter on replay.
        dispatch({ type: "op", op: { type: "art_history_brush", amount: brushSize, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.kind === "heal") {
        // Spot-heal (M13): the stroke records a `heal` op — the painted
        // region is rebuilt from its surroundings on replay.
        dispatch({ type: "op", op: { type: "heal", amount: brushSize, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.kind === "dodge") {
        // Dodge / burn (M13): the stroke records a `dodge_burn` op — Alt at
        // pointer-down burns (darkens), otherwise dodges (lightens).
        dispatch({ type: "op", op: { type: "dodge_burn", amount: brushSize, points: pts, mode: dodgeBurnMode.current } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.kind === "history") {
        // History brush (M13): the stroke records a `history_brush` op — the
        // painted region is restored to the layer's pre-edit state on replay.
        dispatch({ type: "op", op: { type: "history_brush", amount: brushSize, points: pts } });
        forceRedraw((n) => n + 1);
        return;
      }
      if (tool.kind === "clone") {
        // Clone stamp (M13): the source offset is fixed at the drag start
        // (PS aligned mode) — painted pixel `p` copies from `p + [dx, dy]`.
        const src = cloneSource.current;
        if (src) {
          const [dx, dy] = [src[0] - pts[0][0], src[1] - pts[0][1]];
          dispatch({ type: "op", op: { type: "clone", amount: brushSize, points: pts, dx, dy } });
        }
        forceRedraw((n) => n + 1);
        return;
      }
      // The pencil is a brush with hardness / flow pinned to 100% (a hard
      // aliased stamp); its strokes never record the soft-brush fields.
      const hardTool = tool.id === "pencil";
      const stroke: BrushStroke = {
        id: nextId("stroke"),
        mode: tool.mode ?? "add",
        radius: brushSize,
        points: pts,
        // Soft-brush fields are recorded only for soft strokes so hard
        // strokes keep the legacy shape (and byte-identical replay).
        ...(!hardTool && (brushHardness < 1 || brushFlow < 1)
          ? { hardness: brushHardness, flow: brushFlow, spacing: brushSpacing }
          : null),
      };
      const toMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
      dispatch({ type: toMatte ? "matte_stroke" : "stroke", stroke });
    } else if (marqueeMove.current) {
      // The moved selection is already live in `lastMarquee`; nothing lands
      // on the edit stack (the selection is not a mask edit).
      marqueeMove.current = null;
    } else if (moveDrag.current) {
      const { start, end } = moveDrag.current;
      moveDrag.current = null;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
        dispatch({ type: "op", op: { type: "transform", dx, dy } });
      }
      forceRedraw((n) => n + 1);
    } else if (gradientDrag.current) {
      const { start, end, subtract } = gradientDrag.current;
      gradientDrag.current = null;
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 1) {
        dispatch({
          type: "op",
          op: { type: "gradient", region: [start[0], start[1], end[0], end[1]], mode: subtract ? "subtract" : "add" },
        });
      }
      forceRedraw((n) => n + 1);
    } else if (marquee.current) {
      const { start, end } = marquee.current;
      marquee.current = null;
      const region = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
      if (region[2] - region[0] > 1 && region[3] - region[1] > 1) {
        if (tool.id === "perspective_crop") {
          // The box becomes an adjustable quad; the commit happens on the
          // click inside it.
          setQuadDraft([
            [region[0], region[1]],
            [region[2], region[1]],
            [region[2], region[3]],
            [region[0], region[3]],
          ]);
        } else if (tool.id === "rect" || tool.id === "ellipse") {
          // PS marquee: the drag only defines the selection — nothing lands
          // on the edit stack until a subsequent operation uses it.
          setLastMarquee({
            region: region as [number, number, number, number],
            ellipse: tool.id === "ellipse",
          });
          // Surface the selection's size readout / manual inputs: they live
          // on the 选项 tab, which may be behind another tab in its group.
          dock.onSelect("options");
        } else {
          dispatch({ type: "op", op: { type: tool.id, region } });
        }
      } else if (tool.id === "rect" || tool.id === "ellipse") {
        // A plain click with a marquee tool drops the selection (PS deselect).
        setLastMarquee(null);
      }
      forceRedraw((n) => n + 1);
    } else if (shapeDrag.current) {
      const { start, end } = shapeDrag.current;
      shapeDrag.current = null;
      const pts = shapeVertices(shapeKind, [start[0], start[1], end[0], end[1]], shapeSides, brushSize);
      if (pts.length >= 3) {
        dispatch({
          type: "path",
          path: {
            id: nextId("path"),
            mode: pathMode,
            tool: "shape",
            closed: true,
            points: pts.map(([x, y]) => ({ x, y })),
          },
        });
      }
      forceRedraw((n) => n + 1);
    }
  };

  // Clicking a tool: `global` tools are immediate actions (no canvas mode);
  // paint/click/marquee/path tools become the active mode; `planned` tools are inert.
  const onToolClick = (t: MaskTool) => {
    if (t.status !== "ready") return;
    if (!ANCHOR_PATH_TOOLS.includes(t.id)) setPenAnchors([]);
    cancelPathEdit();
    if (t.id !== "patch" && t.id !== "content_aware_move") {
      patchLoop.current = null;
      patchDrag.current = null;
    }
    if (t.id !== "perspective_crop") setQuadDraft(null);
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
  };

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className={`media-viewer mask-edit${screenMode ? ` mask-screen-${screenMode}` : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          {hideTitle ? null : (
            <span className="media-viewer-name" title={title}>
              {title} <span className="muted">· {editorName ?? t("mask.editor")}</span>
            </span>
          )}
          {headerExtra}
          <div className="media-viewer-actions">
            <button disabled={!canUndo(state)} onClick={() => dispatch({ type: "undo" })} title={t("mask.undoTitle")}>
              ↶ {t("mask.undo")}
            </button>
            <button disabled={!canRedo(state)} onClick={() => dispatch({ type: "redo" })} title={t("mask.redoTitle")}>
              ↷ {t("mask.redo")}
            </button>
            <button disabled={count === 0} onClick={() => dispatch({ type: "clear" })} title={t("mask.clearTitle")}>
              {t("mask.clear")}
            </button>
            {workspace === "mask" ? (
              <>
                <button className={overlayOnly ? "active" : ""} onClick={() => setOverlayOnly((v) => !v)} title={t("mask.togglePreviewTitle")}>
                  {overlayOnly ? t("mask.showImage") : t("mask.maskOnly")}
                </button>
                <button className={quickMask ? "active" : ""} onClick={() => setQuickMask((v) => !v)} title={t("mask.quickMaskTitle")}>
                  {t("mask.quickMask")}
                </button>
              </>
            ) : null}
            <button className="primary" onClick={() => { onCommit(state.current); onClose(); }} title={t("mask.applyTitle")}>
              {t("mask.apply")}
            </button>
            <button onClick={onClose} title={t("mask.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

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
            underlay={gradedUnderlay ?? underlay}
            presented={presented}
            underlayRef={underlayAnchorRef}
            frameView={frameView}
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

          {/* Floating selection-size panel: centred below the marquee's
              bottom edge, clamped to the window. Screen-space so the view
              transform never scales it. */}
          {lastMarquee && !marquee.current && tool.kind === "marquee" && canvasRef.current
            ? (() => {
                const rect = canvasRef.current.getBoundingClientRect();
                const [x0, y0, x1, y1] = lastMarquee.region;
                const midX = rect.left + (((x0 + x1) / 2) / dims.w) * rect.width;
                const belowY = rect.top + (y1 / dims.h) * rect.height + 10;
                const left = Math.max(130, Math.min(midX, window.innerWidth - 130));
                const top = Math.max(10, Math.min(belowY, window.innerHeight - 90));
                return (
                  <div
                    className="mask-marquee-float"
                    style={{ left, top }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <span className="muted">
                      {Math.round(x1 - x0)} × {Math.round(y1 - y0)} px
                    </span>
                    <span className="mask-marquee-float-row">
                      <input
                        type="number"
                        min={2}
                        max={dims.w}
                        value={marqueeDraft.w}
                        onChange={(e) => setMarqueeDraft((d) => ({ ...d, w: Number(e.target.value) || 0 }))}
                      />
                      ×
                      <input
                        type="number"
                        min={2}
                        max={dims.h}
                        value={marqueeDraft.h}
                        onChange={(e) => setMarqueeDraft((d) => ({ ...d, h: Number(e.target.value) || 0 }))}
                      />
                      <button
                        className="primary"
                        disabled={marqueeDraft.w < 2 || marqueeDraft.h < 2}
                        onClick={() => applyMarqueeSize(marqueeDraft.w, marqueeDraft.h)}
                      >
                        {t("mask.marqueeApply")}
                      </button>
                    </span>
                  </div>
                );
              })()
            : null}

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
                    <AdjustmentsPanel dispatch={dispatch} adjustment={activeAdjustment} patchAdjustment={patchAdjustment} />
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
              active={state.current.active}
              dims={dims}
              imagePath={imagePath}
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
              editTransformStep={(i, op) => {
                if (isPathOp(op) || isBrushOp(op) || op.type !== "transform") return;
                setEditingTransform(i);
                setTransformDraft({ dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 });
              }}
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
          <div className="mask-dialog-backdrop" onClick={() => setImageSizeDraft(null)}>
            <div className="mask-dialog" role="dialog" aria-label={t("mask.imageSize")} onClick={(e) => e.stopPropagation()}>
              <div className="mask-dialog-title">{t("mask.imageSize")}</div>
              <div className="mask-dialog-body">
                <div className="field">
                  <span>{t("mask.imageSizeCurrent")}</span>
                  <small className="muted">{dims.w} × {dims.h} px</small>
                </div>
                <label className="field">
                  <span>{t("mask.imageSizeWidth")}</span>
                  <input
                    type="number"
                    min={1}
                    value={imageSizeDraft.w}
                    onChange={(e) => {
                      const w = Math.max(1, Math.round(Number(e.target.value) || 0));
                      setImageSizeDraft((d) =>
                        d ? { ...d, w, h: d.linked ? Math.max(1, Math.round((w * dims.h) / dims.w)) : d.h } : d,
                      );
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t("mask.imageSizeHeight")}</span>
                  <input
                    type="number"
                    min={1}
                    value={imageSizeDraft.h}
                    onChange={(e) => {
                      const h = Math.max(1, Math.round(Number(e.target.value) || 0));
                      setImageSizeDraft((d) =>
                        d ? { ...d, h, w: d.linked ? Math.max(1, Math.round((h * dims.w) / dims.h)) : d.w } : d,
                      );
                    }}
                  />
                </label>
                <label className="field mask-dialog-check">
                  <input
                    type="checkbox"
                    checked={imageSizeDraft.linked}
                    onChange={(e) => setImageSizeDraft((d) => (d ? { ...d, linked: e.target.checked } : d))}
                  />
                  <span>{t("mask.imageSizeLink")}</span>
                </label>
                <label className="field">
                  <span>{t("mask.imageSizeResample")}</span>
                  <select
                    value={imageSizeDraft.resample}
                    onChange={(e) => setImageSizeDraft((d) => (d ? { ...d, resample: e.target.value as ImageResample } : d))}
                  >
                    {RESAMPLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(RESAMPLE_KEYS[r])}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mask-dialog-actions">
                <button
                  className="primary"
                  onClick={() => {
                    dispatch({
                      type: "canvas_size",
                      canvas: { w: imageSizeDraft.w, h: imageSizeDraft.h, resample: imageSizeDraft.resample },
                    });
                    setImageSizeDraft(null);
                  }}
                >
                  {t("mask.imageSizeApply")}
                </button>
                <button onClick={() => setImageSizeDraft(null)}>{t("mask.imageSizeCancel")}</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
