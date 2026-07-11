import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ViewportOverlayScene } from "../bridge/viewport";
import {
  ANCHOR_PATH_TOOLS,
  IMAGE_EDITOR_TOOLS,
  imageEditorTool,
  DEFAULT_TOOL_ID,
  type ImageEditorTool,
  psSlotOf,
  type ShapeKind,
} from "./imageEditorTools";
import { parseCombo } from "../shortcuts";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { toolCombo } from "../shortcuts/scopes/imageEditor";
import { useT } from "../i18n";
import { isPreviewableOp } from "./maskMorphology";
import { applyDoc } from "./gradeKernel";
import {
  activeOps,
  currentHistoryIndex,
  editCount,
  hasSourceImageContent,
  historySnapshots,
  initEditState,
  type EditState,
} from "./imageEditorState";
import { type LayerAdjustment, type ImageEditorDocument } from "../contracts/imageEditorDocument";
import { activeTargetKind } from "../contracts/imageEditorDocument";
import { imageEditorReducer, type ImageEditorAction } from "./imageEditorModal/actions";
import { buildViewportOverlayScene, paintStage } from "./imageEditorModal/stageScene";
import { catmullRomClosed } from "./imageEditorModal/pathGeometry";
import { buildEdgeMap } from "./imageEditorModal/magneticSnap";
import { PanelDock, type DockPanel } from "./imageEditorModal/PanelDock";
import { useDockLayout, type DockLayoutState } from "./imageEditorModal/dockLayout";
import "./imageEditorModal/imageEditorModal.css";
import { ImageEditorToolbar } from "./imageEditorModal/ImageEditorToolbar";
import { WholeMaskOperationsPanel } from "./imageEditorModal/WholeMaskOperationsPanel";
import { ImageEditorStage } from "./imageEditorModal/ImageEditorStage";
import { ToolOptionsPanel } from "./imageEditorModal/ToolOptionsPanel";
import { LayersPanel } from "./imageEditorModal/LayersPanel";
import { HistoryPanel, HistorySnapshotDialog } from "./imageEditorModal/HistoryPanel";
import { InfoPanel } from "./imageEditorModal/InfoPanel";
import { AdjustmentsPanel } from "./imageEditorModal/AdjustmentsPanel";
import { ChannelsPanel } from "./imageEditorModal/ChannelsPanel";
import { PathsPanel } from "./imageEditorModal/PathsPanel";
import { ColorPicker } from "./imageEditorModal/ColorPicker";
import { createPointerGestures, pointerDown, pointerMove, pointerUp, type PointerEnv } from "./imageEditorModal/pointerMachine";
import { useCropTool } from "./imageEditorModal/useCropTool";
import { useColorTools, type ColorToolsEnv } from "./imageEditorModal/useColorTools";
import { useDialogDrafts } from "./imageEditorModal/useDialogDrafts";
import { usePathEditing } from "./imageEditorModal/usePathEditing";
import { ImageSizeDialog } from "./imageEditorModal/ImageSizeDialog";
import { CropPanel } from "./imageEditorModal/CropPanel";
import { MarqueeSizePanel } from "./imageEditorModal/MarqueeSizePanel";
import { ToolIcon } from "./imageEditorModal/toolIcons";
import { resolveActiveTarget } from "./studioTarget";
import { getCommand, getCommandCapability, type CommandId } from "./studioCommands";
import { ContextActionBar } from "./imageEditorModal/ContextActionBar";
import { runImageEditorCommand } from "./imageEditorCommandRunner";
import { useBrushParams } from "./imageEditorModal/useBrushParams";
import { useToolSlots } from "./imageEditorModal/useToolSlots";
import { useMaskPreviewController } from "./imageEditorModal/useMaskPreviewController";
import { useImageEditorShortcuts } from "./imageEditorModal/useImageEditorShortcuts";
import {
  createPolygonSelection,
  pointInSelection,
  resizeSelectionDraftBox,
  selectionSourceFromToolId,
  type SelectionDraft,
} from "./imageEditorModal/selection";
import { applyActiveSelectionClip } from "./imageEditorModal/selectionActions";
import { listenFileDrop, probeImageDims } from "../bridge/tauri";
import { useSelectionController } from "./imageEditorModal/useSelectionController";
import { useUnderlayController } from "./imageEditorModal/useUnderlayController";
import { useSelectedLayerFramePresentation } from "./imageEditorModal/useSelectedLayerFramePresentation";
import { useSelectedLayerMoveFrameCache } from "./imageEditorModal/selectedLayerMoveFrameCache";
import { useSelectedLayerMovePresentation } from "./imageEditorModal/useSelectedLayerMovePresentation";
import { useSelectedLayerMoveSurface } from "./imageEditorModal/useSelectedLayerMoveSurface";
import { readSelectionAssistPixels } from "./selectionAssistRead";
import { ASSISTED_SELECTION_TOOL_IDS, GEOMETRY_SELECTION_TOOL_IDS } from "./imageEditorModal/selectionToolProtocol";

