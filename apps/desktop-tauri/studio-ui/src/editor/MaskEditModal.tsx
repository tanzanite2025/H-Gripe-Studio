import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNodeOutputSource } from "../viewport/useNodeOutputSource";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import {
  MASK_TOOLS,
  maskTool,
  DEFAULT_TOOL_ID,
  shapeVertices,
  type MaskTool,
  type PaintTarget,
  type ShapeKind,
} from "./maskTools";
import { useShortcutScope, type ShortcutHandlers } from "../shortcuts";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS } from "../shortcuts/scopes/maskEdit";
import { useT } from "../i18n";
import { PreviewLane } from "../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "./maskMorphology";
import { FIT_VIEW, ZOOM_STEP, panBy, rotateTo, zoom100, zoomAt, zoomIn, zoomOut, type CanvasView } from "./canvasView";
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
  LayerAdjustment,
  MaskDocument,
} from "../types/production";
import { isBrushOp, isPathOp } from "../types/production";
import { maskEditReducer, type FillDraft } from "./maskEditModal/actions";
import {
  paintAnchorDraft,
  paintCloneSource,
  paintDragArrow,
  paintLassoLoop,
  paintMarquee,
  paintPath,
  paintPenAnchors,
  paintPreviewOverlay,
  paintQuickMask,
  paintRetouchBand,
  paintSamPoints,
  paintShapeDraft,
  paintStroke,
  retouchBandColor,
} from "./maskEditModal/stagePainter";
import { PanelDock, type DockPanel } from "./maskEditModal/PanelDock";
import { useDockLayout, type DockLayoutState } from "./maskEditModal/dockLayout";
import "./maskEditModal/maskEditModal.css";
import { MaskToolbar } from "./maskEditModal/MaskToolbar";
import { MaskStage } from "./maskEditModal/MaskStage";
import { ToolOptionsPanel } from "./maskEditModal/ToolOptionsPanel";
import { LayersPanel } from "./maskEditModal/LayersPanel";
import { HistoryPanel } from "./maskEditModal/HistoryPanel";
import { InfoPanel } from "./maskEditModal/InfoPanel";
import { PropertiesPanel } from "./maskEditModal/PropertiesPanel";

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
  /** Optional bar content (e.g. the unified editor's tool-group switcher). */
  headerExtra?: ReactNode;
}

