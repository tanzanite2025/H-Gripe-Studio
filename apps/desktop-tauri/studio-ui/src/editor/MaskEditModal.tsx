import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { generateThumbnail } from "../bridge/tauri";
import {
  MASK_TOOLS,
  maskTool,
  toolTargets,
  DEFAULT_TOOL_ID,
  type MaskTool,
  type PaintTarget,
} from "./maskTools";
import { localizeTool } from "./maskToolsI18n";
import { useShortcutScope, comboLabel, type ShortcutHandlers } from "../shortcuts";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS, toolCombo } from "../shortcuts/scopes/maskEdit";
import { LangContext, useT } from "../i18n";
import { PreviewLane } from "../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "./maskMorphology";
import { FIT_VIEW, ZOOM_STEP, isFitView, panBy, viewTransform, zoom100, zoomAt, zoomIn, zoomOut, type CanvasView } from "./canvasView";
import {
  addAdjustmentLayer,
  addBrushStroke,
  addMatteStroke,
  addOperation,
  addPath,
  addPoint,
  activeOps,
  addLayer,
  canRedo,
  canUndo,
  clearEdits,
  duplicateLayer,
  editCount,
  initEditState,
  redo,
  reselect,
  removeLayer,
  removeOp,
  setActiveLayer,
  setLayerBlend,
  setLayerOpacity,
  toggleLayerVisible,
  toggleOp,
  undo,
  updateLayerAdjustment,
  updateOpAmount,
  updateOpTransform,
  updatePathAnchors,
  type EditState,
  type TransformParams,
} from "./maskEdit";
import type {
  AdjustmentType,
  BrushStroke,
  EditOp,
  EditPath,
  EditPathPoint,
  LayerAdjustment,
  LayerBlend,
  MaskDocument,
  MaskOperation,
  PointPrompt,
} from "../types/production";
import { isBrushOp, isPathOp } from "../types/production";

// Default logical canvas size when no backing image is available (browser
// preview mocks the backend, so the connected image often has no decodable
// thumbnail). Edits are recorded in this pixel space and the backend rasterises
// them against the real image on run.
const DEFAULT_W = 960;
const DEFAULT_H = 640;

type Action =
  | { type: "stroke"; stroke: BrushStroke }
  | { type: "matte_stroke"; stroke: BrushStroke }
  | { type: "op"; op: MaskOperation }
  | { type: "point"; point: PointPrompt }
  | { type: "path"; path: EditPath }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" }
  | { type: "reselect" }
  | { type: "layer_duplicate" }
  | { type: "remove_op"; index: number }
  | { type: "toggle_op"; index: number }
  | { type: "op_amount"; index: number; amount: number }
  | { type: "op_transform"; index: number; params: TransformParams }
  | { type: "path_anchors"; index: number; points: EditPathPoint[] }
  | { type: "layer_add" }
  | { type: "layer_add_adjustment"; adjType: AdjustmentType }
  | { type: "layer_adjustment"; index: number; adjustment: LayerAdjustment }
  | { type: "layer_remove"; index: number }
  | { type: "layer_active"; index: number }
  | { type: "layer_visible"; index: number }
  | { type: "layer_opacity"; index: number; opacity: number }
  | { type: "layer_blend"; index: number; blend: LayerBlend };

