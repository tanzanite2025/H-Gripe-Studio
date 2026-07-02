import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { generateThumbnail } from "../bridge/tauri";
import {
  MASK_TOOLS,
  maskTool,
  DEFAULT_TOOL_ID,
  type MaskTool,
  type PaintTarget,
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
  EditPath,
  EditPathPoint,
  LayerAdjustment,
  MaskDocument,
} from "../types/production";
import { isBrushOp, isPathOp } from "../types/production";
import { maskEditReducer, type FillDraft } from "./maskEditModal/actions";
import { MaskToolbar } from "./maskEditModal/MaskToolbar";
import { MaskStage } from "./maskEditModal/MaskStage";
import { ToolOptionsPanel } from "./maskEditModal/ToolOptionsPanel";
import { LayersPanel } from "./maskEditModal/LayersPanel";
import { HistoryPanel } from "./maskEditModal/HistoryPanel";
import { InfoPanel } from "./maskEditModal/InfoPanel";

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

  const [underlay, setUnderlay] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: DEFAULT_W, h: DEFAULT_H });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // In-progress freehand stroke (image-space points), null when not drawing.
  const drawing = useRef<{ points: [number, number][] } | null>(null);
  const marquee = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // In-progress move-tool drag (image-space): committed as a `transform` op.
  const moveDrag = useRef<{ start: [number, number]; end: [number, number] } | null>(null);
  // In-progress gradient drag (M10): the start → end ramp vector; Alt at
  // pointer-down records a subtract ramp.
  const gradientDrag = useRef<{ start: [number, number]; end: [number, number]; subtract: boolean } | null>(null);
  // Clone-stamp source point (image-space), picked by Alt+click; null until
  // picked — painting without a source is inert (PS behaviour).
  const cloneSource = useRef<[number, number] | null>(null);
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
      } else if (tool.kind === "heal" || tool.kind === "clone") {
        // Live retouch band: a translucent band marking the painted region
        // (green: rebuilt from its surroundings; violet: cloned from the
        // source offset on release).
        const band = tool.kind === "heal" ? "rgba(120,220,140,0.45)" : "rgba(190,140,255,0.45)";
        ctx.strokeStyle = band;
        ctx.fillStyle = band;
        ctx.lineWidth = brushSize * 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (live.points.length === 1) {
          ctx.beginPath();
          ctx.arc(live.points[0][0], live.points[0][1], brushSize, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          live.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      } else {
        const liveMatte = tool.kind === "matte" || (tool.kind === "paint" && paintTarget === "matte");
        paintStroke(
          { mode: tool.mode ?? "add", radius: brushSize, points: live.points, hardness: brushHardness, flow: brushFlow },
          liveMatte ? "matte" : "paint",
        );
      }
    }

    // Clone-stamp source marker: a crosshair at the Alt-picked source point.
    if (tool.kind === "clone" && cloneSource.current) {
      const [sx, sy] = cloneSource.current;
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

    // Live move-tool / gradient drag: an arrow from the grab point to the
    // cursor (the gradient's ramp runs along it, full → none).
    const md = moveDrag.current ?? gradientDrag.current;
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
    } else if (tool.kind === "paint" || tool.kind === "matte" || tool.kind === "heal") {
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

        <div className="mask-edit-body">
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

          <div className="mask-edit-controls">
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

            <LayersPanel
              layers={layers}
              active={state.current.active}
              dispatch={dispatch}
              onBeforeLayerChange={() => {
                if (editingPath != null) cancelPathEdit();
              }}
              activeAdjustment={activeAdjustment}
              patchAdjustment={patchAdjustment}
              curveY={curveY}
              setCurveY={setCurveY}
            />

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

            <InfoPanel matteStrokes={matteStrokes} points={points} count={count} />
          </div>
        </div>
      </div>
    </div>
  );
}