let strokeSeq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${strokeSeq++}`;

// Default right-rail dock layout, mirroring PS: a 属性-style top group
// (tool options / properties / info) over a growing 图层 group (layers /
// history). Users re-dock tabs by dragging; the result persists.
const DOCK_STORAGE_KEY = "hgripe.studio.maskDock.v1";
const DEFAULT_DOCK_LAYOUT: DockLayoutState = {
  groups: [
    { tabs: ["options", "properties", "info"], active: "options" },
    { tabs: ["layers", "history"], active: "layers" },
  ],
  railWidth: 240,
};

export function MaskEditModal({
  title,
  imagePath,
  nodeId,
  initial,
  wandTolerance,
  onCommit,
  onClose,
  headerExtra,
}: MaskEditModalProps) {
  const t = useT();
  const [state, dispatch] = useReducer(maskEditReducer, initial, initEditState);
  const [toolId, setToolId] = useState<string>(DEFAULT_TOOL_ID);
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
  // PS-style right rail: tabbed dock groups driven by a persisted layout
  // (drag a tab to re-dock it; drag the rail edge to resize).
  const dock = useDockLayout(DOCK_STORAGE_KEY, DEFAULT_DOCK_LAYOUT);

  // Underlay presentation goes through the viewport host (WGPU migration
  // Phase 2): the image is targeted by reference — a `node_output` target
  // when a node id is given, a registered image resource otherwise — and the
  // host renders the frame; in browser preview it stays null and we draw a
  // checkerboard so the user can still paint in the correct pixel space.
  const source = useNodeOutputSource(nodeId, imagePath);
  const viewport = useViewportUnderlay("image_edit", source, 1280);
  const underlay = viewport.underlay;
  const dims = viewport.dims ?? { w: DEFAULT_W, h: DEFAULT_H };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // In-progress freehand stroke (image-space points), null when not drawing.
  const drawing = useRef<{ points: [number, number][] } | null>(null);
  const marquee = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // In-progress shape drag (image-space bounding box); committed on release
  // as an ordinary vector path step built from the chosen shape's vertices.
  const shapeDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("polygon");
  const [shapeSides, setShapeSides] = useState(5);
  // In-progress move-tool drag (image-space): committed as a `transform` op.
  const moveDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // In-progress gradient drag (M10): the start → end ramp vector; Alt at
  // pointer-down records a subtract ramp.
  const gradientDrag = useRef<{ start: [number, number]; end: [number, number]; subtract: boolean } | null>(null);
  // Clone-stamp source point (image-space), picked by Alt+click; null until
  // picked — painting without a source is inert (PS behaviour).
  const cloneSource = useRef<[number, number] | null>(null);
  // Dodge / burn direction of the in-progress stroke (Alt at pointer-down
  // burns — darkens — instead of dodging).
  const dodgeBurnMode = useRef<"dodge" | "burn">("dodge");
  // Eyedropper sample: the image colour under the last click, as `#rrggbb`;
  // null until sampled (or when there is no underlay to read from).
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  // Pending pen anchors (image-space) awaiting a close-path click.
  const [penAnchors, setPenAnchors] = useState<[number, number][]>([]);
  // Anchor re-editing (M2): index of the path op being re-edited plus a local
  // draft of its anchors; committed as one undoable step on Done / Enter.
  const [editingPath, setEditingPath] = useState<number | null>(null);
  const [anchorDraft, setAnchorDraft] = useState<EditPathPoint[] | null>(null);
  const draggingAnchor = useRef<number | null>(null);
  const [, forceRedraw] = useState(0);

  // Preview lane for morphology ops: a live, best-effort proxy render of
  // grow/shrink/feather/smooth so a slider drag shows roughly what Apply will
  // do — off the global run lock, latest-wins so rapid drags don't pile up
  // (docs/cards/editor-resource-model.md § "Four lanes" → Preview).
  const previewLane = useRef(new PreviewLane());
  const [preview, setPreview] = useState<ProxyMask | null>(null);
  // Persistent proxy render cache (M7): per-layer surfaces are reused across
  // rebuilds and the composite recomputes dirty tiles only, so a slider drag
  // or brush commit on a large document stays cheap.
  const proxyCache = useRef(new ProxyLayerCache());
  // Canvas navigation (M8): zoom/pan applied as a CSS transform on the canvas
  // — the render path and pointer→image mapping are untouched by it.
  const [view, setView] = useState<CanvasView>(FIT_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
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
  const previewing = isPreviewableOp(toolId) && preview != null;
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
    if (id !== "pen") setPenAnchors([]);
    cancelPathEdit();
    setToolId(id);
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
  const shortcutHandlers: ShortcutHandlers = {
    tool_brush: () => selectTool("brush"),
    tool_eraser: () => selectTool("eraser"),
    tool_wand: () => selectTool("wand"),
    tool_pen: () => setToolId("pen"),
    tool_lasso: () => selectTool("lasso"),
    tool_rect: () => selectTool("rect"),
    tool_ellipse: () => selectTool("ellipse"),
    tool_gradient: () => selectTool("gradient"),
    tool_move: () => selectTool("move"),
    tool_crop: () => selectTool("crop"),
    free_transform: () => openFreeTransform(),
    tool_path_select: () => {
      // PS `A` (direct selection): re-edit the anchors of the last path op.
      if (editingPathRef.current != null) {
        commitPathEdit();
        return;
      }
      const ops = activeOps(stateRef.current.current);
      for (let i = ops.length - 1; i >= 0; i--) {
        if (isPathOp(ops[i])) {
          startPathEdit(i);
          return;
        }
      }
      return false;
    },
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    redo_alt: () => dispatch({ type: "redo" }),
    step_backward: () => dispatch({ type: "undo" }),
    clear: () => dispatch({ type: "clear" }),
    select_all: () => dispatch({ type: "op", op: { type: "select_all" } }),
    delete_selection: () => dispatch({ type: "op", op: { type: "delete" } }),
    reselect: () => dispatch({ type: "reselect" }),
    duplicate: () => dispatch({ type: "layer_duplicate" }),
    invert: () => dispatch({ type: "op", op: { type: "invert" } }),
    brush_smaller: () => setBrushSize((s) => Math.max(1, s - 4)),
    brush_larger: () => setBrushSize((s) => Math.min(96, s + 4)),
    brush_softer: () => setBrushHardness((h) => Math.max(0, Math.round((h - 0.25) * 100) / 100)),
    brush_harder: () => setBrushHardness((h) => Math.min(1, Math.round((h + 0.25) * 100) / 100)),
    default_colors: () => {
      // PS `D` (default colours): back to the default brush / add semantics.
      selectTool(DEFAULT_TOOL_ID);
      setPathMode("add");
      setPaintTarget("layer");
    },
    quick_mask: () => setQuickMask((v) => !v),
    tool_healing: () => selectTool("heal"),
    tool_clone: () => selectTool("clone"),
    tool_history_brush: () => selectTool("history_brush"),
    tool_dodge_burn: () => selectTool("dodge_burn"),
    tool_eyedropper: () => selectTool("eyedropper"),
    tool_shape: () => selectTool("shape"),
    tool_hand: () => selectTool("hand"),
    tool_rotate_view: () => selectTool("rotate_view"),
    tool_zoom: () => selectTool("zoom"),
    screen_mode: () => setScreenMode((m) => ((m + 1) % 3) as 0 | 1 | 2),
    pan_space: () => setSpacePan(true),
    zoom_in: () => setView((v) => zoomIn(v, ...viewBase())),
    zoom_out: () => setView((v) => zoomOut(v, ...viewBase())),
    zoom_fit: () => setView(FIT_VIEW),
    zoom_100: () => setView((v) => zoom100(v, dims.w, ...viewBase())),
    adjust_levels: () => dispatch({ type: "layer_add_adjustment", adjType: "levels" }),
    adjust_curve: () => dispatch({ type: "layer_add_adjustment", adjType: "curve" }),
    fill_dialog: () => setFillDraft({ mode: "add", opacity: 100 }),
    feather_dialog: () => {
      // The feather "dialog" is the existing preview lane: pick the radius
      // with the amount slider, then Apply commits a revisable `feather` op.
      selectTool("feather");
    },
    swap_mode: () => {
      if (toolId === "brush") setToolId("eraser");
      else if (toolId === "eraser") setToolId("brush");
      else if (tool.kind === "path") setPathMode((m) => (m === "add" ? "subtract" : "add"));
    },
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
  // the thumbnail onto an offscreen canvas at document size. Async (the data
  // URL decodes first); a no-op when there is no underlay to read from.
  const sampleUnderlay = useCallback(
    (pt: [number, number]) => {
      if (!underlay) return;
      const img = new Image();
      img.onload = () => {
        const off = document.createElement("canvas");
        off.width = dims.w;
        off.height = dims.h;
        const ctx = off.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, dims.w, dims.h);
        const x = Math.min(dims.w - 1, Math.max(0, Math.round(pt[0])));
        const y = Math.min(dims.h - 1, Math.max(0, Math.round(pt[1])));
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        setSampledColor(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
      };
      img.src = underlay;
    },
    [underlay, dims.w, dims.h],
  );

  // Redraw the overlay: underlay (optional), committed brush strokes, and the
  // in-progress stroke/marquee.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    ctx.clearRect(0, 0, dims.w, dims.h);

    if (!overlayOnly && underlay) {
      const img = new Image();
      img.src = underlay;
      try {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(img, 0, 0, dims.w, dims.h);
        ctx.globalAlpha = 1;
      } catch {
        /* image may not be ready synchronously; the strokes still render */
      }
    } else if (overlayOnly) {
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
          else if (isPathOp(op)) paintPath(ctx, op);
        });
      });
    }
    state.current.matte_strokes.forEach((s) => paintStroke(ctx, s, "matte"));
    const live = drawing.current;
    if (live) {
      if (tool.kind === "path") {
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

    if (tool.kind === "clone" && cloneSource.current) paintCloneSource(ctx, cloneSource.current);
    if (editingPath != null && anchorDraft) paintAnchorDraft(ctx, anchorDraft, draggingAnchor.current);
    if (penAnchors.length > 0) paintPenAnchors(ctx, penAnchors);
    paintSamPoints(ctx, state.current.points);
    if (previewing && preview) paintPreviewOverlay(ctx, preview, dims.w, dims.h);
    if (quickMask && quickProxy) paintQuickMask(ctx, quickProxy, dims.w, dims.h);

    const md = moveDrag.current ?? gradientDrag.current;
    if (md) paintDragArrow(ctx, md.start, md.end);
    const sd = shapeDrag.current;
    if (sd) paintShapeDraft(ctx, shapeKind, sd.start, sd.end, shapeSides, brushSize);
    const mq = marquee.current;
    if (mq) paintMarquee(ctx, mq.start, mq.end, tool.id === "ellipse");
  }, [dims.w, dims.h, underlay, overlayOnly, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy, shapeKind, shapeSides]);

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

  // Commit a closed pen / lasso path (straight anchors; no handles from the UI).
  const commitPath = (toolName: "pen" | "lasso", pts: [number, number][]) => {
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
    commitPath("pen", penAnchors);
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
      // Anchor re-editing mode: grab the nearest anchor square, if any.
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const [x, y] = toImage(e);
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
    if (tool.kind === "path") {
      if (tool.id === "lasso") {
        drawing.current = { points: [pt] };
        forceRedraw((n) => n + 1);
        return;
      }
      // Pen: clicking near the first anchor closes the path.
      const closeRadius = Math.max(8, dims.w * 0.01);
      const first = penAnchors[0];
      if (penAnchors.length >= 3 && first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) <= closeRadius) {
        closePenPath();
        return;
      }
      setPenAnchors((prev) => [...prev, pt]);
      return;
    }
    if (tool.kind === "clone") {
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
      if (tool.kind === "dodge") dodgeBurnMode.current = e.altKey ? "burn" : "dodge";
      drawing.current = { points: [pt] };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "transform") {
      moveDrag.current = { start: pt, end: pt };
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
      // Magic-wand: record a seeded flood-fill op for the backend.
      dispatch({ type: "op", op: { type: "wand", amount: tolerance, region: pt } });
    } else if (tool.kind === "sample") {
      // Eyedropper: read the underlay colour under the click — a pure view
      // read, nothing is recorded on the document.
      sampleUnderlay(pt);
    } else if (tool.kind === "point") {
      // SAM 2 point prompt: left button includes (positive), right button
      // excludes (negative). Right-click's context menu is suppressed below.
      const label = e.button === 2 ? 0 : 1;
      dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
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
    if (draggingAnchor.current != null) {
      const [x, y] = toImage(e);
      const idx = draggingAnchor.current;
      setAnchorDraft((prev) => (prev ? prev.map((p, i) => (i === idx ? { ...p, x, y } : p)) : prev));
      return;
    }
    if (drawing.current) {
      drawing.current.points.push(toImage(e));
      redraw();
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
    if (rotateDrag.current) {
      rotateDrag.current = null;
      return;
    }
    if (panDrag.current) {
      panDrag.current = null;
      return;
    }
    if (draggingAnchor.current != null) {
      draggingAnchor.current = null;
      forceRedraw((n) => n + 1);
      return;
    }
    if (drawing.current) {
      const pts = drawing.current.points;
      drawing.current = null;
      if (tool.id === "lasso") {
        commitPath("lasso", pts);
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
      const stroke: BrushStroke = {
        id: nextId("stroke"),
        mode: tool.mode ?? "add",
        radius: brushSize,
        points: pts,
        // Soft-brush fields are recorded only for soft strokes so hard
        // strokes keep the legacy shape (and byte-identical replay).
        ...(brushHardness < 1 || brushFlow < 1
          ? { hardness: brushHardness, flow: brushFlow, spacing: brushSpacing }
          : null),
      };
      const toMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
      dispatch({ type: toMatte ? "matte_stroke" : "stroke", stroke });
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
        dispatch({ type: "op", op: { type: tool.id, region } });
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
    if (t.id !== "pen") setPenAnchors([]);
    cancelPathEdit();
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

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className={`media-viewer mask-edit${screenMode ? ` mask-screen-${screenMode}` : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={title}>
            {title} <span className="muted">· {t("mask.editor")}</span>
          </span>
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
            <button className={overlayOnly ? "active" : ""} onClick={() => setOverlayOnly((v) => !v)} title={t("mask.togglePreviewTitle")}>
              {overlayOnly ? t("mask.showImage") : t("mask.maskOnly")}
            </button>
            <button className={quickMask ? "active" : ""} onClick={() => setQuickMask((v) => !v)} title={t("mask.quickMaskTitle")}>
              {t("mask.quickMask")}
            </button>
            <button className="primary" onClick={() => { onCommit(state.current); onClose(); }} title={t("mask.applyTitle")}>
              {t("mask.apply")}
            </button>
            <button onClick={onClose} title={t("mask.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

        <div className="mask-edit-body" style={{ "--mask-rail-w": `${dock.layout.railWidth}px` } as CSSProperties}>
          <MaskToolbar toolId={toolId} onToolClick={onToolClick} />

          <MaskStage
            canvasRef={canvasRef}
            dims={dims}
            view={view}
            spacePan={spacePan}
            toolId={tool.id}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />

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
                properties: {
                  id: "properties",
                  label: t("mask.panelProperties"),
                  content: <PropertiesPanel adjustment={activeAdjustment} patchAdjustment={patchAdjustment} />,
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
      </div>
    </div>
  );
}