function reducer(state: EditState, action: Action): EditState {
  switch (action.type) {
    case "stroke":
      return addBrushStroke(state, action.stroke);
    case "matte_stroke":
      return addMatteStroke(state, action.stroke);
    case "op":
      return addOperation(state, action.op);
    case "point":
      return addPoint(state, action.point);
    case "path":
      return addPath(state, action.path);
    case "undo":
      return undo(state);
    case "redo":
      return redo(state);
    case "clear":
      return clearEdits(state);
    case "reselect":
      return reselect(state);
    case "layer_duplicate":
      return duplicateLayer(state);
    case "remove_op":
      return removeOp(state, action.index);
    case "toggle_op":
      return toggleOp(state, action.index);
    case "op_amount":
      return updateOpAmount(state, action.index, action.amount);
    case "op_transform":
      return updateOpTransform(state, action.index, action.params);
    case "path_anchors":
      return updatePathAnchors(state, action.index, action.points);
    case "layer_add":
      return addLayer(state);
    case "layer_add_adjustment":
      return addAdjustmentLayer(state, action.adjType);
    case "layer_adjustment":
      return updateLayerAdjustment(state, action.index, action.adjustment);
    case "layer_remove":
      return removeLayer(state, action.index);
    case "layer_active":
      return setActiveLayer(state, action.index);
    case "layer_visible":
      return toggleLayerVisible(state, action.index);
    case "layer_opacity":
      return setLayerOpacity(state, action.index, action.opacity);
    case "layer_blend":
      return setLayerBlend(state, action.index, action.blend);
  }
}

