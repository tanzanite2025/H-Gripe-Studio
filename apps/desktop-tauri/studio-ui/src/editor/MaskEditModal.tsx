import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../viewport/view";
import type { ViewportMaskOverlay, ViewportOverlayScene } from "../bridge/viewport";
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
import { parseCombo, useShortcutScope, type ShortcutHandlers } from "../shortcuts";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS, toolCombo } from "../shortcuts/scopes/maskEdit";
import { useT } from "../i18n";
import { PreviewLane } from "../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "./maskMorphology";
import { FIT_VIEW, rotateTo, zoom100, zoomIn, zoomOut } from "./canvasView";
import { applyDoc } from "./gradeKernel";
import { compileImageAdjustments } from "./imageCompile";
import { fromMaskDocument } from "./imageDocument";
import {
  activeOps,
  canRedo,
  canUndo,
  composeTransforms,
  currentHistoryIndex,
  editCount,
  historySnapshots,
  initEditState,
  type EditState,
  type TransformParams,
} from "./maskEdit";
import type {
  LayerAdjustment,
  MaskDocument,
} from "../types/production";
import { activeTargetKind, isBrushOp, isPathOp } from "../types/production";
import { maskEditReducer, type MaskEditAction } from "./maskEditModal/actions";
import { buildViewportOverlayScene, paintStage } from "./maskEditModal/stageScene";
import { catmullRomClosed, pointInPolygon } from "./maskEditModal/pathGeometry";
import { buildEdgeMap, DEFAULT_MAGNETIC_SNAP } from "./maskEditModal/magneticSnap";
import type { RulerLine } from "./maskEditModal/stagePainter";
import { PanelDock, type DockPanel } from "./maskEditModal/PanelDock";
import { useDockLayout, type DockLayoutState } from "./maskEditModal/dockLayout";
import "./maskEditModal/maskEditModal.css";
import { MaskToolbar } from "./maskEditModal/MaskToolbar";
import { MaskOpsPanel } from "./maskEditModal/MaskOpsPanel";
import { MaskStage } from "./maskEditModal/MaskStage";
import { ToolOptionsPanel } from "./maskEditModal/ToolOptionsPanel";
import { LayersPanel } from "./maskEditModal/LayersPanel";
import { HistoryPanel, HistorySnapshotDialog } from "./maskEditModal/HistoryPanel";
import { InfoPanel } from "./maskEditModal/InfoPanel";
import { AdjustmentsPanel } from "./maskEditModal/AdjustmentsPanel";
import { ChannelsPanel } from "./maskEditModal/ChannelsPanel";
import { PathsPanel } from "./maskEditModal/PathsPanel";
import { ColorPicker } from "./maskEditModal/ColorPicker";
import { createPointerGestures, pointerDown, pointerMove, pointerUp, type PointerEnv } from "./maskEditModal/pointerMachine";
import { useCanvasNavigation } from "./maskEditModal/useCanvasNavigation";
import { useCropTool } from "./maskEditModal/useCropTool";
import { useColorTools, type ColorToolsEnv } from "./maskEditModal/useColorTools";
import { useDialogDrafts } from "./maskEditModal/useDialogDrafts";
import { usePathEditing } from "./maskEditModal/usePathEditing";
import { ImageSizeDialog } from "./maskEditModal/ImageSizeDialog";
import { CropPanel } from "./maskEditModal/CropPanel";
import { MarqueeSizePanel } from "./maskEditModal/MarqueeSizePanel";
import { ToolIcon } from "./maskEditModal/toolIcons";
import { resolveActiveTarget, resolveTargetBounds } from "./studioTarget";
import { getCommand, getCommandCapability, type CommandId } from "./studioCommands";
import { ContextActionBar } from "./maskEditModal/ContextActionBar";
import { runMaskEditorCommand } from "./maskEditorCommandRunner";

// Default logical canvas size when no backing image is available (browser
// preview mocks the backend, so the connected image often has no decodable
// thumbnail). Edits are recorded in this pixel space and the backend rasterises
// them against the real image on run.
const DEFAULT_W = 960;
const DEFAULT_H = 640;
const SELECTION_TOP_TOOLS = ["rect", "ellipse", "magnetic_lasso", "polygon_lasso", "pen", "object_select", "quick_select", "wand", "point"] as const;
const SELECTION_TOP_SLOT_IDS = ["marquee", "lasso", "selection", "pen"] as const;
const IMAGE_CONTEXT_COMMANDS: CommandId[] = ["layer.invert", "layer.addMask", "layer.duplicate", "target.transform", "target.delete"];