const EMPTY_DOCUMENT_DIMS = { w: 1, h: 1 };
const SELECTION_TOP_SLOT_IDS = ["marquee", "lasso", "selection", "pen"] as const;
const IMAGE_PIXEL_CONTEXT_COMMANDS: CommandId[] = ["layer.invert", "layer.addMask", "layer.duplicate", "target.transform"];
const IMAGE_MASK_CONTEXT_COMMANDS: CommandId[] = ["mask.invert", "mask.disable"];

function toolKeyBadge(toolId: string): string {
  const combo = toolCombo(toolId);
  if (combo) {
    const key = parseCombo(combo).key;
    return key.length === 1 ? key.toUpperCase() : "";
  }
  return psSlotOf(toolId)?.shortcut ?? "";
}

interface ImageEditorModalProps {
  title: string;
  /** Backing image path (best-effort underlay); may be missing in preview. */
  imagePath?: string | null;
  /** Opening context only. Editors display the image path, then commit back
   * through the caller; node-output preview targets stay outside this editor. */
  nodeId?: string | null;
  initial: unknown;
  /** Magic-wand colour tolerance from the node's param. */
  wandTolerance: number;
  onCommit: (edits: ImageEditorDocument, state: EditState) => void;
  onClose: () => void;
  /** Draft sink: called on every edit so a host can keep the in-progress
   * document across editor remounts (e.g. the image editor's tab switches). */
  onDocChange?: (doc: ImageEditorDocument) => void;
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
  /** Editor name shown after the title (defaults to "image editor"). */
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

export function ImageEditorModal({
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
}: ImageEditorModalProps) {
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
  const [state, rawDispatch] = useReducer(imageEditorReducer, initial, initEditState);
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
  const {
    toolId,
    setToolId,
    slotFaces,
    setSlotFace,
    selectTool,
    selectSlot,
    cycleSlot,
  } = useToolSlots({
    initialToolId: "move",
    onBeforeSelect: (id) => {
      if (!ANCHOR_PATH_TOOLS.includes(id)) setPenAnchors([]);
      cancelPathEdit();
      if (id !== "patch") {
        gestures.patchLoop = null;
        gestures.patchDrag = null;
      }
    },
  });
  const {
    brushSize,
    setBrushSize,
    brushHardness,
    setBrushHardness,
    brushFlow,
    setBrushFlow,
    brushSpacing,
    setBrushSpacing,
    magneticWidth,
    setMagneticWidth,
    magneticContrast,
    setMagneticContrast,
    magneticFrequency,
    setMagneticFrequency,
    paintTarget,
    setPaintTarget,
    tolerance,
    setTolerance,
    shrinkBrush,
    growBrush,
    softenBrush,
    hardenBrush,
  } = useBrushParams(wandTolerance);
  const [amount, setAmount] = useState(4);
  const [overlayOnly, setOverlayOnly] = useState(false);
  const {
    quickMask,
    setQuickMask,
    quickProxy,
    preview,
    previewing,
    viewportMaskOverlay,
    setDimensions: setPreviewDimensions,
  } = useMaskPreviewController({
    toolId,
    amount,
    document: state.current,
    initialDimensions: state.current.canvas ?? EMPTY_DOCUMENT_DIMS,
  });
  // Boolean mode the next committed path-selection shape combines with.
  const [pathMode, setPathMode] = useState<"add" | "subtract" | "intersect">("add");
  // PS-style right rail: tabbed dock groups driven by a persisted layout
  // (drag a tab to re-dock it; drag the rail edge to resize).
  const dock = useDockLayout(
    workspace === "image" ? IMAGE_DOCK_STORAGE_KEY : DOCK_STORAGE_KEY,
    workspace === "image" ? IMAGE_DOCK_LAYOUT : DEFAULT_DOCK_LAYOUT,
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
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
  // Selection state is intentionally split: a solid draft is only a candidate;
  // Ctrl+J and edit clips read only the committed marching-ants selection.
  const selectionController = useSelectionController();
  const {
    activeSelection,
    activeSelectionRef,
    setActiveSelection,
    selectionDraft,
    setSelectionDraft,
    commitDraft,
    cancelDraft,
    clearActiveSelection,
  } = selectionController;
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  const [draftMenu, setDraftMenu] = useState<{ x: number; y: number } | null>(null);
  // Marching ants flow (PS): while a selection is active, the dash phase
  // advances a few times a second and the ants march along the outline —
  // host-side over presented frames and on the canvas fallback alike.
  const [antsPhase, setAntsPhase] = useState(0);
  useEffect(() => {
    if (!activeSelection) return;
    const timer = window.setInterval(() => setAntsPhase((p) => (p + 2) % 10), 120);
    return () => window.clearInterval(timer);
  }, [activeSelection]);
  // Edits go through this wrapper, which stamps the active selection as the
  // action's `clip` so rasterisation confines the op to the selection.
  // Whole-mask reshapes (transform / crop / select-all) stay global.
  const dispatch = useCallback((action: ImageEditorAction) => {
    rawDispatch(applyActiveSelectionClip(action, activeSelectionRef.current));
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
  // The committed marquee's marching ants stroke host-side over rendered
  // frames (WGPU migration: interactive overlays on the live surface), so
  // the outline stays one screen pixel wide at any zoom instead of scaling
  // with a document-size canvas. The live drag stays on the canvas for
  // zero-latency feedback; only the committed selection goes to the host.
  // `dims` is derived from the viewport hook below; the scene reads the
  // previous render's value through this ref (a selection is only made after
  // the frame — and so `dims` — has settled).
  const frameDimsRef = useRef(state.current.canvas ?? EMPTY_DOCUMENT_DIMS);
  const frameDims = frameDimsRef.current;
  const viewportOverlayScene = useMemo<ViewportOverlayScene | null>(
    () =>
      buildViewportOverlayScene({
        workspace,
        frameDims,
        previewing,
        doc: state.current,
        editingPath,
        selectionDraft,
        activeSelection,
        antsPhase,
        colorSamples,
      }),
    [workspace, selectionDraft, activeSelection, antsPhase, frameDims.w, frameDims.h, previewing, state, editingPath, colorSamples],
  );
  const [moveDraft, setMoveDraft] = useState<[number, number] | null>(null);
  const pendingMoveDraftRef = useRef<[number, number] | null>(null);
  const moveDraftRafRef = useRef<number | null>(null);
  const setMoveDraftQueued = useCallback((draft: [number, number] | null) => {
    if (draft === null) {
      pendingMoveDraftRef.current = null;
      if (moveDraftRafRef.current !== null) {
        window.cancelAnimationFrame(moveDraftRafRef.current);
        moveDraftRafRef.current = null;
      }
      setMoveDraft(null);
      return;
    }
    pendingMoveDraftRef.current = draft;
    if (moveDraftRafRef.current !== null) return;
    moveDraftRafRef.current = window.requestAnimationFrame(() => {
      moveDraftRafRef.current = null;
      setMoveDraft(pendingMoveDraftRef.current);
    });
  }, []);
  useEffect(() => () => {
    if (moveDraftRafRef.current !== null) {
      window.cancelAnimationFrame(moveDraftRafRef.current);
      moveDraftRafRef.current = null;
    }
  }, []);
  // All in-flight pointer gesture state (drags, picked sources, pending
  // loops) — one plain mutable object, mutated at pointer-move rate without
  // re-rendering. See pointerMachine.ts.
  const gestures = useRef(createPointerGestures()).current;
  const layerMoveActive = workspace === "image" && Boolean(gestures.moveDrag);
  const selectedLayerId = state.current.layers[state.current.active]?.id ?? null;
  const magneticEdgeKeyRef = useRef<string | null>(null);
  const magneticEdgePendingKeyRef = useRef<string | null>(null);
  const {
    navigation: nav,
    viewport,
    underlayAnchorRef,
    underlay,
    presented,
    frameView,
    documentDimensions: documentDims,
    dimensions: dims,
    sceneFrame,
    stageSize,
    sourceDimensions,
    cropRegion,
    gradePreview,
  } = useUnderlayController({
    workspace,
    imagePath,
    document: state.current,
    stageRef,
    canvasRef,
    gestures,
    overlayOnly,
    entering,
    closing,
    viewportMaskOverlay,
    viewportOverlayScene,
    fallbackDimensions: frameDimsRef.current,
    emptyDimensions: EMPTY_DOCUMENT_DIMS,
  });
  const { view, setView, viewRef, viewBase, spacePan } = nav;
  frameDimsRef.current = dims;
  // Image workspace: the opened image is the base layer's own source, stated
  // explicitly on the document — the base layer is a placed layer covering the
  // full canvas, not an implicit special case. Old documents (and fresh empty
  // ones) are migrated here, once the source's pixel size is known.
  const baseLayer = state.current.layers[0];
  const baseNeedsExplicitSource =
    workspace === "image" && Boolean(imagePath) && Boolean(baseLayer) && baseLayer.kind !== "adjustment" && !hasSourceImageContent(baseLayer);
  useEffect(() => {
    if (!baseNeedsExplicitSource || !imagePath || !sourceDimensions) return;
    rawDispatch({
      type: "base_source",
      source: { path: imagePath, width: sourceDimensions.w, height: sourceDimensions.h },
    });
  }, [baseNeedsExplicitSource, imagePath, sourceDimensions]);
  // Image workspace: an OS file dropped onto the editor becomes its own
  // placed layer — the layer records the image resource and a contain-fit
  // centred placement rect, so it composites within its own bounds on the
  // canvas instead of adopting (or clipping to) the opened image's frame.
  useEffect(() => {
    if (workspace !== "image") return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenFileDrop((event) => {
      for (const path of event.paths) {
        if (!/\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i.test(path)) continue;
        void probeImageDims(path).then((probed) => {
          if (!probed || probed.width <= 0 || probed.height <= 0) return;
          const canvas = frameDimsRef.current;
          rawDispatch({
            type: "layer_add_image",
            source: { path, width: probed.width, height: probed.height },
            canvas: { w: canvas.w, h: canvas.h },
          });
        });
      }
    }).then((stop) => {
      if (disposed) stop?.();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [workspace]);
  useEffect(() => {
    setPreviewDimensions(dims);
  }, [dims.w, dims.h, setPreviewDimensions]);
  const activeStudioTarget = useMemo(() => {
    const docRef = { canvasId: "image-editor-stage", documentId: imagePath ?? "active-document" };
    return resolveActiveTarget(state.current, docRef);
  }, [state.current, imagePath]);
  const selectedLayerMoveSurface = useSelectedLayerMoveSurface({
    queueEnabled: workspace === "image" && toolId === "move" && viewport.targetSettled,
    workspace,
    imagePath,
    document: state.current,
    selectedLayerId,
    documentWidth: dims.w,
    documentHeight: dims.h,
    sceneFrame,
  });
  const selectedLayerMovePresentation = useSelectedLayerMovePresentation({
    layerMoveActive,
    moveDraft,
    selectedLayerMoveSurface,
    viewportTargetSettled: viewport.targetSettled,
  });
  const selectedLayerFramePresentation = useSelectedLayerFramePresentation({
    workspace,
    document: state.current,
    selectedLayerId,
    baseNeedsExplicitSource,
    documentWidth: dims.w,
    documentHeight: dims.h,
  });
  const displayedSelectedLayerFrame = useSelectedLayerMoveFrameCache({
    selectedLayerId,
    resolvedFrame: selectedLayerFramePresentation.frame,
    layerMoveActive,
    displayedLayerMoveDraft: selectedLayerMovePresentation.displayedLayerMoveDraft,
    viewportTargetSettled: viewport.targetSettled,
  });
  const contextActionItems = useMemo(() => {
    if (workspace !== "image") return [];
    const commandIds = activeStudioTarget.kind === "layer_mask" ? IMAGE_MASK_CONTEXT_COMMANDS : IMAGE_PIXEL_CONTEXT_COMMANDS;
    return commandIds
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
  const liveSelectionOverlayRef = useRef<SVGSVGElement | null>(null);
  // PS selection semantics: an active marquee is only a selection — it never
  // lands on the edit stack itself. Instead, edit steps recorded while it is
  // active carry it as their `clip`, so replay confines their effect to the
  // Floating size panel beside the closed draft marquee. Established
  // marching-ants selections are independent and do not drive this draft UI.
  const [marqueeDraft, setMarqueeDraft] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    if (selectionDraft) {
      const [x0, y0, x1, y1] = selectionDraft.region;
      setMarqueeDraft({ w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
    }
  }, [selectionDraft]);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("polygon");
  const [shapeSides, setShapeSides] = useState(5);
  // Crop tool: the adjustable rect draft and the floating
  // panel's controls (see useCropTool).
  const crop = useCropTool(dims, dispatch);
  const { cropDraft, setCropDraft, setCropAspect, cropLock, confirmCropDraft } = crop;
  const [, forceRedraw] = useState(0);

  // Screen-mode cycle (PS `F`): 0 full UI → 1 panels hidden → 2 canvas only.
  const [screenMode, setScreenMode] = useState<0 | 1 | 2>(0);

  const tool = imageEditorTool(toolId) ?? IMAGE_EDITOR_TOOLS[0];

  const hideLiveSelectionOverlay = useCallback(() => {
    const svg = liveSelectionOverlayRef.current;
    if (!svg) return;
    svg.querySelectorAll<SVGElement>("[data-live-selection-shape]").forEach((shape) => {
      shape.style.display = "none";
    });
  }, []);

  const syncLiveSelectionOverlay = useCallback(() => {
    const svg = liveSelectionOverlayRef.current;
    if (!svg) return;
    const rect = svg.querySelector<SVGRectElement>('[data-live-selection-shape="rect"]');
    const ellipse = svg.querySelector<SVGEllipseElement>('[data-live-selection-shape="ellipse"]');
    const polyline = svg.querySelector<SVGPolylineElement>('[data-live-selection-shape="polyline"]');
    hideLiveSelectionOverlay();

    const marquee = gestures.marquee;
    if (workspace === "image" && marquee && (tool.id === "rect" || tool.id === "ellipse")) {
      const [x0, y0] = marquee.start;
      const [x1, y1] = marquee.end;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const width = Math.abs(x1 - x0);
      const height = Math.abs(y1 - y0);
      if (width <= 0 || height <= 0) return;
      if (tool.id === "ellipse" && ellipse) {
        ellipse.setAttribute("cx", String(left + width / 2));
        ellipse.setAttribute("cy", String(top + height / 2));
        ellipse.setAttribute("rx", String(Math.max(width / 2, 0.5)));
        ellipse.setAttribute("ry", String(Math.max(height / 2, 0.5)));
        ellipse.style.display = "";
        return;
      }
      if (rect) {
        rect.setAttribute("x", String(left));
        rect.setAttribute("y", String(top));
        rect.setAttribute("width", String(width));
        rect.setAttribute("height", String(height));
        rect.style.display = "";
      }
      return;
    }

    const livePath = gestures.drawing;
    if (workspace === "image" && tool.kind === "path" && livePath && livePath.points.length >= 2 && polyline) {
      polyline.setAttribute("points", livePath.points.map(([x, y]) => `${x},${y}`).join(" "));
      polyline.style.display = "";
    }
  }, [gestures, hideLiveSelectionOverlay, tool.id, tool.kind, workspace]);

  useEffect(() => {
    hideLiveSelectionOverlay();
  }, [hideLiveSelectionOverlay, toolId, workspace]);

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
    openFillDialog,
  } = dialogs;

  const { openFreeTransform } = useImageEditorShortcuts({
    workspace,
    dims,
    dispatch,
    toolSlots: { toolId, selectTool, selectSlot, cycleSlot },
    brushParams: { shrinkBrush, growBrush, softenBrush, hardenBrush },
    dialogs,
    pathEditing,
    navigation: nav,
    colors,
    activeSelectionRef,
    setActiveSelection,
    selectionDraft,
    setSelectionDraft,
    setQuickMask,
    setOverlayOnly,
    setScreenMode,
    closePenPath: () => closePenPath(),
    requestClose,
  });

  const makeSelectionFromDraft = (draft: SelectionDraft | null = selectionDraft) => {
    if (!draft) return;
    commitDraft(draft);
    setDraftMenu(null);
  };

  const cancelSelectionDraft = () => {
    cancelDraft();
    setDraftMenu(null);
  };

  const selectionMenuItems: MenuItem[] = [
    { label: "取消选择", onClick: () => runContextCommand("selection.deselect") },
    { label: "选择反向", onClick: () => runContextCommand("selection.invert") },
    { label: "羽化...", onClick: () => runContextCommand("selection.feather") },
    { label: "通过拷贝的图层", onClick: () => runContextCommand("layer.duplicate") },
    { label: "自由变换", onClick: openFreeTransform },
    { label: "填充...", onClick: openFillDialog },
  ];

  const draftMenuItems: MenuItem[] = [
    {
      label: "建立选区",
      onClick: () => {
        makeSelectionFromDraft();
      },
    },
    { label: "取消草稿", onClick: cancelSelectionDraft },
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
    sceneFrame,
  };

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
      const x = sceneFrame.x + ((ux + baseW / 2) / baseW) * sceneFrame.w;
      const y = sceneFrame.y + ((uy + baseH / 2) / baseH) * sceneFrame.h;
      return [Math.round(x), Math.round(y)];
    },
    [sceneFrame.x, sceneFrame.y, sceneFrame.w, sceneFrame.h],
  );

  const selectionDraftAtPoint = (pt: [number, number]): SelectionDraft | null => {
    return selectionDraft && pointInSelection(pt, selectionDraft) ? selectionDraft : null;
  };

  const openSelectionContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = toImage(e);
    const selection = activeSelectionRef.current;
    if (selection && pointInSelection(pt, selection)) {
      setDraftMenu(null);
      setSelectionMenu({ x: e.clientX, y: e.clientY });
      return;
    }
    const pendingSelection = selectionDraftAtPoint(pt);
    if (pendingSelection) {
      setSelectionMenu(null);
      setDraftMenu({ x: e.clientX, y: e.clientY });
      return;
    }
    setSelectionMenu(null);
    setDraftMenu(null);
  };

  // Magnetic lasso: build and cache the visible window's edge map only when
  // the user actually starts a magnetic-lasso gesture. This is a named
  // selection-assist read from the active editable pixel layer, not the
  // composite underlay/viewport and not a Layer Via Copy pixel read.
  const captureEdgeMap = useCallback(() => {
    const winW = Math.max(1, Math.round(sceneFrame.w / frameView.zoom));
    const winH = Math.max(1, Math.round(sceneFrame.h / frameView.zoom));
    const offX = Math.round(sceneFrame.x + frameView.panX * sceneFrame.w);
    const offY = Math.round(sceneFrame.y + frameView.panY * sceneFrame.h);
    const selectedLayer = state.current.layers[state.current.active] ?? null;
    const sourceKey = `selection-assist:${imagePath ?? ""}:${selectedLayerId ?? ""}:${JSON.stringify({
      canvas: state.current.canvas ?? null,
      active: state.current.active,
      layer: selectedLayer,
    })}`;
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

    if (!imagePath || !selectedLayerId) {
      failEdgeMap();
      return;
    }
    void readSelectionAssistPixels({
      imagePath,
      document: state.current,
      selectedLayerId,
      documentWidth: dims.w,
      documentHeight: dims.h,
      frameX: offX,
      frameY: offY,
      frameWidth: winW,
      frameHeight: winH,
    }).then(
      (px) => {
        if (px.width !== winW || px.height !== winH) {
          failEdgeMap();
          return;
        }
        commitEdgeMap(px.pixels, px.width, px.height);
      },
      (err) => {
        console.warn("selection assist read failed", err);
        failEdgeMap();
      },
    );
  }, [imagePath, selectedLayerId, state.current, dims.w, dims.h, frameView, sceneFrame.x, sceneFrame.y, sceneFrame.w, sceneFrame.h]);

  // Redraw the overlay: committed brush strokes and the in-progress
  // stroke/marquee (see stageScene's paintStage). The underlay presents
  // separately (an image layer under this canvas at the rendered window's
  // rect), so the canvas stays transparent where the image shows through.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = sceneFrame.w;
    canvas.height = sceneFrame.h;
    paintStage(ctx, {
      workspace,
      dims,
      frame: sceneFrame,
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
      cropDraft,
      cropRegion: null,
      selectionDraft,
      activeSelection,
      antsPhase,
      gestures,
    });
  }, [workspace, dims.w, dims.h, sceneFrame.x, sceneFrame.y, sceneFrame.w, sceneFrame.h, cropRegion, overlayOnly, underlay, presented, state.current.layers, state.current.active, state.current.matte_strokes, state.current.points, tool.mode, tool.kind, tool.id, brushSize, brushHardness, brushFlow, paintTarget, penAnchors, editingPath, anchorDraft, previewing, preview, quickMask, quickProxy, shapeKind, shapeSides, colorSamples, cropDraft, activeSelection, selectionDraft, antsPhase]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Commit a closed path (straight anchors; no handles from the UI). The
  // tool name is recorded for provenance — the rasteriser only reads
  // mode / closed / points, so every path tool replays identically.
  const commitPath = (toolName: string, pts: [number, number][]) => {
    if (pts.length < 3) return;
    if (workspace === "image") {
      setSelectionDraft(createPolygonSelection(pts, selectionSourceFromToolId(toolName)));
      setActiveSelection(null);
      setDraftMenu(null);
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
    runImageEditorCommand(id, {
      doc: stateRef.current.current,
      target: activeStudioTarget,
      dispatch,
      beforeStructuralChange: () => {
        if (editingPathRef.current != null) cancelPathEdit();
      },
      setToolId,
      includeSourceImage: workspace === "image",
      activeSelection: activeSelectionRef.current,
      selectionDraft,
      clearActiveSelection,
      clearSelectionDraft: () => setSelectionDraft(null),
    });
  }, [activeStudioTarget, cancelPathEdit, clearActiveSelection, editingPathRef, selectionDraft, setSelectionDraft, stateRef, setToolId, workspace]);

  // Pointer gestures: the shell only captures the pointer, serves one-shot
  // requests (the armed colour pick) and keeps the brush ring on the cursor;
  // the whole down/move/up decision tree lives in pointerMachine.ts.
  const canStartSelectedLayerMove = ([x, y]: [number, number]): boolean => {
    if (workspace !== "image") return true;
    const frame = selectedLayerFramePresentation.frame;
    if (!frame) return false;
    const [x0, y0, x1, y1] = frame.rect;
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    return x >= left && x <= right && y >= top && y <= bottom;
  };
  const pointerEnv = (): PointerEnv => ({
    tool,
    toolId,
    workspace,
    spacePan,
    dims,
    doc: state.current,
    activeLayerKind,
    activeSelection,
    editingPath,
    anchorDraft,
    penAnchors,
    cropDraft,
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
    canStartSelectedLayerMove,
    viewBase,
    pointerAngle,
    viewRotate: () => viewRef.current.rotate ?? 0,
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
    setActiveSelection,
    setSelectionDraft,
    setMoveDraft: setMoveDraftQueued,
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
    syncLiveSelectionOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // PS-style brush cursor: follow the pointer (image-space %, so the ring
    // tracks the view transform). Imperative style writes — no re-render.
    const cursorEl = brushCursorEl.current;
    if (cursorEl) {
      const [x, y] = toImage(e);
      cursorEl.style.left = `${((x - sceneFrame.x) / sceneFrame.w) * 100}%`;
      cursorEl.style.top = `${((y - sceneFrame.y) / sceneFrame.h) * 100}%`;
      cursorEl.style.display = spacePan ? "none" : "";
    }
    pointerMove(pointerEnv(), gestures, e);
    syncLiveSelectionOverlay();
  };

  const onPointerUp = () => {
    // Also reached from the canvas's pointer-leave: hide the brush ring until
    // the pointer is back over the canvas.
    if (brushCursorEl.current) brushCursorEl.current.style.display = "none";
    pointerUp(pointerEnv(), gestures);
    hideLiveSelectionOverlay();
  };

  // Clicking a tool: `global` tools are immediate actions (no canvas mode);
  // paint/click/marquee/path tools become the active mode; `planned` tools are inert.
  const onToolClick = (t: ImageEditorTool) => {
    if (t.status !== "ready") return;
    if (!ANCHOR_PATH_TOOLS.includes(t.id)) setPenAnchors([]);
    cancelPathEdit();
    if (t.id !== "patch" && t.id !== "content_aware_move") {
      gestures.patchLoop = null;
      gestures.patchDrag = null;
    }
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

  // Manual marquee size: the floating panel exists only for a closed draft.
  // Its primary action must commit that draft into the active marching-ants
  // selection; it must not merely resize a hidden candidate.
  const makeMarqueeSelection = (w: number, h: number) => {
    if (!selectionDraft) return;
    makeSelectionFromDraft(resizeSelectionDraftBox(selectionDraft, w, h, dims));
    forceRedraw((n) => n + 1);
  };

  return (
    <div className={`media-viewer-backdrop${closing ? " image-editor-backdrop-leaving" : ""}`} onClick={requestClose}>
      <div
        className={`media-viewer image-editor${screenMode ? ` image-editor-screen-${screenMode}` : ""}${animateEnter ? " image-editor-entering" : ""}${closing ? " image-editor-leaving" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.animationName === "image-editor-slide-out") onClose();
          else if (e.animationName === "image-editor-slide-in") setEntering(false);
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

        <div className="image-editor-body" style={{ "--image-editor-rail-w": `${dock.layout.railWidth}px` } as CSSProperties}>
          <ImageEditorToolbar
            toolId={toolId}
            onToolClick={onToolClick}
            hiddenSlotIds={workspace === "image" ? SELECTION_TOP_SLOT_IDS : []}
            faces={slotFaces}
            onPickFace={setSlotFace}
            paintMode={tool.mode === "subtract" || (tool.kind === "path" && pathMode === "subtract") ? "subtract" : "add"}
            fgColor={fgColor}
            bgColor={bgColor}
            onPickColor={setColorPicker}
            onSwapColors={swapColors}
            onResetColors={resetColors}
          />

          {workspace === "image" ? (
            <div className="mask-selection-top-strip" role="toolbar" aria-label="选区工具">
              <div className="mask-selection-tool-segment" data-selection-family="geometry">
                {GEOMETRY_SELECTION_TOOL_IDS.map((id) => {
                  const mt = imageEditorTool(id);
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
              <div className="mask-selection-tool-segment assist" data-selection-family="assist">
                {ASSISTED_SELECTION_TOOL_IDS.map((id) => {
                  const mt = imageEditorTool(id);
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
            </div>
          ) : null}

          <ImageEditorStage
            stageRef={stageRef}
            canvasRef={canvasRef}
            dims={dims}
            sceneFrame={sceneFrame}
            stageSize={stageSize}
            documentAvailable={documentDims != null}
            view={view}
            viewportFrameUrl={gradedUnderlay ?? underlay}
            isNativeSurfacePresented={presented}
            cropView={cropView}
            nativeSurfacePlacementAnchorRef={underlayAnchorRef}
            viewportFrameView={frameView}
            viewportBackend={viewport.backend}
            overlayOnly={overlayOnly}
            spacePan={spacePan}
            toolId={tool.id}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={openSelectionContextMenu}
            brushCursor={usesBrushCursor && !spacePan ? { diameter: brushSize * 2 } : null}
            brushCursorRef={brushCursorEl}
            liveSelectionOverlayRef={liveSelectionOverlayRef}
            selectionDraft={workspace === "image" && penAnchors.length === 0 ? selectionDraft : null}
            activeSelection={workspace === "image" ? activeSelection : null}
            antsPhase={antsPhase}
            selectedLayerMoveSurface={selectedLayerMoveSurface?.pixels ?? null}
            selectedLayerMoveDraft={selectedLayerMovePresentation.displayedLayerMoveDraft}
            selectedLayerFrame={displayedSelectedLayerFrame}
            suppressPixelLayer={selectedLayerMovePresentation.suppressPixelLayer}
            contextActionBar={
              workspace === "image" && displayedSelectedLayerFrame ? (
                <ContextActionBar
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
          {draftMenu ? (
            <ContextMenu
              x={draftMenu.x}
              y={draftMenu.y}
              items={draftMenuItems}
              onClose={() => setDraftMenu(null)}
            />
          ) : null}

          {/* Floating selection-size panel (see MarqueeSizePanel). */}
          {selectionDraft && !gestures.marquee && tool.kind === "marquee" && canvasRef.current ? (
            <MarqueeSizePanel
              draftSelection={selectionDraft}
              draft={marqueeDraft}
              setDraft={setMarqueeDraft}
              makeSelection={makeMarqueeSelection}
              cancelDraft={cancelSelectionDraft}
              dims={dims}
              frame={sceneFrame}
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

          <div className="image-editor-controls">
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
                  content: <WholeMaskOperationsPanel toolId={toolId} onToolClick={onToolClick} />,
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
              activeSelection={activeSelection}
              selectionDraft={selectionDraft}
              dispatch={dispatch}
              onBeforeLayerChange={() => {
                if (editingPath != null) cancelPathEdit();
              }}
              clearActiveSelection={clearActiveSelection}
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