interface MaskEditModalProps {
  title: string;
  /** Backing image path (best-effort underlay); may be missing in preview. */
  imagePath?: string | null;
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

export function MaskEditModal({
  title,
  imagePath,
  initial,
  wandTolerance,
  onCommit,
  onClose,
  headerExtra,
}: MaskEditModalProps) {
  const t = useT();
  const lang = useContext(LangContext);
  const [state, dispatch] = useReducer(reducer, initial, initEditState);
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

  const [underlay, setUnderlay] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: DEFAULT_W, h: DEFAULT_H });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // In-progress freehand stroke (image-space points), null when not drawing.
  const drawing = useRef<{ points: [number, number][] } | null>(null);
  const marquee = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // In-progress move-tool drag (image-space): committed as a `transform` op.
  const moveDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
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

  const tool = maskTool(toolId) ?? MASK_TOOLS[0];

  // The canvas's untransformed on-screen size (the clamp space for pan).
  const viewBase = useCallback((): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return [1, 1];
    return [rect.width / viewRef.current.zoom, rect.height / viewRef.current.zoom];
  }, []);

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

  // Best-effort underlay: a large thumbnail of the connected image. Empty in
  // browser preview (mocked backend) — we then draw a checkerboard so the user
  // can still paint in the correct pixel space.
  useEffect(() => {
    if (!imagePath) return;
    let cancelled = false;
    generateThumbnail({ path: imagePath, size: 1280 })
      .then((thumb) => {
        if (cancelled) return;
        if (thumb.data_url) setUnderlay(thumb.data_url);
        if (thumb.width && thumb.height) setDims({ w: thumb.width, h: thumb.height });
      })
      .catch(() => {
        /* keep checkerboard */
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath]);

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
    tool_hand: () => selectTool("hand"),
    tool_zoom: () => selectTool("zoom"),
    pan_space: () => setSpacePan(true),
    zoom_in: () => setView((v) => zoomIn(v, ...viewBase())),
    zoom_out: () => setView((v) => zoomOut(v, ...viewBase())),
    zoom_fit: () => setView(FIT_VIEW),
    zoom_100: () => setView((v) => zoom100(v, dims.w, ...viewBase())),
    adjust_levels: () => dispatch({ type: "layer_add_adjustment", adjType: "levels" }),
    adjust_curve: () => dispatch({ type: "layer_add_adjustment", adjType: "curve" }),
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
      else if (penPendingRef.current) setPenAnchors([]);
      else onClose();
    },
    toggle_overlay: () => setOverlayOnly((v) => !v),
  };
  useShortcutScope(MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS, shortcutHandlers);

  // Map a pointer event to image-pixel coordinates.
  const toImage = useCallback(
    (e: React.PointerEvent): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * dims.w;
      const y = ((e.clientY - rect.top) / rect.height) * dims.h;
      return [Math.round(x), Math.round(y)];
    },
    [dims.w, dims.h],
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

    const paintStroke = (
      s: { mode: string; radius: number; points: [number, number][]; hardness?: number; flow?: number },
      kind: "paint" | "matte" = "paint",
    ) => {
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
    };

    // Committed pen / lasso vector paths: translucent fill + outline (bezier
    // segments where control handles are recorded).
    const paintPath = (p: EditPath) => {
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
    };

    // While previewing a morphology op, the proxy overlay already folds in the
    // brush strokes (transformed), so skip the raw stroke overlay to avoid a
    // confusing double-draw; matte strokes / points / marquee still render.
    if (!previewing) {
      state.current.layers.forEach((layer, li) => {
        if (!layer.visible) return;
        layer.ops.forEach((op, i) => {
          if (op.disabled || (li === state.current.active && i === editingPath)) return;
          if (isBrushOp(op)) paintStroke(op);
          else if (isPathOp(op)) paintPath(op);
        });
      });
    }
    state.current.matte_strokes.forEach((s) => paintStroke(s, "matte"));
    const live = drawing.current;
    if (live) {
      if (tool.kind === "path") {
        // Live lasso loop: thin dashed outline, not a brush band.
        ctx.strokeStyle = "rgba(86,168,255,0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        live.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const liveMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
        paintStroke(
          { mode: tool.mode ?? "add", radius: brushSize, points: live.points, hardness: brushHardness, flow: brushFlow },
          liveMatte ? "matte" : "paint",
        );
      }
    }

    // Anchor re-editing: dashed outline of the draft path plus draggable
    // anchor squares (the dragged anchor is highlighted).
    if (editingPath != null && anchorDraft) {
      ctx.strokeStyle = "rgba(120,230,140,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      anchorDraft.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      anchorDraft.forEach((p, i) => {
        ctx.fillStyle = draggingAnchor.current === i ? "rgba(255,214,90,0.95)" : "rgba(120,230,140,0.95)";
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      });
    }

    // Pending pen path: anchor squares + dashed polyline; the first anchor is
    // highlighted (clicking it closes the path).
    if (penAnchors.length > 0) {
      ctx.strokeStyle = "rgba(86,168,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      penAnchors.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      penAnchors.forEach(([x, y], i) => {
        ctx.fillStyle = i === 0 ? "rgba(120,230,140,0.95)" : "rgba(86,168,255,0.95)";
        ctx.fillRect(x - 3, y - 3, 6, 6);
      });
    }

    // SAM 2 point prompts: numbered crosshair markers. Positive (include)
    // points are green and draw a `+`; negative (exclude) points are red and
    // draw a `−`, mirroring SAM 2's point_labels.
    state.current.points.forEach(({ x, y, label }, i) => {
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

    // Morphology preview: paint the proxy result mask (scaled up) as a tinted
    // overlay. Soft alpha (feather) reads through the per-pixel opacity.
    if (previewing && preview) {
      const tmp = document.createElement("canvas");
      tmp.width = preview.w;
      tmp.height = preview.h;
      const tctx = tmp.getContext("2d");
      if (tctx) {
        const img = tctx.createImageData(preview.w, preview.h);
        for (let i = 0; i < preview.data.length; i++) {
          const a = preview.data[i];
          img.data[i * 4] = 86;
          img.data[i * 4 + 1] = 168;
          img.data[i * 4 + 2] = 255;
          img.data[i * 4 + 3] = Math.round(a * 0.55);
        }
        tctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, dims.w, dims.h);
      }
    }

    // Quick mask (Q): PS-style ruby overlay — tint the *unselected* area red
    // so the selection reads as the clear region.
    if (quickMask && quickProxy) {
      const tmp = document.createElement("canvas");
      tmp.width = quickProxy.w;
      tmp.height = quickProxy.h;
      const tctx = tmp.getContext("2d");
      if (tctx) {
        const img = tctx.createImageData(quickProxy.w, quickProxy.h);
        for (let i = 0; i < quickProxy.data.length; i++) {
          img.data[i * 4] = 224;
          img.data[i * 4 + 1] = 32;
          img.data[i * 4 + 2] = 32;
          img.data[i * 4 + 3] = Math.round((255 - quickProxy.data[i]) * 0.5);
        }
        tctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, dims.w, dims.h);
      }
    }

    // Live move-tool drag: an arrow from the grab point to the cursor.
    const md = moveDrag.current;
    if (md) {
      const [x1, y1] = md.start;
      const [x2, y2] = md.end;
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

    const mq = marquee.current;
    if (mq) {
      const [x1, y1] = mq.start;
      const [x2, y2] = mq.end;
      ctx.strokeStyle = "rgba(86,168,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      if (tool.id === "ellipse") {
        ctx.beginPath();
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      ctx.setLineDash([]);
    }
  }, [dims.w, dims.h, underlay, overlayOnly, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy]);

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
    if (tool.kind === "paint" || tool.kind === "matte") {
      drawing.current = { points: [pt] };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "transform") {
      moveDrag.current = { start: pt, end: pt };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "marquee") {
      marquee.current = { start: pt, end: pt };
      forceRedraw((n) => n + 1);
    } else if (tool.kind === "click") {
      // Magic-wand: record a seeded flood-fill op for the backend.
      dispatch({ type: "op", op: { type: "wand", amount: tolerance, region: pt } });
    } else if (tool.kind === "point") {
      // SAM 2 point prompt: left button includes (positive), right button
      // excludes (negative). Right-click's context menu is suppressed below.
      const label = e.button === 2 ? 0 : 1;
      dispatch({ type: "point", point: { x: pt[0], y: pt[1], label } });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
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
    } else if (marquee.current) {
      marquee.current.end = toImage(e);
      redraw();
    }
  };

  const onPointerUp = () => {
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
    } else if (marquee.current) {
      const { start, end } = marquee.current;
      marquee.current = null;
      const region = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
      if (region[2] - region[0] > 1 && region[3] - region[1] > 1) {
        dispatch({ type: "op", op: { type: tool.id, region } });
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
  // The curve panel exposes three fixed control points (shadows / midtones /
  // highlights at x = 0 / 128 / 255); a stored point list is read best-effort.
  const curveY = (slot: 0 | 1 | 2): number => {
    const defaults = [0, 128, 255] as const;
    const p = activeAdjustment?.points?.[slot];
    return typeof p?.[1] === "number" ? Math.round(p[1]) : defaults[slot];
  };
  const setCurveY = (slot: 0 | 1 | 2, y: number) => {
    const pts: [number, number][] = [
      [0, curveY(0)],
      [128, curveY(1)],
      [255, curveY(2)],
    ];
    pts[slot] = [pts[slot][0], Math.min(Math.max(y, 0), 255)];
    patchAdjustment({ points: pts });
  };

  // One-line label for a history step (raw op vocabulary, like the old chips).
  const opLabel = (op: EditOp): string => {
    if (isPathOp(op)) return `${op.tool} ${op.mode} (${op.points.length})`;
    if (isBrushOp(op)) return `${op.mode === "subtract" ? "eraser" : "brush"} r${op.radius} (${op.points.length})`;
    if (op.type === "transform") {
      const scale = op.scale ?? 1;
      const rotate = op.rotate ?? 0;
      return `transform Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}${scale !== 1 ? ` ×${scale}` : ""}${rotate !== 0 ? ` ∠${rotate}°` : ""}`;
    }
    return op.type;
  };
  const showAmount = useMemo(
    () => tool.kind === "global" || ["grow", "shrink", "feather", "smooth"].includes(toolId),
    [tool.kind, toolId],
  );

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer mask-edit" onClick={(e) => e.stopPropagation()}>
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

        <div className="mask-edit-body">
          <div className="mask-edit-tools">
            {MASK_TOOLS.map((mt) => {
              const loc = localizeTool(mt, lang);
              const combo = toolCombo(mt.id);
              const hint = combo ? `${loc.hint} (${comboLabel(combo)})` : loc.hint;
              return (
                <button
                  key={mt.id}
                  className={`mask-tool ${mt.status === "planned" ? "planned" : ""} ${toolId === mt.id && (mt.kind !== "global" || isPreviewableOp(mt.id)) ? "active" : ""}`}
                  disabled={mt.status === "planned"}
                  title={mt.status === "planned" ? `${hint}（${t("mask.comingSoon")}）` : hint}
                  onClick={() => onToolClick(mt)}
                >
                  {loc.label}
                  {mt.status === "planned" ? <em className="soon">{t("mask.soon")}</em> : null}
                </button>
              );
            })}
          </div>

          <div className="mask-edit-stage">
            <canvas
              ref={canvasRef}
              className="mask-edit-canvas"
              style={{
                aspectRatio: `${dims.w} / ${dims.h}`,
                transform: isFitView(view) ? undefined : viewTransform(view),
                transformOrigin: "center",
                cursor: spacePan || tool.id === "hand" ? "grab" : tool.id === "zoom" ? "zoom-in" : undefined,
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>

          <div className="mask-edit-controls">
            <label className="field">
              <span>{t("mask.brushSize")}</span>
              <span className="slider-row">
                <input type="range" min={1} max={96} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
                <output>{brushSize}</output>
              </span>
            </label>
            {tool.kind === "paint" || tool.kind === "matte" ? (
              <>
                <label className="field">
                  <span>{t("mask.brushHardness")}</span>
                  <span className="slider-row">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(brushHardness * 100)}
                      onChange={(e) => setBrushHardness(Number(e.target.value) / 100)}
                    />
                    <output>{Math.round(brushHardness * 100)}</output>
                  </span>
                </label>
                <label className="field">
                  <span>{t("mask.brushFlow")}</span>
                  <span className="slider-row">
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={Math.round(brushFlow * 100)}
                      onChange={(e) => setBrushFlow(Number(e.target.value) / 100)}
                    />
                    <output>{Math.round(brushFlow * 100)}</output>
                  </span>
                </label>
                <label className="field">
                  <span>{t("mask.brushSpacing")}</span>
                  <span className="slider-row">
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={Math.round(brushSpacing * 100)}
                      onChange={(e) => setBrushSpacing(Number(e.target.value) / 100)}
                    />
                    <output>{Math.round(brushSpacing * 100)}</output>
                  </span>
                </label>
              </>
            ) : null}
            {toolTargets(tool).length > 1 ? (
              <div className="field">
                <span>{t("mask.paintTarget")}</span>
                <span className="slider-row">
                  {toolTargets(tool).map((tg) => (
                    <button key={tg} className={paintTarget === tg ? "active" : ""} onClick={() => setPaintTarget(tg)}>
                      {t(tg === "layer" ? "mask.targetLayer" : "mask.targetMatte")}
                    </button>
                  ))}
                </span>
              </div>
            ) : null}
            {showAmount ? (
              <label className="field">
                <span>{t("mask.amount")}</span>
                <span className="slider-row">
                  <input type="range" min={0} max={16} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
                  <output>{amount}</output>
                </span>
              </label>
            ) : null}
            {isPreviewableOp(toolId) ? (
              <div className="field mask-preview-actions">
                <span>
                  {localizeTool(tool, lang).label}{" "}
                  <span className="muted">· {t("mask.previewBadge")}</span>
                </span>
                <span className="slider-row">
                  <button className="primary" onClick={applyPreviewOp} title={t("mask.applyTitle")}>
                    {t("mask.previewApply", { op: localizeTool(tool, lang).label })}
                  </button>
                  <button onClick={() => setToolId(DEFAULT_TOOL_ID)}>{t("mask.previewCancel")}</button>
                </span>
                <small className="muted">{t("mask.previewHint")}</small>
              </div>
            ) : null}
            {tool.kind === "path" ? (
              <div className="field">
                <span>{t("mask.pathMode")}</span>
                <span className="slider-row">
                  {(["add", "subtract", "intersect"] as const).map((m) => (
                    <button key={m} className={pathMode === m ? "active" : ""} onClick={() => setPathMode(m)}>
                      {t(m === "add" ? "mask.pathAdd" : m === "subtract" ? "mask.pathSubtract" : "mask.pathIntersect")}
                    </button>
                  ))}
                </span>
                {tool.id === "pen" && penAnchors.length > 0 ? (
                  <span className="slider-row">
                    <button className="primary" disabled={penAnchors.length < 3} onClick={closePenPath}>
                      {t("mask.closePath", { count: penAnchors.length })}
                    </button>
                    <button onClick={() => setPenAnchors([])}>{t("mask.cancelPath")}</button>
                  </span>
                ) : null}
              </div>
            ) : null}
            {tool.id === "wand" ? (
              <label className="field">
                <span>{t("mask.wandTolerance")}</span>
                <span className="slider-row">
                  <input type="range" min={0} max={255} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
                  <output>{tolerance}</output>
                </span>
              </label>
            ) : null}

            {transformDraft ? (
              <div className="field mask-preview-actions">
                <span>{t("mask.freeTransform")}</span>
                {(
                  [
                    ["dx", "mask.transformDx", 1],
                    ["dy", "mask.transformDy", 1],
                    ["scale", "mask.transformScale", 100],
                    ["rotate", "mask.transformRotate", 1],
                  ] as const
                ).map(([key, label, factor]) => (
                  <label key={key} className="slider-row">
                    <span>{t(label)}</span>
                    <input
                      type="number"
                      value={Math.round(transformDraft[key] * factor)}
                      onChange={(e) =>
                        setTransformDraft((prev) =>
                          prev ? { ...prev, [key]: Number(e.target.value) / factor } : prev,
                        )
                      }
                    />
                  </label>
                ))}
                <span className="slider-row">
                  <button
                    className="primary"
                    onClick={() => {
                      if (editingTransform != null) {
                        dispatch({ type: "op_transform", index: editingTransform, params: transformDraft });
                      } else {
                        dispatch({
                          type: "op",
                          op: {
                            type: "transform",
                            dx: transformDraft.dx,
                            dy: transformDraft.dy,
                            scale: transformDraft.scale,
                            rotate: transformDraft.rotate,
                          },
                        });
                      }
                      closeTransformPanel();
                    }}
                  >
                    {editingTransform != null ? t("mask.transformUpdate") : t("mask.transformApply")}
                  </button>
                  <button onClick={closeTransformPanel}>{t("mask.transformCancel")}</button>
                </span>
                <small className="muted">{t("mask.transformHint")}</small>
              </div>
            ) : null}

            {editingPath != null ? (
              <div className="field mask-preview-actions">
                <span>{t("mask.anchorEditing")}</span>
                <span className="slider-row">
                  <button className="primary" onClick={commitPathEdit}>{t("mask.anchorDone")}</button>
                  <button onClick={cancelPathEdit}>{t("mask.anchorCancel")}</button>
                </span>
                <small className="muted">{t("mask.anchorHint")}</small>
              </div>
            ) : null}

            <div className="field">
              <span>{t("mask.layers", { count: layers.length })}</span>
              <div className="mask-layer-list">
                {[...layers].map((_, ri) => layers.length - 1 - ri).map((i) => {
                  const layer = layers[i];
                  return (
                    <div
                      key={layer.id}
                      className={`mask-layer-row${i === state.current.active ? " active" : ""}${layer.visible ? "" : " hidden"}`}
                      onClick={() => {
                        if (editingPath != null) cancelPathEdit();
                        dispatch({ type: "layer_active", index: i });
                      }}
                    >
                      <button
                        className="mask-layer-visible"
                        title={layer.visible ? t("mask.layerHide") : t("mask.layerShow")}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "layer_visible", index: i });
                        }}
                      >
                        {layer.visible ? "👁" : "—"}
                      </button>
                      <span className="mask-layer-name" title={layer.name}>
                        {layer.kind === "adjustment" ? "◐ " : ""}
                        {layer.name}
                      </span>
                      {layer.kind === "adjustment" ? (
                        <span className="mask-layer-blend muted">{t("mask.adjustmentBadge")}</span>
                      ) : (
                        <select
                          className="mask-layer-blend"
                          value={layer.blend}
                          title={t("mask.layerBlend")}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => dispatch({ type: "layer_blend", index: i, blend: e.target.value as LayerBlend })}
                        >
                          <option value="normal">{t("mask.blendNormal")}</option>
                          <option value="multiply">{t("mask.blendMultiply")}</option>
                          <option value="screen">{t("mask.blendScreen")}</option>
                        </select>
                      )}
                      <input
                        className="mask-layer-opacity"
                        type="number"
                        min={0}
                        max={100}
                        value={Math.round(layer.opacity * 100)}
                        title={t("mask.layerOpacity")}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => dispatch({ type: "layer_opacity", index: i, opacity: Number(e.target.value) / 100 })}
                      />
                      <button
                        className="mask-layer-delete"
                        title={t("mask.layerDelete")}
                        disabled={layers.length <= 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (editingPath != null) cancelPathEdit();
                          dispatch({ type: "layer_remove", index: i });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
              <span className="slider-row">
                <button onClick={() => dispatch({ type: "layer_add" })} title={t("mask.layerAddTitle")}>
                  + {t("mask.layerAdd")}
                </button>
                <select
                  className="mask-layer-blend"
                  value=""
                  title={t("mask.adjustmentAddTitle")}
                  onChange={(e) => {
                    const adjType = e.target.value as AdjustmentType | "";
                    if (adjType) dispatch({ type: "layer_add_adjustment", adjType });
                  }}
                >
                  <option value="" disabled>
                    ◐ {t("mask.adjustmentAdd")}
                  </option>
                  <option value="levels">{t("mask.adjLevels")}</option>
                  <option value="curve">{t("mask.adjCurve")}</option>
                  <option value="brightness_contrast">{t("mask.adjBrightnessContrast")}</option>
                </select>
              </span>
            </div>

            {activeAdjustment ? (
              <div className="field mask-preview-actions">
                <span>
                  {t(
                    activeAdjustment.type === "levels"
                      ? "mask.adjLevels"
                      : activeAdjustment.type === "curve"
                        ? "mask.adjCurve"
                        : "mask.adjBrightnessContrast",
                  )}{" "}
                  <span className="muted">· {t("mask.adjustmentBadge")}</span>
                </span>
                {activeAdjustment.type === "levels" ? (
                  (
                    [
                      ["in_black", "mask.adjInBlack", 0, 255, 1, 0],
                      ["in_white", "mask.adjInWhite", 0, 255, 1, 255],
                      ["gamma", "mask.adjGamma", 0.1, 3, 0.05, 1],
                      ["out_black", "mask.adjOutBlack", 0, 255, 1, 0],
                      ["out_white", "mask.adjOutWhite", 0, 255, 1, 255],
                    ] as const
                  ).map(([key, label, min, max, step, dflt]) => (
                    <label key={key} className="slider-row">
                      <span>{t(label)}</span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={activeAdjustment[key] ?? dflt}
                        onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
                      />
                      <output>{activeAdjustment[key] ?? dflt}</output>
                    </label>
                  ))
                ) : activeAdjustment.type === "curve" ? (
                  (
                    [
                      [0, "mask.adjShadows"],
                      [1, "mask.adjMidtones"],
                      [2, "mask.adjHighlights"],
                    ] as const
                  ).map(([slot, label]) => (
                    <label key={slot} className="slider-row">
                      <span>{t(label)}</span>
                      <input
                        type="range"
                        min={0}
                        max={255}
                        value={curveY(slot)}
                        onChange={(e) => setCurveY(slot, Number(e.target.value))}
                      />
                      <output>{curveY(slot)}</output>
                    </label>
                  ))
                ) : (
                  (
                    [
                      ["brightness", "mask.adjBrightness"],
                      ["contrast", "mask.adjContrast"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="slider-row">
                      <span>{t(label)}</span>
                      <input
                        type="range"
                        min={-100}
                        max={100}
                        value={activeAdjustment[key] ?? 0}
                        onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
                      />
                      <output>{activeAdjustment[key] ?? 0}</output>
                    </label>
                  ))
                )}
                <small className="muted">{t("mask.adjustmentHint")}</small>
              </div>
            ) : null}

            <div className="field">
              <span>{t("mask.history", { count: ops.length })}</span>
              <div className="mask-history-list">
                {ops.length === 0 ? (
                  <small className="muted">{t("mask.historyEmpty")}</small>
                ) : (
                  ops.map((op, i) => (
                    <div
                      key={i}
                      className={`mask-history-row${op.disabled ? " disabled" : ""}${editingPath === i ? " editing" : ""}`}
                    >
                      <button
                        className="mask-history-toggle"
                        title={op.disabled ? t("mask.stepEnable") : t("mask.stepDisable")}
                        onClick={() => dispatch({ type: "toggle_op", index: i })}
                      >
                        {op.disabled ? "◌" : "●"}
                      </button>
                      <span className="mask-history-label" title={opLabel(op)}>
                        {i + 1}. {opLabel(op)}
                      </span>
                      {!isPathOp(op) && !isBrushOp(op) && op.amount != null ? (
                        <input
                          className="mask-history-amount"
                          type="number"
                          min={0}
                          max={255}
                          value={op.amount}
                          title={t("mask.stepAmount")}
                          onChange={(e) => dispatch({ type: "op_amount", index: i, amount: Number(e.target.value) })}
                        />
                      ) : null}
                      {isPathOp(op) ? (
                        <button
                          className="mask-history-edit"
                          title={t("mask.stepEditAnchors")}
                          onClick={() => (editingPath === i ? cancelPathEdit() : startPathEdit(i))}
                        >
                          ✎
                        </button>
                      ) : null}
                      {!isPathOp(op) && !isBrushOp(op) && op.type === "transform" ? (
                        <button
                          className="mask-history-edit"
                          title={t("mask.stepEditTransform")}
                          onClick={() => {
                            setEditingTransform(i);
                            setTransformDraft({ dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 });
                          }}
                        >
                          ✎
                        </button>
                      ) : null}
                      <button
                        className="mask-history-delete"
                        title={t("mask.stepDelete")}
                        onClick={() => {
                          if (editingPath === i) cancelPathEdit();
                          dispatch({ type: "remove_op", index: i });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="field">
              <span>{t("mask.mattingBand", { count: matteStrokes.length })}</span>
              <div className="mask-op-list">
                {matteStrokes.length === 0 ? (
                  <small className="muted">{t("mask.matteEmpty")}</small>
                ) : (
                  matteStrokes.map((s, i) => (
                    <span key={s.id ?? i} className="mask-op-chip">
                      {t("mask.bandRadius", { radius: s.radius })}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="field">
              <span>{t("mask.samPoints", { count: points.length })}</span>
              <div className="mask-op-list">
                {points.length === 0 ? (
                  <small className="muted">{t("mask.pointsEmpty")}</small>
                ) : (
                  points.map((p, i) => (
                    <span key={i} className={`mask-op-chip${p.label === 0 ? " negative" : ""}`}>
                      {p.label === 0 ? "−" : "+"}#{i + 1} {p.x},{p.y}
                    </span>
                  ))
                )}
              </div>
            </div>

            <small className="muted mask-edit-note">
              {t("mask.notePrefix", { count })}
              <code>edit_paths</code>
              {t("mask.noteSuffix")}
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}