function toolKeyBadge(toolId: string): string {
  const combo = toolCombo(toolId);
  if (combo) {
    const key = parseCombo(combo).key;
    return key.length === 1 ? key.toUpperCase() : "";
  }
  return psSlotOf(toolId)?.shortcut ?? "";
}

interface MaskEditModalProps {
  title: string;
  /** Backing image path (best-effort underlay); may be missing in preview. */
  imagePath?: string | null;
  /** Opening context only. Editors display the image path, then commit back
   * through the caller; node-output preview targets stay outside this editor. */
  nodeId?: string | null;
  initial: unknown;
  /** Magic-wand colour tolerance from the node's param. */
  wandTolerance: number;
  onCommit: (edits: MaskDocument, state: EditState) => void;
  onClose: () => void;
  /** Draft sink: called on every edit so a host can keep the in-progress
   * document across editor remounts (e.g. the image editor's tab switches). */
  onDocChange?: (doc: MaskDocument) => void;
  /** Full draft sink: includes undo/redo snapshots for persistent editor history. */
  onEditStateChange?: (state: EditState) => void;
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
interface ActiveSelection {
  region: [number, number, number, number];
  ellipse: boolean;
  polygon?: [number, number][];
}

function polygonSelection(points: [number, number][]): ActiveSelection {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const region: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
  return { region, ellipse: false, polygon: points };
}

function pointInActiveSelection(point: [number, number], selection: ActiveSelection): boolean {
  if (selection.polygon) return pointInPolygon(point, selection.polygon);
  const [x0, y0, x1, y1] = selection.region;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const [x, y] = point;
  if (x < left || x > right || y < top || y > bottom) return false;
  if (!selection.ellipse) return true;
  const rx = Math.max((right - left) / 2, 1);
  const ry = Math.max((bottom - top) / 2, 1);
  const cx = left + rx;
  const cy = top + ry;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

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
  initial,
  wandTolerance,
  onCommit,
  onClose,
  onDocChange,
  onEditStateChange,
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
  const historyTimeline = useMemo(() => historySnapshots(state), [state]);
  const currentSnapshotIndex = currentHistoryIndex(state);
  const [historyReviewIndex, setHistoryReviewIndex] = useState<number | null>(null);
  const historyReviewSnapshot = historyReviewIndex == null
    ? null
    : historyTimeline.find((snapshot) => snapshot.index === historyReviewIndex) ?? null;
  // Mirror the in-progress document out to the host so it survives remounts
  // (e.g. the image editor's document-tab switches).
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onEditStateChangeRef = useRef(onEditStateChange);
  onEditStateChangeRef.current = onEditStateChange;
  useEffect(() => {
    onDocChangeRef.current?.(state.current);
    onEditStateChangeRef.current?.(state);
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
  const [magneticWidth, setMagneticWidth] = useState(DEFAULT_MAGNETIC_SNAP.width);
  const [magneticContrast, setMagneticContrast] = useState(DEFAULT_MAGNETIC_SNAP.contrast);
  const [magneticFrequency, setMagneticFrequency] = useState(DEFAULT_MAGNETIC_SNAP.frequency);
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
  // Boolean mode the next committed path-selection shape combines with.
  const [pathMode, setPathMode] = useState<"add" | "subtract" | "intersect">("add");
  // PS-style right rail: tabbed dock groups driven by a persisted layout
  // (drag a tab to re-dock it; drag the rail edge to resize).
  const dock = useDockLayout(
    workspace === "image" ? IMAGE_DOCK_STORAGE_KEY : DOCK_STORAGE_KEY,
    workspace === "image" ? IMAGE_DOCK_LAYOUT : DEFAULT_DOCK_LAYOUT,
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Underlay presentation goes through the viewport host (WGPU migration
  // Phase 2): editors display the concrete image path they were opened with.
  // A node may open the editor and receive commits back, but it must not turn
  // the editor's main canvas into a node-output preview target. Preview gates
  // can use node_output targets; software-level editors need a stable asset
  // source so the canvas never blanks while node artifacts are registering.
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
  const [lastMarquee, setLastMarquee] = useState<ActiveSelection | null>(null);
  const lastMarqueeRef = useRef(lastMarquee);
  lastMarqueeRef.current = lastMarquee;
  const [workSelection, setWorkSelection] = useState<ActiveSelection | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number; selection: ActiveSelection } | null>(null);
  // Marching ants flow (PS): while a selection is active, the dash phase
  // advances a few times a second and the ants march along the outline —
  // host-side over presented frames and on the canvas fallback alike.
  const [antsPhase, setAntsPhase] = useState(0);
  useEffect(() => {
    if (!lastMarquee) return;
    const timer = window.setInterval(() => setAntsPhase((p) => (p + 2) % 10), 120);
    return () => window.clearInterval(timer);
  }, [lastMarquee]);
  // Edits go through this wrapper, which stamps the active selection as the
  // action's `clip` so rasterisation confines the op to the selection.
  // Whole-mask reshapes (transform / crop / select-all) stay global.
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
  const stateRef = useRef(state);
  stateRef.current = state;
  // Pending pen anchors and anchor re-editing (M2): the path op being
  // re-edited plus a local draft of its anchors, committed as one undoable
  // step on Done / Enter (see usePathEditing).
  const pathEditing = usePathEditing(dispatch, stateRef);
  const {
    penAnchors,
    setPenAnchors,
    editingPath,
    anchorDraft,
    setAnchorDraft,
    penPendingRef,
    editingPathRef,
    startPathEdit,
    commitPathEdit,
    cancelPathEdit,
  } = pathEditing;
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
  const viewportOverlayScene = useMemo<ViewportOverlayScene | null>(
    () =>
      buildViewportOverlayScene({
        workspace,
        frameDims,
        previewing,
        doc: state.current,
        editingPath,
        lastMarquee,
        antsPhase,
        toolId,
        rulerLine,
        colorSamples,
      }),
    [workspace, lastMarquee, antsPhase, frameDims.w, frameDims.h, previewing, state, editingPath, toolId, rulerLine, colorSamples],
  );
  const source = imagePath ?? undefined;
  // Native surface presentation (surface swap): the underlay presents on a
  // surface window placed under the anchor's rect while the view is one the
  // surface can represent — a rotated view or the transparency preview hides
  // it and frames fall back to the PNG transport. The brush/path/marquee
  // canvas is DOM, so it keeps compositing above the hole.
  const underlayAnchorRef = useRef<HTMLDivElement | null>(null);
  // Image-workspace crop: the last confirmed crop step on any visible layer.
  // After confirm, the stage shows only this kept region (PS crop semantics)
  // while the op remains undoable in the edit stack.
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
  // All in-flight pointer gesture state (drags, picked sources, pending
  // loops) — one plain mutable object, mutated at pointer-move rate without
  // re-rendering. See pointerMachine.ts.
  const gestures = useRef(createPointerGestures()).current;
  const magneticEdgeKeyRef = useRef<string | null>(null);
  const magneticEdgePendingKeyRef = useRef<string | null>(null);
  // Canvas navigation (M8): zoom/pan applied as a CSS transform on the stage
  // frame — the render path and pointer→image mapping are untouched by it —
  // plus the derived (settle-debounced) underlay view window, Alt+wheel zoom
  // and Space hold-to-pan (see useCanvasNavigation).
  const nav = useCanvasNavigation(canvasRef, imageTransform, gestures);
  const { view, setView, viewRef, viewBase, targetViewportView, viewportView, spacePan, setSpacePan } = nav;
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
    !overlayOnly && !baseHidden && !view.rotate && !imageTransform && !cropRegion && !gradePreview && !entering && !closing;
  const underlayViewportView = imageTransform || cropRegion ? IDENTITY_VIEW : viewportView;
  // The anchor moves under CSS transforms (view zoom/pan and the layer
  // transform) without firing the resize observer: re-measure on either.
  const placementKey = useMemo(() => ({ view, imageTransform, cropRegion }), [view, imageTransform, cropRegion]);
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
    imageTransform || cropRegion ? null : targetViewportView,
  );
  const underlay = viewport.underlay;
  const presented = viewport.presented;
  const frameView = viewport.frameView;
  const dims = viewport.dims ?? { w: DEFAULT_W, h: DEFAULT_H };
  frameDimsRef.current = dims;
  const activeStudioTarget = useMemo(() => {
    const docRef = { canvasId: "mask-edit-stage", documentId: imagePath ?? "active-document" };
    return resolveActiveTarget(state.current, docRef);
  }, [state.current, imagePath]);
  const targetBounds = useMemo(() => {
    return resolveTargetBounds(state.current, activeStudioTarget, { dims });
  }, [state.current, activeStudioTarget, dims.w, dims.h]);
  const contextActionItems = useMemo(() => {
    if (workspace !== "image") return [];
    return IMAGE_CONTEXT_COMMANDS
      .map((id) => ({ command: getCommand(id), capability: getCommandCapability(id, { doc: state.current, target: activeStudioTarget }) }))
      .filter((item) => item.capability.enabled);
  }, [workspace, state.current, activeStudioTarget]);
  const cropView = useMemo(() => {
    if (!cropRegion) return null;
    const x0 = Math.max(0, Math.min(cropRegion[0], cropRegion[2], dims.w - 1));
    const y0 = Math.max(0, Math.min(cropRegion[1], cropRegion[3], dims.h - 1));
    const x1 = Math.min(dims.w, Math.max(cropRegion[0], cropRegion[2], x0 + 1));
    const y1 = Math.min(dims.h, Math.max(cropRegion[1], cropRegion[3], y0 + 1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    return { region: [x0, y0, x1, y1] as [number, number, number, number] };
  }, [cropRegion, dims.w, dims.h]);

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

  // PS-style brush cursor ring (positioned imperatively on pointer move).
  const brushCursorEl = useRef<HTMLDivElement | null>(null);
  // PS selection semantics: an active marquee is only a selection — it never
  // lands on the edit stack itself. Instead, edit steps recorded while it is
  // active carry it as their `clip`, so replay confines their effect to the
  // Floating size panel beside the closed marquee shape: pending work
  // selections show as solid outlines; established selections show marching
  // ants. The panel reads whichever one is currently present.
  const marqueeSelection = workSelection ?? lastMarquee;
  const [marqueeDraft, setMarqueeDraft] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    if (marqueeSelection) {
      const [x0, y0, x1, y1] = marqueeSelection.region;
      setMarqueeDraft({ w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
    }
  }, [marqueeSelection]);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("polygon");
  const [shapeSides, setShapeSides] = useState(5);
  // Crop tool: the adjustable rect / perspective-quad drafts and the floating
  // panel's controls (see useCropTool).
  const crop = useCropTool(dims, dispatch);
  const { quadDraft, setQuadDraft, cropDraft, setCropDraft, setCropAspect, cropLock, confirmCropDraft } = crop;
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
  // Screen-mode cycle (PS `F`): 0 full UI → 1 panels hidden → 2 canvas only.
  const [screenMode, setScreenMode] = useState<0 | 1 | 2>(0);

  const tool = maskTool(toolId) ?? MASK_TOOLS[0];

  // The pointer's angle (degrees) about the canvas centre on screen.
  const pointerAngle = (e: React.PointerEvent): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  };

  const activeLayerKind = state.current.layers[state.current.active]?.kind ?? "mask";

  // Dialog drafts: the free-transform panel (Ctrl+T), fill dialog (Shift+F5)
  // and Image Size dialog (Ctrl+Alt+I) clusters (see useDialogDrafts).
  const dialogs = useDialogDrafts(dims, dispatch, stateRef);
  const {
    transformDraft,
    setTransformDraft,
    editingTransform,
    closeTransformPanel,
    fillDraft,
    setFillDraft,
    imageSizeDraft,
    setImageSizeDraft,
    openFreeTransform: openFreeTransformPanel,
    openFillDialog,
  } = dialogs;

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
    openFreeTransformPanel();
  };

  const disabledMenuAction = () => {};
  const selectionMenuItems: MenuItem[] = [
    { label: "取消选择", onClick: () => setLastMarquee(null) },
    { label: "选择反向", onClick: disabledMenuAction, disabled: true },
    { label: "羽化...", onClick: disabledMenuAction, disabled: true },
    { label: "选择并遮住...", onClick: disabledMenuAction, disabled: true },
    { label: "存储选区...", onClick: disabledMenuAction, disabled: true },
    { label: "建立工作路径...", onClick: disabledMenuAction, disabled: true },
    { label: "通过拷贝的图层", onClick: disabledMenuAction, disabled: true },
    { label: "通过剪切的图层", onClick: disabledMenuAction, disabled: true },
    { label: "新建图层...", onClick: disabledMenuAction, disabled: true },
    { label: "自由变换", onClick: openFreeTransform },
    { label: "变换选区", onClick: disabledMenuAction, disabled: true },
    { label: "填充...", onClick: openFillDialog },
    { label: "描边...", onClick: disabledMenuAction, disabled: true },
    { label: "内容识别填充...", onClick: disabledMenuAction, disabled: true },
    { label: "生成式填充...", onClick: disabledMenuAction, disabled: true },
    { label: "删除和填充选区", onClick: disabledMenuAction, disabled: true },
  ];

  const pathMenuItems: MenuItem[] = [
    {
      label: "建立选区",
      onClick: () => {
        if (pathMenu) {
          setLastMarquee(pathMenu.selection);
          setWorkSelection(null);
        }
      },
    },
    { label: "取消路径", onClick: () => setWorkSelection(null) },
  ];

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
    tool_lasso: () => selectTool("magnetic_lasso"),
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
      else if (workSelection) setWorkSelection(null);
      else dispatch({ type: "clear" });
    },
    select_all: () => dispatch({ type: "op", op: { type: "select_all" } }),
    delete_selection: () => dispatch({ type: "op", op: { type: "delete" } }),
    reselect: () => dispatch({ type: "reselect" }),
    duplicate: () => {
      // PS Ctrl+J: with a selection, Layer Via Copy — the new layer holds
      // the selected region (its mask) and the marching ants drop.
      const selection = lastMarqueeRef.current;
      dispatch({ type: "layer_duplicate", ...(selection ? { selection } : null) });
      if (selection) setLastMarquee(null);
    },
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
    (e: { clientX: number; clientY: number }): [number, number] => {
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

  const workSelectionAtPoint = (pt: [number, number]): ActiveSelection | null => {
    return workSelection && pointInActiveSelection(pt, workSelection) ? workSelection : null;
  };

  const openSelectionContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = toImage(e);
    const selection = lastMarqueeRef.current;
    if (selection && pointInActiveSelection(pt, selection)) {
      setPathMenu(null);
      setSelectionMenu({ x: e.clientX, y: e.clientY });
      return;
    }
    const pendingSelection = workSelectionAtPoint(pt);
    if (pendingSelection) {
      setSelectionMenu(null);
      setPathMenu({ x: e.clientX, y: e.clientY, selection: pendingSelection });
      return;
    }
    setSelectionMenu(null);
    setPathMenu(null);
  };

  const viewportHost = viewport.host;
  const magneticUnderlay = baseHidden ? null : (gradedUnderlay ?? underlay);
  // Magnetic lasso: prewarm and cache the visible window's edge map. Pointer
  // down can reuse a same-window map immediately; stale async readbacks are
  // ignored so old pixels never drive a new drag.
  const captureEdgeMap = useCallback(() => {
    const winW = Math.max(1, Math.round(dims.w / frameView.zoom));
    const winH = Math.max(1, Math.round(dims.h / frameView.zoom));
    const offX = Math.round(frameView.panX * dims.w);
    const offY = Math.round(frameView.panY * dims.h);
    const sourceKey = magneticUnderlay
      ? `underlay:${magneticUnderlay.length}:${magneticUnderlay.slice(0, 96)}:${magneticUnderlay.slice(-96)}`
      : `host:${presented ? 1 : 0}:${viewportHost?.isOpen ? 1 : 0}`;
    const key = `${sourceKey}:${winW}x${winH}:${offX},${offY}`;
    if (gestures.magneticEdge && magneticEdgeKeyRef.current === key) return;
    if (magneticEdgePendingKeyRef.current === key) return;
    gestures.magneticEdge = null;
    magneticEdgeKeyRef.current = null;
    magneticEdgePendingKeyRef.current = key;

    const commitEdgeMap = (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number) => {
      if (magneticEdgePendingKeyRef.current !== key) return;
      gestures.magneticEdge = buildEdgeMap(pixels, width, height, offX, offY);
      magneticEdgeKeyRef.current = key;
      magneticEdgePendingKeyRef.current = null;
    };
    const failEdgeMap = () => {
      if (magneticEdgePendingKeyRef.current === key) magneticEdgePendingKeyRef.current = null;
    };

    if (!magneticUnderlay) {
      if (!presented || !viewportHost || !viewportHost.isOpen) {
        failEdgeMap();
        return;
      }
      viewportHost
        .readPixels()
        .then((px) => {
          // The readback is at the frame's own resolution; only a readback
          // matching the window maps 1:1 onto image-space coordinates.
          if (px.width !== winW || px.height !== winH) {
            failEdgeMap();
            return;
          }
          commitEdgeMap(px.pixels, px.width, px.height);
        })
        .catch(() => {
          failEdgeMap();
        });
      return;
    }
    const img = new Image();
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = winW;
      off.height = winH;
      const ctx = off.getContext("2d");
      if (!ctx) {
        failEdgeMap();
        return;
      }
      ctx.drawImage(img, 0, 0, winW, winH);
      const { data } = ctx.getImageData(0, 0, winW, winH);
      commitEdgeMap(data, winW, winH);
    };
    img.onerror = failEdgeMap;
    img.src = magneticUnderlay;
  }, [magneticUnderlay, presented, viewportHost, frameView, dims.w, dims.h]);

  useEffect(() => {
    if (toolId !== "magnetic_lasso") return;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleId = idleWindow.requestIdleCallback?.(() => captureEdgeMap(), { timeout: 300 });
    if (idleId != null) return () => idleWindow.cancelIdleCallback?.(idleId);
    const timer = window.setTimeout(captureEdgeMap, 0);
    return () => window.clearTimeout(timer);
  }, [toolId, captureEdgeMap]);

  // Redraw the overlay: committed brush strokes and the in-progress
  // stroke/marquee (see stageScene's paintStage). The underlay presents
  // separately (an image layer under this canvas at the rendered window's
  // rect), so the canvas stays transparent where the image shows through.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    paintStage(ctx, {
      workspace,
      dims,
      overlayOnly,
      underlay,
      presented,
      previewing,
      doc: state.current,
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
      cropRegion: null,
      targetBounds: workspace === "image" ? targetBounds : null,
      lastMarquee,
      workSelection: penAnchors.length > 0 ? null : workSelection,
      antsPhase,
      gestures,
    });
  }, [workspace, dims.w, dims.h, cropRegion, overlayOnly, underlay, presented, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, targetBounds, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy, shapeKind, shapeSides, colorSamples, rulerLine, quadDraft, cropDraft, lastMarquee, workSelection, antsPhase]);

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
    if (workspace === "image") {
      setWorkSelection(polygonSelection(pts));
      setLastMarquee(null);
      setPathMenu(null);
      return;
    }
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

  const runContextCommand = useCallback((id: CommandId) => {
    runMaskEditorCommand(id, {
      doc: stateRef.current.current,
      target: activeStudioTarget,
      dispatch,
      beforeStructuralChange: () => {
        if (editingPathRef.current != null) cancelPathEdit();
      },
      setToolId,
    });
  }, [activeStudioTarget, cancelPathEdit, editingPathRef, stateRef, setToolId]);

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
    magnetic: { width: magneticWidth, contrast: magneticContrast, frequency: magneticFrequency },
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
    setWorkSelection,
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
    const ellipse = marqueeSelection ? marqueeSelection.ellipse : toolId === "ellipse";
    const cw = Math.max(2, Math.min(Math.round(w), dims.w));
    const ch = Math.max(2, Math.min(Math.round(h), dims.h));
    const x0 = Math.min(marqueeSelection?.region[0] ?? 0, dims.w - cw);
    const y0 = Math.min(marqueeSelection?.region[1] ?? 0, dims.h - ch);
    const region: [number, number, number, number] = [x0, y0, x0 + cw, y0 + ch];
    setLastMarquee({ region, ellipse });
    setWorkSelection(null);
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
                <button className="primary" onClick={() => { onCommit(state.current, state); requestClose(); }} title={t("mask.applyTitle")}>
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
            hiddenSlotIds={workspace === "image" ? SELECTION_TOP_SLOT_IDS : []}
            faces={slotFaces}
            onPickFace={(slotId, id) => setSlotFaces((f) => ({ ...f, [slotId]: id }))}
            paintMode={tool.mode === "subtract" || (tool.kind === "path" && pathMode === "subtract") ? "subtract" : "add"}
            fgColor={fgColor}
            bgColor={bgColor}
            onPickColor={setColorPicker}
            onSwapColors={swapColors}
            onResetColors={resetColors}
          />

          {workspace === "image" ? (
            <div className="mask-selection-top-strip" role="toolbar" aria-label="选区工具">
              {SELECTION_TOP_TOOLS.map((id) => {
                const mt = maskTool(id);
                if (!mt) return null;
                const active = toolId === id;
                const badge = toolKeyBadge(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`mask-selection-tool${active ? " active" : ""}`}
                    title={mt.label}
                    aria-label={mt.label}
                    onClick={() => onToolClick(mt)}
                  >
                    <ToolIcon id={id} />
                    {badge ? <kbd className="mask-selection-tool-key" aria-hidden="true">{badge}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          <MaskStage
            canvasRef={canvasRef}
            dims={dims}
            view={view}
            underlay={baseHidden ? null : (gradedUnderlay ?? underlay)}
            presented={presented}
            baseHidden={baseHidden}
            fallbackDims={viewport.dims == null}
            cropView={cropView}
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
            onContextMenu={openSelectionContextMenu}
            brushCursor={usesBrushCursor && !spacePan ? { diameter: brushSize * 2 } : null}
            brushCursorRef={brushCursorEl}
            contextActionBar={
              workspace === "image" ? (
                <ContextActionBar
                  bounds={targetBounds}
                  dims={dims}
                  items={contextActionItems}
                  onCommand={runContextCommand}
                />
              ) : null
            }
          />
          {selectionMenu ? (
            <ContextMenu
              x={selectionMenu.x}
              y={selectionMenu.y}
              items={selectionMenuItems}
              onClose={() => setSelectionMenu(null)}
            />
          ) : null}
          {pathMenu ? (
            <ContextMenu
              x={pathMenu.x}
              y={pathMenu.y}
              items={pathMenuItems}
              onClose={() => setPathMenu(null)}
            />
          ) : null}

          {/* Floating selection-size panel (see MarqueeSizePanel). */}
          {marqueeSelection && !gestures.marquee && tool.kind === "marquee" && canvasRef.current ? (
            <MarqueeSizePanel
              region={marqueeSelection.region}
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
              magneticWidth={magneticWidth}
              setMagneticWidth={setMagneticWidth}
              magneticContrast={magneticContrast}
              setMagneticContrast={setMagneticContrast}
              magneticFrequency={magneticFrequency}
              setMagneticFrequency={setMagneticFrequency}
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
                doc={state.current}
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
                  label: t("mask.history", { count: historyTimeline.length }),
                  content: (
                    <HistoryPanel
                      snapshots={historyTimeline}
                      onReviewSnapshot={setHistoryReviewIndex}
                    />
                  ),
                },
              };
              return dock.layout.groups.map((group, gi) => {
                const isImageWorkspace = workspace === "image";
                const isTopImageAdjustments = isImageWorkspace && gi === 0 && group.tabs.length === 1;
                const isBottomImageLayers = isImageWorkspace && gi === dock.layout.groups.length - 1;
                return (
                  <PanelDock
                    key={gi}
                    grow={gi === dock.layout.groups.length - 1}
                    hideTabs={isTopImageAdjustments}
                    className={
                      isTopImageAdjustments
                        ? "image-adjustments-dock"
                        : isBottomImageLayers
                          ? "image-layers-dock"
                          : undefined
                    }
                    active={group.active}
                    onSelect={dock.onSelect}
                    onTabDrop={(id, index) => dock.onTabDrop(id, gi, index)}
                    panels={group.tabs.flatMap((id) => panelDefs[id] ?? [])}
                  />
                );
              });
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
        {historyReviewSnapshot ? (
          <HistorySnapshotDialog
            snapshot={historyReviewSnapshot}
            currentIndex={currentSnapshotIndex}
            onClose={() => setHistoryReviewIndex(null)}
            onRestore={(index) => {
              cancelPathEdit();
              closeTransformPanel();
              setHistoryReviewIndex(null);
              dispatch({ type: "history_jump", index });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
