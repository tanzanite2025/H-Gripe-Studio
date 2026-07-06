import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type NodePositionChange,
} from "@hgripe/flow";

import { FlowCanvas, type EdgeStyle } from "./editor/FlowCanvas";
import { RunHud, type RunHudScope } from "./editor/RunHud";
import { Palette } from "./editor/Palette";
import { ContextMenu } from "./editor/ContextMenu";
import { NodeEditingContext } from "./editor/editingContext";
import { PreviewModal } from "./editor/PreviewModal";
import { EditorHost, type EditorRequest } from "./editor/host/EditorHost";
import { toMaskDocument, type ImageDocument } from "./editor/imageDocument";
import type { CropCommit } from "./editor/CropEditModal";
import { normalizeEditPaths } from "./editor/maskEdit";
import { useHistory } from "./editor/useHistory";
import { useCanvasDocument } from "./editor/useCanvasDocument";
import {
  detachChildren,
  findContainingGroup,
  isGroupNode,
  reparentNode,
} from "./editor/grouping";
import { getHelperLines } from "./editor/helperLines";
import type { HgripeNodeData } from "./editor/HgripeNode";
import { fromWorkflowGraph, toWorkflowGraph } from "./editor/adapter";
import type { WorkflowGraph } from "./graph/model";
import { canvasDocumentTitle } from "./editor/canvasDocument";
import { ProjectPanel } from "./editor/ProjectPanel";
import { RedoIcon, Toolbar, UndoIcon } from "./editor/Toolbar";
import { CanvasTabs } from "./editor/CanvasTabs";
import { RunLog } from "./editor/RunLogPanel";
import { SnapshotsPanel } from "./editor/SnapshotsPanel";
import { RunHistoryPanel } from "./editor/RunHistoryPanel";
import { useKeyboardShortcuts } from "./editor/useKeyboardShortcuts";
import { useStudioRunController, type ProjectRunCanvas } from "./editor/useStudioRunController";
import { useStudioFileController } from "./editor/useStudioFileController";
import { makeNode, useNodeEditing } from "./editor/useNodeEditing";
import { useContextMenu } from "./editor/useContextMenu";
import { useModals } from "./editor/useModals";
import { loadPersistedGraph } from "./editor/persist";
import {
  loadLocalProjectManifest,
  parseProjectManifest,
  saveLocalProjectManifest,
  serializeProjectManifest,
  type ProjectManifest,
} from "./editor/projectManifest";
import { validateGraph } from "./runtime/dag";
import {
  isTauri,
  listenFileDrop,
  readStudioProjectManifest,
  writeStudioProjectManifest,
  mergeLayerMasks,
  pickFile,
  primeIngest,
  splitLayerMask,
} from "./bridge/tauri";
import { ProductionDrawer, type AddableAsset } from "./production/ProductionDrawer";
import {
  loadDrawerMode,
  saveDrawerMode,
  toggleDrawer,
  type DrawerMode,
} from "./production/drawerState";
import { assetKindForNodeKind } from "./production/mediaBin";
import {
  assetTarget,
  imageLayerTarget,
  layeredImageTarget,
  nodeOutputTarget,
  type ProductionTarget,
} from "./production/productionTarget";
import {
  findLayer,
  mergeLayersIntoAsset,
  setLayerProtected,
  splitLayerInAsset,
  stubLayeredImageAsset,
  type LayeredImageAsset,
} from "./production/layeredImage";
import { findClip, type TrackKind } from "./production/timeline";
import { defaultAudioEdit, type AudioClipEdit } from "./production/audioEdit";
import {
  addAssetClip,
  addAssetToBin,
  addTimelineTrack,
  clearProductionSelection,
  clipGradeKey,
  commitAudioEdit,
  productionStore,
  removeAssetFromBin,
  removeTimelineClip,
  removeTimelineTrack,
  selectBinAsset,
  selectClip,
  setClipGradeDoc,
  useProductionState,
} from "./production/productionStore";
import { applyGpuMaxJobs, getGpuMaxJobs } from "./bridge/scheduler";
import { unregisterNodeOutput } from "./bridge/viewport";
import { AudioEditModal } from "./production/AudioEditModal";
import { ExportDialog } from "./production/ExportDialog";
import { startIngestListener } from "./runtime/ingestStore";
import { ModelManagerModal } from "./models/ModelManagerModal";
import { ToolRail } from "./assistant/ToolRail";
import { FloatingDock } from "./assistant/FloatingDock";
import { PromptAssistantPanel } from "./assistant/PromptAssistantPanel";
import { loadAssistantOpen, saveAssistantOpen } from "./assistant/promptAssistantState";
import {
  isAssistantInsertTarget,
  isPromptTextTarget,
  planGenerateInsert,
} from "./assistant/insertTarget";
import type { ModelCapability } from "./models/backendRegistry";
import { useT } from "./i18n";

// Canvas file-drop ingestion: which dropped files become a media card. Images
// land on the generic image card (`imageSource`); videos land on the generic
// video card (`videoSource`), a separate track that shows a poster frame +
// metadata (see docs/cards/generic-media-card.md).
const IMAGE_DROP_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
]);
const VIDEO_DROP_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);

function dropExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

// Minimal pre-wired workflow: Prompt -> Generate.
const initialNodes: Node[] = [
  makeNode("prompt-1", "promptOptimize", 40, 120, { text: "a watercolor fox" }),
  makeNode("generate-1", "generate", 360, 80),
];
const initialEdges: Edge[] = [
  { id: "e1", source: "prompt-1", sourceHandle: "text", target: "generate-1", targetHandle: "prompt" },
];

function Studio({ onToggleLang }: { onToggleLang: () => void }) {
  const t = useT();
  // Restore the last autosaved workflow from this workspace; fall back to the
  // pre-wired sample graph on a fresh / unreadable workspace.
  const initial = useMemo(() => {
    const restored = loadPersistedGraph();
    if (restored && restored.nodes.length) return fromWorkflowGraph(restored);
    return { nodes: initialNodes, edges: initialEdges };
  }, []);
  const restoredOnMount = useRef(initial.nodes !== initialNodes);

  // The graph the editor shows, wrapped in one canvas document shell
  // (multi-canvas workspace plan Phase 2): graph, selection, and pane
  // viewport live under a stable document identity so tabs can hold one
  // object per canvas later.
  const canvas = useCanvasDocument(initial);
  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    selectedId,
    setSelectedId,
    setViewport,
  } = canvas;
  const { openNewCanvas, activateCanvas, closeCanvas, renameCanvas } = canvas;
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [helperLines, setHelperLines] = useState<{ horizontal?: number; vertical?: number }>({});
  const [edgeType, setEdgeType] = useState<EdgeStyle>("default");
  const [showMinimap, setShowMinimap] = useState(true);
  // Bottom production drawer (Edit / Timeline + Grade) shell state, plus the
  // lightweight media bin and the unified production selection it consumes.
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(() => loadDrawerMode());
  // The media bin, timeline, bin/clip selection, and per-clip edit documents
  // live in the global production store (productionStore.ts): mutations that
  // remove an entity cascade there, so edit docs never outlive their clips.
  const binAssets = useProductionState((s) => s.binAssets);
  const activeAssetId = useProductionState((s) => s.activeAssetId);
  const timeline = useProductionState((s) => s.timeline);
  const selectedClipId = useProductionState((s) => s.selectedClipId);
  const gradeDocs = useProductionState((s) => s.gradeDocs);
  const audioEdits = useProductionState((s) => s.audioEdits);
  // Clip whose grade modal is open (clip context menu → “grade”).
  const [gradeClipId, setGradeClipId] = useState<string | null>(null);
  const [audioEditClipId, setAudioEditClipId] = useState<string | null>(null);
  // Layer selection inside the targeted layered image asset (review panel):
  // the selected candidate layer id plus per-layer visibility overrides.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  // On-demand export dialog (plan step 9): opened by the drawer's export command.
  const [exportOpen, setExportOpen] = useState(false);
  // System "Models / APIs" manager (system model manager surface plan): one
  // application-level surface, opened from the global toolbar entry or a
  // card's "Manage…" entry (which preselects that card's capability).
  const [modelsRequest, setModelsRequest] = useState<{ capability: ModelCapability | null } | null>(null);
  // Standalone image editor opened blank (no image card selected yet).
  const [mediaEditBlank, setMediaEditBlank] = useState(false);
  // Standalone image preview popup: any thumbnail double-click opens the
  // file here, off the canvas layer (no in-canvas preview cards).
  const [imagePreviewPath, setImagePreviewPath] = useState<string | null>(null);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const isDesktop = isTauri();
  const [message, setMessage] = useState<string>(
    isDesktop
      ? restoredOnMount.current
        ? "restored last workflow"
        : ""
      : "browser preview (backend mocked)",
  );

  // True while a node drag is in progress, so we snapshot only once per drag.
  const dragging = useRef(false);
  // Node id queued for a "run up to this node" once the committing param edit
  // has landed in `nodes` state (setNodes is async, so we defer to an effect).
  const pendingRunNode = useRef<string | null>(null);
  // Per-image in-progress edit documents for the unified image editor's
  // document tabs: switching tabs remounts the editor, so drafts live here.
  const mediaEditDrafts = useRef(new Map<string, ImageDocument>());

  // Deleting a canvas node cascades: its in-progress image-editor draft and
  // its host-side output registrations must not outlive it.
  const knownNodeIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    if (knownNodeIds.current) {
      for (const id of knownNodeIds.current) {
        if (ids.has(id)) continue;
        mediaEditDrafts.current.delete(id);
        unregisterNodeOutput(id).catch(() => {});
      }
    }
    knownNodeIds.current = ids;
  }, [nodes]);

  const history = useHistory({ nodes, edges, setNodes, setEdges, scopeId: canvas.documentId });
  const { takeSnapshot, undo, redo } = history;

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  // The selected split node's layered image asset. The last run's real
  // segmented asset (surfaced onto the card by the run controller) wins;
  // before any run the panel falls back to the client-side stub builder so
  // it still works, e.g. in the browser preview.
  const layeredAsset = useMemo<LayeredImageAsset | null>(() => {
    if (!selectedNode) return null;
    const data = selectedNode.data as HgripeNodeData;
    if (data.kind !== "smartLayerSplit") return null;
    if (data.layeredAsset) return data.layeredAsset;
    const edge = edges.find((e) => e.target === selectedNode.id && e.targetHandle === "image");
    const src = edge ? nodes.find((n) => n.id === edge.source) : undefined;
    const d = src?.data as HgripeNodeData | undefined;
    const imagePath =
      d?.imagePath ?? (typeof d?.params?.path === "string" ? (d.params.path as string) : null);
    if (!imagePath) return null;
    return stubLayeredImageAsset({ imagePath, nodeId: selectedNode.id });
  }, [selectedNode, nodes, edges]);

  // Persisted drawer shell state so the drawer reopens how it was left.
  const changeDrawerMode = useCallback((m: DrawerMode) => {
    setDrawerMode(m);
    saveDrawerMode(m);
  }, []);

  // The selected canvas node as a bin-addable media reference (image / video
  // source card with a path), or null when the selection isn't one.
  const addableAsset = useMemo<AddableAsset | null>(() => {
    if (!selectedNode) return null;
    // A split node registers its layered asset's composite preview, so a
    // timeline still clip can reference the layered image.
    if (layeredAsset) {
      return {
        kind: "image",
        path: layeredAsset.preview_composite.path,
        sourceNodeId: selectedNode.id,
      };
    }
    const data = selectedNode.data as HgripeNodeData;
    const kind = assetKindForNodeKind(data.kind);
    const path = typeof data.params?.path === "string" ? (data.params.path as string) : "";
    if (!kind || !path) return null;
    return { kind, path, sourceNodeId: selectedNode.id };
  }, [selectedNode, layeredAsset]);

  const handleAddSelectedToBin = useCallback(() => {
    if (addableAsset) addAssetToBin(productionStore, addableAsset);
  }, [addableAsset]);

  const handleRemoveBinAsset = useCallback((id: string) => {
    // Clips are references to bin assets, so they leave with the asset (and
    // their edit documents cascade away with the clips).
    removeAssetFromBin(productionStore, id);
  }, []);

  const handleAddActiveToTimeline = useCallback(() => {
    const { activeAssetId: active } = productionStore.getState();
    if (active) addAssetClip(productionStore, active);
  }, []);

  const handleAddActiveToTrack = useCallback((trackId: string) => {
    const { activeAssetId: active } = productionStore.getState();
    if (active) addAssetClip(productionStore, active, { trackId });
  }, []);

  const handleAddTrack = useCallback((kind: TrackKind) => {
    addTimelineTrack(productionStore, kind);
  }, []);

  const handleRemoveTrack = useCallback((trackId: string) => {
    removeTimelineTrack(productionStore, trackId);
  }, []);

  const handleRemoveClip = useCallback((clipId: string) => {
    removeTimelineClip(productionStore, clipId);
  }, []);

  const handleSelectClip = useCallback((clipId: string | null) => {
    selectClip(productionStore, clipId);
  }, []);

  const handleSelectBinAsset = useCallback((assetId: string | null) => {
    selectBinAsset(productionStore, assetId);
  }, []);

  // Unified production selection: a timeline clip when one is selected, else
  // an active bin asset, else the selected canvas node's output. The drawer
  // and (later) the on-demand editors consume this target rather than
  // per-media-type selection state.
  const productionTarget = useMemo<ProductionTarget | null>(() => {
    if (selectedClipId) {
      const found = findClip(timeline, selectedClipId);
      if (found) {
        const base = { timelineId: timeline.id, trackId: found.track.id, clipId: found.clip.id };
        return found.clip.kind === "audio"
          ? { kind: "audio_clip", ...base }
          : { kind: "video_clip", ...base };
      }
    }
    if (activeAssetId) return assetTarget(activeAssetId);
    if (selectedId && layeredAsset) {
      return selectedLayerId
        ? imageLayerTarget(layeredAsset.id, selectedLayerId)
        : layeredImageTarget(layeredAsset.id, selectedId);
    }
    if (selectedId) return nodeOutputTarget(selectedId);
    return null;
  }, [selectedClipId, timeline, activeAssetId, selectedId, layeredAsset, selectedLayerId]);

  // Selecting a canvas node retargets production selection to that node.
  const handleCanvasSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedLayerId(null);
    setLayerVisibility({});
    if (id) clearProductionSelection(productionStore);
  }, []);

  const handleToggleLayerVisibility = useCallback(
    (layerId: string) => {
      const current =
        layerVisibility[layerId] ??
        (layeredAsset ? (findLayer(layeredAsset, layerId)?.visible ?? true) : true);
      setLayerVisibility((vis) => ({ ...vis, [layerId]: !current }));
    },
    [layerVisibility, layeredAsset],
  );

  // Review Editor "mark protected": flip the layer's protected flag in the
  // node's stored asset. Pure asset transform — works in every runtime.
  const handleToggleProtected = useCallback(
    (layerId: string) => {
      const node = selectedNode;
      const asset = layeredAsset;
      if (!node || !asset) return;
      const layer = findLayer(asset, layerId);
      if (!layer || layer.locked) return;
      const next = setLayerProtected(asset, layerId, !(layer.protected ?? false));
      if (next === asset) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === node.id
            ? { ...n, data: { ...(n.data as HgripeNodeData), layeredAsset: next } }
            : n,
        ),
      );
    },
    [selectedNode, layeredAsset, setNodes],
  );

  // Review Editor "merge layers": union the checked layers' masks on the
  // backend, then replace them in the node's stored asset with one merged
  // layer. Desktop-only — the browser preview has no backend to union masks.
  const handleMergeLayers = useCallback(
    (layerIds: string[]) => {
      const node = selectedNode;
      const asset = layeredAsset;
      if (!node || !asset || layerIds.length < 2) return;
      const members = layerIds
        .map((id) => findLayer(asset, id))
        .filter((layer): layer is NonNullable<typeof layer> => layer !== null && !layer.locked);
      if (members.length < 2) return;
      const mergedId = `layer_merged_${Date.now().toString(36)}`;
      void mergeLayerMasks({
        imagePath: asset.base_image.path,
        maskPaths: members.map((layer) => layer.mask.path),
        outputName: `${asset.id}_${mergedId}`,
      })
        .then((artifacts) => {
          if (!artifacts) return;
          const next = mergeLayersIntoAsset(
            asset,
            members.map((layer) => layer.id),
            {
              id: mergedId,
              name: `merged (${members.map((layer) => layer.name).join(" + ")})`,
              mask: { path: artifacts.mask_path, width: artifacts.width, height: artifacts.height },
              rgba: { path: artifacts.rgba_path, width: artifacts.width, height: artifacts.height },
              bbox: artifacts.bbox,
            },
          );
          setNodes((ns) =>
            ns.map((n) =>
              n.id === node.id
                ? { ...n, data: { ...(n.data as HgripeNodeData), layeredAsset: next } }
                : n,
            ),
          );
          setSelectedLayerId((id) => (id && layerIds.includes(id) ? mergedId : id));
        })
        .catch((err) => setMessage(String(err)));
    },
    [selectedNode, layeredAsset, setNodes, setMessage],
  );

  // Review Editor "split layer": break the selected layer's mask into its
  // connected components on the backend, then replace it in the node's stored
  // asset with one part layer per component. Desktop-only.
  const handleSplitLayer = useCallback(
    (layerId: string) => {
      const node = selectedNode;
      const asset = layeredAsset;
      if (!node || !asset) return;
      const source = findLayer(asset, layerId);
      if (!source || source.locked) return;
      const splitTag = `layer_part_${Date.now().toString(36)}`;
      void splitLayerMask({
        imagePath: asset.base_image.path,
        maskPath: source.mask.path,
        outputName: `${asset.id}_${splitTag}`,
      })
        .then((artifacts) => {
          if (!artifacts || artifacts.length < 2) return;
          const next = splitLayerInAsset(
            asset,
            layerId,
            artifacts.map((part, n) => ({
              id: `${splitTag}_${n + 1}`,
              name: `${source.name} part ${n + 1}`,
              mask: { path: part.mask_path, width: part.width, height: part.height },
              rgba: { path: part.rgba_path, width: part.width, height: part.height },
              bbox: part.bbox,
            })),
          );
          setNodes((ns) =>
            ns.map((n) =>
              n.id === node.id
                ? { ...n, data: { ...(n.data as HgripeNodeData), layeredAsset: next } }
                : n,
            ),
          );
          setSelectedLayerId((id) => (id === layerId ? `${splitTag}_1` : id));
        })
        .catch((err) => setMessage(String(err)));
    },
    [selectedNode, layeredAsset, setNodes, setMessage],
  );

  // Static validation surfaced in the toolbar (type mismatches, cycles, …).
  const issues = useMemo(
    () => validateGraph(toWorkflowGraph(nodes, edges)),
    [nodes, edges],
  );

  // File/persistence layer: workspace autosave, explicit save/open into a
  // project folder, recent files, and the project-scoped snapshot history. The
  // editor reaches it through the returned actions/state; graph mutation stays
  // here. (Run/log/history live in useStudioRunController, below.)
  const file = useStudioFileController({
    nodes,
    edges,
    setNodes,
    setEdges,
    setSelectedId,
    takeSnapshot,
    setMessage,
    sampleNodes: initialNodes,
    sampleEdges: initialEdges,
    restoredOnMount: restoredOnMount.current,
    openInCanvasTab: useCallback(
      (graph: WorkflowGraph, path: string | null) => {
        const { nodes, edges } = fromWorkflowGraph(graph);
        return canvas.openCanvasWith({ nodes, edges, path });
      },
      [canvas],
    ),
  });
  const {
    saved,
    currentFile,
    fileDirty,
    projectDir,
    workflowFiles,
    recentFiles,
    showProject,
    setShowProject,
    projectBusy,
    fileInputRef,
    handleSave,
    handleSaveAs,
    handleOpen,
    handlePickFolder,
    handleNewInFolder,
    handleRenameFile,
    handleDuplicateFile,
    handleDeleteFile,
    openFromPath,
    refreshProjectFiles,
    load,
    clear,
    resetSample,
    snapshots,
    showSnapshots,
    setShowSnapshots,
    snapshotDiff,
    clearSnapshotDiff,
    autoSnapshot,
    setAutoSnapshot,
    captureSnapshot,
    restoreSnapshot,
    diffSnapshot,
    renameSnapshotById,
    deleteSnapshot,
    projectStoreDir,
    autoSnapshotBeforeRun,
    suppressNextDirty,
    adoptFileState,
    autosaveRestoreDone,
  } = file;

  // Tab switches park/rebind the controller-owned file state (path + dirty);
  // re-registered every render so the bridge always reads the live values.
  useEffect(() => {
    canvas.registerFileBridge({
      get: () => ({ path: currentFile, dirty: fileDirty }),
      set: (path, dirty) => {
        suppressNextDirty();
        adoptFileState(path, dirty);
      },
    });
  });

  // Re-apply the persisted GPU lane width once on mount (GPU plan long-term
  // step 5): the scheduler starts at 1; a stored wider setting is best-effort.
  useEffect(() => {
    const stored = getGpuMaxJobs();
    if (stored > 1) applyGpuMaxJobs(stored).catch(() => {});
  }, []);

  // Restore the persisted project manifest (open canvas tabs) once on mount
  // (multi-canvas plan Phase 4). When a manifest exists it wins over the
  // legacy single-graph autosave the file controller restores.
  const manifestRestored = useRef(false);
  // Persisting is held until the restore settles, so a fresh session never
  // overwrites the previous session's manifest with its initial single tab.
  const [manifestReady, setManifestReady] = useState(false);
  useEffect(() => {
    // Wait for the legacy restore to settle so the manifest applies on top.
    if (!autosaveRestoreDone || manifestRestored.current) return;
    manifestRestored.current = true;
    const apply = (manifest: ProjectManifest | null) => {
      if (!manifest) return;
      canvas.restoreCanvases(
        manifest.activeCanvasId,
        manifest.canvases.map((c) => {
          const graph = fromWorkflowGraph(c.graph);
          return {
            id: c.id,
            path: c.path,
            dirty: c.dirty,
            name: c.name,
            selectedNodeId: c.selectedNodeId,
            viewport: c.viewport,
            nodes: graph.nodes,
            edges: graph.edges,
          };
        }),
      );
      setMessage(t("canvasTabs.restored"));
    };
    if (isDesktop) {
      void readStudioProjectManifest()
        .then((raw) => apply(parseProjectManifest(raw)))
        .catch((err) => setMessage(`project manifest restore failed: ${String(err)}`))
        .finally(() => setManifestReady(true));
    } else {
      apply(loadLocalProjectManifest());
      setManifestReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveRestoreDone]);

  // Persist the project manifest (debounced) so the tab set survives a
  // restart. Runs alongside the legacy single-graph autosave.
  useEffect(() => {
    if (!manifestReady) return;
    const timer = setTimeout(() => {
      const { activeCanvasId, canvases } = canvas.exportCanvases({
        path: currentFile,
        dirty: fileDirty,
      });
      const manifest: ProjectManifest = {
        version: 1,
        activeCanvasId,
        canvases: canvases.map((c) => ({
          id: c.id,
          path: c.path,
          dirty: c.dirty,
          name: c.name ?? null,
          selectedNodeId: c.selectedNodeId,
          viewport: c.viewport,
          graph: toWorkflowGraph(c.nodes, c.edges),
        })),
      };
      if (isDesktop) {
        void writeStudioProjectManifest(serializeProjectManifest(manifest)).catch((err) =>
          setMessage(`project manifest save failed: ${String(err)}`),
        );
      } else {
        saveLocalProjectManifest(manifest);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [manifestReady, canvas, nodes, edges, selectedId, currentFile, fileDirty, isDesktop, setMessage]);

  // Project-level batch (multi-canvas plan Phase 5): run every open canvas's
  // graph in tab order. Defined below the run controller (see runAllCanvases).
  const runProjectRef = useRef<((canvases: ProjectRunCanvas[]) => Promise<void>) | null>(null);
  const runAllCanvases = useCallback(() => {
    const { activeCanvasId, canvases } = canvas.exportCanvases({
      path: currentFile,
      dirty: fileDirty,
    });
    const untitled = t("status.untitled");
    void runProjectRef.current?.(
      canvases.map((c) => ({
        id: c.id,
        title: canvasDocumentTitle(c.path, untitled),
        active: c.id === activeCanvasId,
        graph: toWorkflowGraph(c.nodes, c.edges),
      })),
    );
  }, [canvas, currentFile, fileDirty, t]);

  // Per-tab file/graph actions (canvas tab row): a non-active tab is
  // activated first, then the action runs once its state is live in the
  // editor.
  type TabAction = "save" | "saveAs" | "reset" | "clear";
  const [pendingTabAction, setPendingTabAction] = useState<{
    id: string;
    action: TabAction;
  } | null>(null);
  const requestTabAction = useCallback(
    (id: string, action: TabAction) => {
      if (id !== canvas.documentId) activateCanvas(id);
      setPendingTabAction({ id, action });
    },
    [canvas.documentId, activateCanvas],
  );
  useEffect(() => {
    if (!pendingTabAction || pendingTabAction.id !== canvas.documentId) return;
    const { action } = pendingTabAction;
    setPendingTabAction(null);
    if (action === "save") void handleSave();
    else if (action === "saveAs") void handleSaveAs();
    else if (action === "reset") resetSample();
    else clear();
  }, [pendingTabAction, canvas.documentId, handleSave, handleSaveAs, resetSample, clear]);

  // Close a canvas tab, confirming first when it holds unsaved edits.
  const closeCanvasTab = useCallback(
    (id: string) => {
      const dirty = id === canvas.documentId ? fileDirty : canvas.tabs.find((t) => t.id === id)?.dirty;
      if (dirty && !window.confirm(t("canvasTabs.confirmClose"))) return;
      closeCanvas(id);
    },
    [canvas.documentId, canvas.tabs, fileDirty, closeCanvas, t],
  );

  // Modal-open state (Preview / Mask-Edit / Crop-Edit / media manual editor)
  // and the connected-image lookup the modals underlay with.
  const {
    previewNode,
    maskEditNode,
    cropEditNode,
    gradeEditNode,
    mediaEditSource,
    setPreviewNodeId,
    setMaskEditNodeId,
    setCropEditNodeId,
    setGradeEditNodeId,
    setMediaEditSourceId,
    openPreview,
    openMaskEdit,
    openCropEdit,
    openGradeEdit,
    openMediaEdit,
    connectedImagePath,
  } = useModals({ nodes, edges });

  // Right-click on an image bin asset / still clip: reopen the existing
  // unified image editor (mask + crop) on the asset's source node, so the
  // drawer never grows a second image-editing surface.
  const handleOpenImageEdit = useCallback(
    (assetId: string) => {
      const asset = binAssets.find((a) => a.id === assetId);
      if (!asset || asset.kind !== "image") return;
      if (asset.sourceNodeId && nodes.some((n) => n.id === asset.sourceNodeId)) {
        openMediaEdit(asset.sourceNodeId);
      } else {
        setMessage(t("drawer.imageEditNoSource"));
      }
    },
    [binAssets, nodes, openMediaEdit, setMessage, t],
  );

  // Right-click on an audio clip: open the minimal trim/gain/fade editor.
  const handleOpenAudioEdit = useCallback(
    (clipId: string) => {
      const found = findClip(timeline, clipId);
      if (found && found.clip.kind === "audio") setAudioEditClipId(clipId);
    },
    [timeline],
  );

  // Clip context menu “grade”: open the grade modal for a still / video clip.
  const handleOpenClipGrade = useCallback(
    (clipId: string) => {
      const found = findClip(timeline, clipId);
      if (!found || found.clip.kind === "audio") return;
      selectClip(productionStore, clipId);
      setGradeClipId(clipId);
    },
    [timeline],
  );

  const handleAudioEditCommit = useCallback(
    (edit: AudioClipEdit) => {
      // The store clamps the edit and reflects the trimmed span on the clip.
      if (audioEditClipId) commitAudioEdit(productionStore, audioEditClipId, edit);
      setAudioEditClipId(null);
    },
    [audioEditClipId],
  );

  const audioEditClip = audioEditClipId ? findClip(timeline, audioEditClipId) : null;

  // The program monitor applies each clip's stored grade doc to its frames —
  // the same per-target documents the Grade tab edits.
  const clipGradeDoc = useCallback(
    (clipId: string): string | null => {
      const key = clipGradeKey(timeline, clipId);
      return key ? (gradeDocs[key] ?? null) : null;
    },
    [timeline, gradeDocs],
  );

  // The export mixdown applies each audio clip's stored edit (trim / gain /
  // fades) — the same documents the audio edit modal commits.
  const clipAudioEdit = useCallback(
    (clipId: string): AudioClipEdit | null => audioEdits[clipId]?.edit ?? null,
    [audioEdits],
  );


  // Node/graph editing actions: add/delete/duplicate, param edits, clipboard,
  // focus/selection, tidy layout, and bound-edit spawning.
  const {
    clipboard,
    newNodeId,
    patchNode,
    onParamChange,
    addNode,
    copySelection,
    pasteClipboard,
    focusNode,
    jumpToNode,
    deleteNode,
    disconnectNode,
    duplicateNode,
    tidyLayout,
    selectAll,
    addBoundEdit,
  } = useNodeEditing({
    nodes,
    edges,
    setNodes,
    setEdges,
    setSelectedId,
    takeSnapshot,
    setMessage,
    fitView,
    suppressNextDirty,
    pendingRunNode,
    openMaskEditorFor: setMaskEditNodeId,
    openCropEditorFor: setCropEditNodeId,
  });

  // Ingest OS files dropped onto the canvas: create a generic media card per
  // recognised file (an `imageSource` for images, a `videoSource` for videos),
  // path pre-filled at the drop point and cascading multiple drops in drop
  // order. The Tauri drop position is physical px, so divide by the device pixel
  // ratio before mapping to flow space.
  const ingestDroppedFiles = useCallback(
    (paths: string[], physical: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      const origin = screenToFlowPosition({ x: physical.x / dpr, y: physical.y / dpr });
      const media = paths.flatMap((path) => {
        const ext = dropExtension(path);
        if (IMAGE_DROP_EXTS.has(ext)) return [{ path, kind: "imageSource" }];
        if (VIDEO_DROP_EXTS.has(ext)) return [{ path, kind: "videoSource" }];
        return [];
      });
      if (media.length === 0) {
        setMessage(t("canvas.dropUnsupported"));
        return;
      }
      takeSnapshot();
      const created = media.map(({ path, kind }, i) => ({
        ...makeNode(newNodeId(kind), kind, origin.x + i * 28, origin.y + i * 28, { path }),
        selected: i === media.length - 1,
      }));
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...created]);
      setSelectedId(created[created.length - 1]?.id ?? null);
      // Warm the backend ingestion pipeline for the dropped images: it probes
      // header dims and decodes thumbnails off the UI thread, pushing both to
      // the cards over `ingest://progress`. Fire-and-forget; cards still have
      // their own probe/lazy-thumbnail fallback.
      void primeIngest(
        media.filter((m) => m.kind === "imageSource").map((m) => m.path),
      );
      const images = media.filter((m) => m.kind === "imageSource").length;
      const videos = media.length - images;
      const note =
        images > 0 && videos > 0
          ? t("canvas.dropMedia", { images, videos })
          : videos > 0
            ? t("canvas.dropVideos", { n: videos })
            : t("canvas.dropImages", { n: images });
      setMessage(note);
    },
    [screenToFlowPosition, setNodes, takeSnapshot, newNodeId, setMessage, t],
  );

  // Timeline clip context menu “split to layers” (IMAGE_TO_LAYERED_PSD plan,
  // Phase 5): wire the clip's media into a Smart Layer Split card on the
  // canvas — reusing the clip's source card when it still exists, else
  // creating one from the bin asset's path — and select the split card so the
  // drawer's review panel targets its layers. A video clip connects to the
  // split card's video input; the node's frame time picks the still to split.
  const handleSplitClipToLayers = useCallback(
    (clipId: string) => {
      const found = findClip(timeline, clipId);
      if (!found || found.clip.kind === "audio") return;
      const asset = binAssets.find((a) => a.id === found.clip.assetId);
      if (!asset || asset.kind === "audio") return;
      takeSnapshot();
      const existing = asset.sourceNodeId
        ? nodes.find((n) => n.id === asset.sourceNodeId)
        : undefined;
      const handle = asset.kind === "video" ? "video" : "image";
      const created: Node[] = [];
      let sourceId: string;
      let sourcePos: { x: number; y: number };
      if (existing) {
        sourceId = existing.id;
        sourcePos = existing.position;
      } else {
        const sourceKind = asset.kind === "video" ? "videoSource" : "imageSource";
        sourceId = newNodeId(sourceKind);
        sourcePos = screenToFlowPosition({
          x: window.innerWidth / 2 - 320,
          y: window.innerHeight / 3,
        });
        created.push(makeNode(sourceId, sourceKind, sourcePos.x, sourcePos.y, { path: asset.path }));
      }
      const splitId = newNodeId("smartLayerSplit");
      created.push({
        ...makeNode(splitId, "smartLayerSplit", sourcePos.x + 320, sourcePos.y),
        selected: true,
      });
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...created]);
      setEdges((es) =>
        es.concat({
          id: `edge-${splitId}`,
          source: sourceId,
          sourceHandle: handle,
          target: splitId,
          targetHandle: handle,
        }),
      );
      handleCanvasSelect(splitId);
      setMessage(t("drawer.splitLayersCreated"));
    },
    [
      timeline,
      binAssets,
      nodes,
      takeSnapshot,
      newNodeId,
      screenToFlowPosition,
      setNodes,
      setEdges,
      handleCanvasSelect,
      setMessage,
      t,
    ],
  );

  // Software-level Prompt Assistant (PROMPT_ASSISTANT_SYSTEM_PLAN): a right
  // tool rail + docked panel that stays reachable while the bottom drawer is
  // open. The panel drafts prompt text; the graph only receives what the user
  // explicitly inserts.
  const [assistantOpen, setAssistantOpen] = useState(loadAssistantOpen);
  const toggleAssistant = useCallback(() => {
    setAssistantOpen((open) => {
      saveAssistantOpen(!open);
      return !open;
    });
  }, []);
  const assistantInsertTarget = useMemo(() => {
    const node = nodes.find((n) => n.id === selectedId);
    if (!node) return null;
    const kind = String((node.data as HgripeNodeData).kind);
    return isAssistantInsertTarget(kind) ? node : null;
  }, [nodes, selectedId]);
  const handleAssistantInsert = useCallback(
    (text: string) => {
      const target = assistantInsertTarget;
      if (!target || !text) return;
      const kind = String((target.data as HgripeNodeData).kind);
      if (isPromptTextTarget(kind)) {
        onParamChange(target.id, "text", text);
        setMessage(t("assistant.inserted"));
        return;
      }
      // Generate card: route the draft to whatever feeds its `prompt` input.
      const plan = planGenerateInsert(target.id, edges, (id) => {
        const n = nodes.find((x) => x.id === id);
        return n ? String((n.data as HgripeNodeData).kind) : null;
      });
      if (plan.action === "update_upstream") {
        onParamChange(plan.nodeId, "text", text);
        setMessage(t("assistant.insertedUpstream", { id: plan.nodeId }));
        return;
      }
      if (plan.action === "blocked") {
        setMessage(t("assistant.insertBlocked", { id: plan.nodeId }));
        return;
      }
      takeSnapshot();
      const id = newNodeId("promptOptimize");
      setNodes((ns) =>
        ns.concat(
          makeNode(id, "promptOptimize", target.position.x - 320, target.position.y + 40, {
            text,
          }),
        ),
      );
      setEdges((es) =>
        es.concat({
          id: `edge-${id}`,
          source: id,
          sourceHandle: "text",
          target: target.id,
          targetHandle: "prompt",
        }),
      );
      setMessage(t("assistant.insertedWired"));
    },
    [
      assistantInsertTarget,
      nodes,
      edges,
      onParamChange,
      takeSnapshot,
      newNodeId,
      setNodes,
      setEdges,
      setMessage,
      t,
    ],
  );
  const handleAssistantCreate = useCallback(
    (text: string) => {
      if (!text) return;
      takeSnapshot();
      const id = newNodeId("promptOptimize");
      const pos = screenToFlowPosition({
        x: window.innerWidth / 2 - 140,
        y: window.innerHeight / 3,
      });
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...makeNode(id, "promptOptimize", pos.x, pos.y, { text }), selected: true },
      ]);
      handleCanvasSelect(id);
      setMessage(t("assistant.created"));
    },
    [takeSnapshot, newNodeId, screenToFlowPosition, setNodes, handleCanvasSelect, setMessage, t],
  );

  // Subscribe to the Tauri webview file-drop (desktop only; browser preview has
  // no native drag-drop paths). Re-subscribes if the handler identity changes.
  useEffect(() => {
    // Register the shared ingest-progress sink before any drop can fire.
    startIngestListener();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listenFileDrop((e) => ingestDroppedFiles(e.paths, e.position)).then((fn) => {
      if (disposed) fn?.();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ingestDroppedFiles]);

  // After a drag, (re)assign the node to whatever group frame now contains it,
  // or detach it when dropped outside every group. Groups themselves are never
  // reparented. The pre-drag snapshot (taken on drag start) covers the undo.
  const handleNodeDragStop = useCallback(
    (dragged: Node) => {
      if (isGroupNode(dragged)) return;
      setNodes((ns) => {
        const merged = ns.map((n) =>
          n.id === dragged.id
            ? { ...n, position: dragged.position, parentId: dragged.parentId, measured: dragged.measured ?? n.measured }
            : n,
        );
        const groupId = findContainingGroup(dragged.id, merged);
        return reparentNode(merged, dragged.id, groupId);
      });
    },
    [setNodes],
  );

  // Snapshot before structural changes that React Flow applies itself
  // (deletions, and the start of a drag), so they can be undone.
  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (changes.some((c) => c.type === "remove")) {
        takeSnapshot();
        // When a group frame is deleted, free its members (back to absolute
        // coords) so they survive instead of becoming orphaned children.
        const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
        const removedGroups = new Set(
          nodes.filter((n) => removed.has(n.id) && isGroupNode(n)).map((n) => n.id),
        );
        if (removedGroups.size > 0) {
          setNodes((ns) => detachChildren(ns, removedGroups));
        }
      } else if (changes.some((c) => c.type === "position" && c.dragging) && !dragging.current) {
        dragging.current = true;
        takeSnapshot();
      }
      if (changes.some((c) => c.type === "position" && c.dragging === false)) {
        dragging.current = false;
      }
      // Alignment guides: while dragging a single node, snap its edges to other
      // nodes' edges and surface the guide lines. Grid snapping (if enabled) is
      // applied by React Flow separately and composes with this.
      let lines: { horizontal?: number; vertical?: number } = {};
      if (changes.length === 1 && changes[0].type === "position" && changes[0].dragging && changes[0].position) {
        const change = changes[0] as NodePositionChange;
        const helper = getHelperLines(change, nodes);
        if (helper.snapPosition.x !== undefined) change.position!.x = helper.snapPosition.x;
        if (helper.snapPosition.y !== undefined) change.position!.y = helper.snapPosition.y;
        lines = { horizontal: helper.horizontal, vertical: helper.vertical };
      }
      setHelperLines(lines);
      onNodesChange(changes);
    },
    [onNodesChange, takeSnapshot, nodes, setNodes],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      if (changes.some((c) => c.type === "remove")) takeSnapshot();
      onEdgesChange(changes);
    },
    [onEdgesChange, takeSnapshot],
  );

  // The run lifecycle, run log, and run history live in their own controller.
  // The editor reaches it through these callbacks and consumes the returned
  // view state (panel toggles, counts, run actions).
  const {
    running,
    canCancel,
    runLog,
    showLog,
    setShowLog,
    clearLog,
    exportLog,
    runHistory,
    showHistory,
    setShowHistory,
    clearHistory,
    run,
    runUpToNode,
    runCardRow,
    runCard,
    runSelection,
    runSelectionOnly,
    runNodeDownstream,
    runBatch,
    runProject,
    cancelRun,
    hasBatch,
    batchCount,
  } = useStudioRunController({
    nodes,
    edges,
    setNodes,
    patchNode,
    focusNode,
    setMessage,
    autoSnapshotBeforeRun,
    projectStoreDir,
  });
  runProjectRef.current = runProject;

  // Fire a queued "run up to node" after the committing param edit has been
  // applied to `nodes` (so the partial run sees the fresh params). Cleared
  // immediately so it triggers exactly once per request.
  useEffect(() => {
    const target = pendingRunNode.current;
    if (!target) return;
    pendingRunNode.current = null;
    void runUpToNode(target);
  }, [nodes, runUpToNode]);

  // Switch the rendering style of all edges (and future ones). Binding edges
  // keep their distinct style — the global edge style applies to data wires.
  const changeEdgeType = useCallback(
    (t: EdgeStyle) => {
      setEdgeType(t);
      setEdges((es) => es.map((e) => (e.id.startsWith("binding-") ? e : { ...e, type: t })));
    },
    [setEdges],
  );

  // Toolbar selection-run command: run the selected nodes plus upstream
  // (RunScope `selection_with_upstream`; plan "Toolbar" affordances).
  const selectedNodeIds = useMemo(
    () => nodes.filter((n) => n.selected).map((n) => n.id),
    [nodes],
  );
  // Canvas run HUD: map the HUD's scope choice onto the run controller's
  // scoped entry points (full canvas / selection + upstream / selection only).
  const runHudScope = useCallback(
    (scope: RunHudScope) => {
      if (scope === "selection_with_upstream") void runSelection(selectedNodeIds);
      else if (scope === "selection_only") void runSelectionOnly(selectedNodeIds);
      else void run();
    },
    [run, runSelection, runSelectionOnly, selectedNodeIds],
  );

  // Right-click context menu: open state + item list built from the editing
  // actions above.
  const { menu, menuItems, openNodeMenu, openPaneMenu, closeMenu } = useContextMenu({
    nodes,
    edges,
    clipboard,
    fitView,
    addBoundEdit,
    duplicateNode,
    disconnectNode,
    deleteNode,
    tidyLayout,
    pasteClipboard,
    runUpToNode,
    runCard,
    runNodeDownstream,
  });

  // Global keyboard shortcuts (edit + file/run); see the hook for behavior.
  useKeyboardShortcuts({
    undo,
    redo,
    selectAll,
    copySelection,
    pasteClipboard,
    save: () => void handleSave(),
    saveAs: () => void handleSaveAs(),
    open: () => void handleOpen(),
    newWorkflow: openNewCanvas,
    run: () => void run(),
    canRun: !running && issues.length === 0,
  });

  // Stable context value so memoized node cards can edit their own params.
  const editing = useMemo(
    () => ({
      onParamChange,
      // The card settings (gear) button; its surface is to be designed, so
      // clicking only selects the node for now.
      onCardSettings: (nodeId: string) => {
        setSelectedId(nodeId);
      },
      openPreview,
      openImagePreview: setImagePreviewPath,
      openMaskEdit,
      openCropEdit,
      openGradeEdit,
      openMediaEdit,
      openModels: (capability?: ModelCapability | null) =>
        setModelsRequest({ capability: capability ?? null }),
      openAssistant: (nodeId: string) => {
        handleCanvasSelect(nodeId);
        saveAssistantOpen(true);
        setAssistantOpen(true);
      },
      addBoundEdit,
      runUpToNode,
      runCardRow,
      runCard,
      runNodeDownstream,
    }),
    [onParamChange, openPreview, openMaskEdit, openCropEdit, openGradeEdit, openMediaEdit, handleCanvasSelect, addBoundEdit, runUpToNode, runCardRow, runCard, runNodeDownstream],
  );

  // Canvas -> EditorHost adapter. The editors are application-level surfaces
  // that only see a target (image path + title) and initial edit data; this is
  // the one place that derives a request from node state and folds a commit
  // back into the graph (param update / bound-edit node) and the run pipeline.
  // The clip whose grade modal is open, resolved against the live timeline.
  const gradeClip = gradeClipId ? findClip(timeline, gradeClipId) : null;
  const gradeClipAsset = gradeClip
    ? (binAssets.find((a) => a.id === gradeClip.clip.assetId) ?? null)
    : null;

  const editorRequest: EditorRequest | null = gradeClip
    ? {
        editor: "grade",
        target: {
          title: gradeClipAsset?.name ?? gradeClip.clip.assetId,
          imagePath: gradeClip.clip.kind === "still" ? (gradeClipAsset?.path ?? null) : null,
          videoPath: gradeClip.clip.kind === "video" ? (gradeClipAsset?.path ?? null) : null,
        },
        initialDoc: clipGradeDoc(gradeClip.clip.id),
        onCommit: (commit) => {
          // Store the doc under the clip's target key — the same key the
          // program monitor reads through `clipGradeDoc`.
          setClipGradeDoc(productionStore, gradeClip.clip.id, commit.gradeDoc);
        },
      }
    : maskEditNode
    ? {
        editor: "mask",
        target: {
          title: t((maskEditNode.data as HgripeNodeData).kind === "subjectMask" ? "mask.titleSubject" : "mask.titleDefault"),
          imagePath: connectedImagePath(maskEditNode.id) ?? null,
          nodeId: maskEditNode.id,
        },
        initial: normalizeEditPaths((maskEditNode.data as HgripeNodeData).params.edit_paths),
        wandTolerance: Number((maskEditNode.data as HgripeNodeData).params.wand_tolerance ?? 24),
        onCommit: (edits) => {
          // Commit the edit, then run up to this node so the result shows
          // immediately (the effect fires once `nodes` reflects the commit).
          pendingRunNode.current = maskEditNode.id;
          onParamChange(maskEditNode.id, "edit_paths", edits);
        },
      }
    : cropEditNode
      ? {
          editor: "crop",
          target: {
            title: t("crop.title"),
            imagePath: connectedImagePath(cropEditNode.id) ?? null,
            nodeId: cropEditNode.id,
          },
          initialMode:
            (cropEditNode.data as HgripeNodeData).params.mode === "auto_subject"
              ? "auto_subject"
              : "manual",
          initialBox:
            Array.isArray((cropEditNode.data as HgripeNodeData).params.crop_box) &&
            ((cropEditNode.data as HgripeNodeData).params.crop_box as unknown[]).length === 4
              ? ((cropEditNode.data as HgripeNodeData).params.crop_box as [
                  number,
                  number,
                  number,
                  number,
                ])
              : null,
          initialAspect: String((cropEditNode.data as HgripeNodeData).params.aspect ?? "free"),
          initialMargin: Number((cropEditNode.data as HgripeNodeData).params.margin_pct ?? 6),
          onCommit: (commit) => {
            // Fold the editor's auto/manual choice into the node's params, then
            // run up to this node so the cropped result shows immediately. Both
            // lanes resolve through the same Compute-lane render pipeline.
            const id = cropEditNode.id;
            takeSnapshot();
            setNodes((ns) =>
              ns.map((n) =>
                n.id === id
                  ? {
                      ...n,
                      data: {
                        ...(n.data as HgripeNodeData),
                        params: {
                          ...(n.data as HgripeNodeData).params,
                          mode: commit.mode,
                          aspect: commit.aspect,
                          margin_pct: commit.marginPct,
                          crop_box: commit.cropBox,
                        },
                      },
                    }
                  : n,
              ),
            );
            pendingRunNode.current = id;
          },
        }
      : gradeEditNode
        ? {
            editor: "grade",
            target: {
              title: t("grade.title"),
              imagePath: connectedImagePath(gradeEditNode.id) ?? null,
              nodeId: gradeEditNode.id,
            },
            initialDoc:
              typeof (gradeEditNode.data as HgripeNodeData).params.grade_doc === "string"
                ? ((gradeEditNode.data as HgripeNodeData).params.grade_doc as string)
                : null,
            onCommit: (commit) => {
              // Fold the dialog's op stack into the node's grade_doc, then run
              // up to this node so the graded result shows immediately.
              pendingRunNode.current = gradeEditNode.id;
              onParamChange(gradeEditNode.id, "grade_doc", commit.gradeDoc);
            },
          }
        : mediaEditSource || mediaEditBlank
          ? (() => {
              const data = mediaEditSource ? (mediaEditSource.data as HgripeNodeData) : null;
              // Node-result → image-editor pipeline: any node result opens here
              // through the same target shape. The underlay is the node's best
              // result image — cutout, then last output, then the source path —
              // so model / API nodes (subject mask today, future LLM or
              // algorithm cards) all enter the editor the same way.
              const imagePath = data
                ? (data.cutoutImagePath ??
                  data.imagePath ??
                  (typeof data.params?.path === "string" ? (data.params.path as string) : null))
                : null;
              // Title: the image's filename, so the bar reads
              // "photo.png · image editor".
              const base = imagePath?.split(/[\\/]/).pop();
              // PS-style document tabs: one per image card on the canvas;
              // clicking a tab retargets the editor to that card.
              const tabs = nodes
                .filter((n) => (n.data as HgripeNodeData).kind === "imageSource")
                .map((n) => {
                  const d = n.data as HgripeNodeData;
                  const p =
                    d.imagePath ?? (typeof d.params?.path === "string" ? (d.params.path as string) : null);
                  return {
                    id: n.id,
                    label: p?.split(/[\\/]/).pop() || null,
                    active: n.id === mediaEditSource?.id,
                  };
                })
                // Pathless image cards have no document to show; only cards
                // with an image become tabs.
                .filter((tab): tab is { id: string; label: string; active: boolean } => tab.label != null);
              return {
                editor: "media" as const,
                target: {
                  title: base || t("mediaEdit.title"),
                  imagePath,
                  nodeId: mediaEditSource?.id ?? null,
                },
                // "Open image": lands the picked file on a new image card and
                // retargets the editor to it (a new document tab).
                onPickFile: () => void pickIntoImageEditor(),
                tabs,
                onSelectTab: (id: string) => {
                  setMediaEditBlank(false);
                  setMediaEditSourceId(id);
                },
                initial: mediaEditSource ? (mediaEditDrafts.current.get(mediaEditSource.id) ?? null) : null,
                onDocChange: (doc: ImageDocument) => {
                  if (mediaEditSource) mediaEditDrafts.current.set(mediaEditSource.id, doc);
                },
                // Apply spawns exactly one bound edit node of the chosen kind from
                // the source (never mutating it) and runs it — same pipeline as the
                // right-click auto entries, but seeded with the manual edits.
                onCommitMask: (edits: ImageDocument) => {
                  // Pre-K2 the mask kernel executes commits, so the image
                  // document lowers to the edit_paths v3 envelope (always
                  // bridgeable until grade-kernel-only features land).
                  const lowered = toMaskDocument(edits);
                  if (mediaEditSource && lowered) {
                    mediaEditDrafts.current.delete(mediaEditSource.id);
                    addBoundEdit(mediaEditSource.id, "subjectMask", {
                      params: { edit_paths: lowered },
                      openEditor: false,
                      run: true,
                    });
                  }
                  setMediaEditSourceId(null);
                  setMediaEditBlank(false);
                },
                onCommitCrop: (commit: CropCommit) => {
                  if (mediaEditSource) {
                    addBoundEdit(mediaEditSource.id, "crop", {
                      params: {
                        mode: commit.mode,
                        aspect: commit.aspect,
                        margin_pct: commit.marginPct,
                        crop_box: commit.cropBox,
                      },
                      openEditor: false,
                      run: true,
                    });
                  }
                  setMediaEditSourceId(null);
                  setMediaEditBlank(false);
                },
              };
            })()
          : null;

  // The image card most recently viewed in the editor, so reopening lands on
  // it (PS-style: the last-looked-at document tab is the active one).
  const lastMediaEditId = useRef<string | null>(null);
  useEffect(() => {
    if (mediaEditSource) lastMediaEditId.current = mediaEditSource.id;
  }, [mediaEditSource]);

  // Toolbar entry for the unified image editor — a standalone surface: a
  // selected image card wins, then the last-viewed card, then the most recent
  // image card on the canvas; with no image cards at all the editor opens
  // blank and offers an in-editor "open image" entry.
  const openImageEditor = () => {
    const isImage = (n: Node) => (n.data as HgripeNodeData).kind === "imageSource";
    const selected = nodes.find((n) => selectedNodeIds.includes(n.id) && isImage(n));
    if (selected) {
      openMediaEdit(selected.id);
      return;
    }
    const last = lastMediaEditId.current;
    if (last && nodes.some((n) => n.id === last && isImage(n))) {
      openMediaEdit(last);
      return;
    }
    const cards = nodes.filter(isImage);
    if (cards.length > 0) {
      openMediaEdit(cards[cards.length - 1].id);
      return;
    }
    setMediaEditBlank(true);
  };

  // The preview popup's "image editor" entry: open the unified editor on the
  // image card that owns `path`, landing a new card first when the path came
  // from a derived result (mask / cutout) with no source card of its own.
  const openImageEditorOnPath = (path: string) => {
    const owner = nodes.find(
      (n) =>
        (n.data as HgripeNodeData).kind === "imageSource" &&
        (n.data as HgripeNodeData).params?.path === path,
    );
    if (owner) {
      openMediaEdit(owner.id);
      return;
    }
    takeSnapshot();
    const origin = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node = {
      ...makeNode(newNodeId("imageSource"), "imageSource", origin.x, origin.y, { path }),
      selected: true,
    };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
    setSelectedId(node.id);
    void primeIngest([path]);
    openMediaEdit(node.id);
  };

  // The blank editor's "open image" entry: pick a file, land it on a new image
  // card, and re-open the editor on that card.
  const pickIntoImageEditor = async () => {
    const path = await pickFile({
      title: t("imageEdit.pickTitle"),
      filterName: "Images",
      extensions: [...IMAGE_DROP_EXTS],
    });
    if (!path) {
      // Browser preview has no native picker; guide toward selecting a card.
      if (!isDesktop) window.alert(t("imageEdit.selectFirst"));
      return;
    }
    takeSnapshot();
    const origin = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node = {
      ...makeNode(newNodeId("imageSource"), "imageSource", origin.x, origin.y, { path }),
      selected: true,
    };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
    setSelectedId(node.id);
    void primeIngest([path]);
    setMediaEditBlank(false);
    openMediaEdit(node.id);
  };

  const closeEditor = () => {
    setGradeClipId(null);
    setMaskEditNodeId(null);
    setCropEditNodeId(null);
    setGradeEditNodeId(null);
    setMediaEditSourceId(null);
    setMediaEditBlank(false);
    // Saved drafts survive the close (the editor unmount frees the heavy
    // canvas/underlay memory); unsaved edits are dropped by design.
  };

  return (
    <div className="app">
      <Toolbar
        issues={issues}
        isDesktop={isDesktop}
        onToggleLang={onToggleLang}
        onOpenModels={() => setModelsRequest({ capability: null })}
        onOpenImageEdit={openImageEditor}
        drawerOpen={drawerMode !== "collapsed"}
        onToggleDrawer={() => changeDrawerMode(toggleDrawer(drawerMode))}
        showProject={showProject}
        setShowProject={setShowProject}
        showSnapshots={showSnapshots}
        setShowSnapshots={setShowSnapshots}
        showLog={showLog}
        setShowLog={setShowLog}
        snapshotCount={snapshots.length}
        logCount={runLog.length}
        nodes={nodes}
        onJumpToNode={jumpToNode}
        fileInputRef={fileInputRef}
        onFilePicked={(f) => void load(f)}
      />

      <CanvasTabs
        tabs={canvas.tabs}
        activeId={canvas.documentId}
        activePath={currentFile}
        activeDirty={fileDirty}
        onActivate={activateCanvas}
        onClose={closeCanvasTab}
        onNewCanvas={openNewCanvas}
        onOpenFile={() => void handleOpen()}
        onSaveTab={(id) => requestTabAction(id, "save")}
        onSaveAsTab={(id) => requestTabAction(id, "saveAs")}
        onRenameTab={renameCanvas}
        onResetTab={(id) => requestTabAction(id, "reset")}
        onClearTab={(id) => requestTabAction(id, "clear")}
        onRunProject={runAllCanvases}
        running={running}
      />

      <NodeEditingContext.Provider value={editing}>
        {isDesktop && showProject && (
          <div className="media-viewer-backdrop" onClick={() => setShowProject(false)}>
            <div className="project-modal" onClick={(e) => e.stopPropagation()}>
              <ProjectPanel
                projectDir={projectDir}
                files={workflowFiles}
                recentFiles={recentFiles}
                currentFile={currentFile}
                busy={projectBusy}
                onPickFolder={() => void handlePickFolder()}
                onRefresh={() => projectDir && void refreshProjectFiles(projectDir)}
                onOpenFile={(path) => {
                  setShowProject(false);
                  void openFromPath(path);
                }}
                onNew={() => {
                  setShowProject(false);
                  openNewCanvas();
                }}
                onNewInFolder={() => void handleNewInFolder()}
                onRenameFile={(path) => void handleRenameFile(path)}
                onDuplicateFile={(path) => void handleDuplicateFile(path)}
                onDeleteFile={(path) => void handleDeleteFile(path)}
              />
            </div>
          </div>
        )}
        {showSnapshots && (
          <div className="media-viewer-backdrop" onClick={() => setShowSnapshots(false)}>
            <div className="project-modal" onClick={(e) => e.stopPropagation()}>
              <SnapshotsPanel
                snapshots={snapshots}
                autoSnapshot={autoSnapshot}
                onToggleAutoSnapshot={setAutoSnapshot}
                onCapture={captureSnapshot}
                onRestore={restoreSnapshot}
                onRename={renameSnapshotById}
                onDelete={deleteSnapshot}
                onDiff={diffSnapshot}
                diff={snapshotDiff}
                onClearDiff={clearSnapshotDiff}
                onClose={() => setShowSnapshots(false)}
              />
            </div>
          </div>
        )}
        {showHistory && (
          <div className="media-viewer-backdrop" onClick={() => setShowHistory(false)}>
            <div className="project-modal" onClick={(e) => e.stopPropagation()}>
              <RunHistoryPanel
                history={runHistory}
                onClear={clearHistory}
                onClose={() => setShowHistory(false)}
                onSelectNode={(nodeId) => {
                  setShowHistory(false);
                  focusNode(nodeId);
                }}
              />
            </div>
          </div>
        )}
        <div className={drawerMode === "full" ? "workspace workspace-hidden" : "workspace"}>
          <Palette
            onAdd={addNode}
            edgeType={edgeType}
            onChangeEdgeType={changeEdgeType}
            showMinimap={showMinimap}
            setShowMinimap={setShowMinimap}
            snapToGrid={snapToGrid}
            setSnapToGrid={setSnapToGrid}
            onTidyLayout={tidyLayout}
          />
          <div className="canvas">
            <div className="canvas-flow">
              <FlowCanvas
                nodes={nodes}
                edges={edges}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                setEdges={setEdges}
                onSelect={handleCanvasSelect}
                onAddNode={addNode}
                onBeforeConnect={takeSnapshot}
                onNodeDragStop={handleNodeDragStop}
                onViewportChange={setViewport}
                viewportKey={canvas.documentId}
                viewport={canvas.viewport}
                snapToGrid={snapToGrid}
                helperLines={helperLines}
                edgeType={edgeType}
                showMinimap={showMinimap}
                onNodeContextMenu={openNodeMenu}
                onPaneContextMenu={openPaneMenu}
              />
              <RunHud
                nodes={nodes}
                edges={edges}
                running={running}
                canCancel={canCancel}
                issueCount={issues.length}
                selectedNodeIds={selectedNodeIds}
                onRunScope={runHudScope}
                onCancelRun={cancelRun}
                hasBatch={hasBatch}
                batchCount={batchCount}
                onRunBatch={() => void runBatch()}
                showHistory={showHistory}
                historyCount={runHistory.length}
                onToggleHistory={() => setShowHistory((s) => !s)}
              />
              <div className="canvas-status" aria-live="polite">
                {message && (
                  <span className="canvas-status-message" title={message}>
                    {message}
                  </span>
                )}
                <span className="canvas-status-autosave" title={t("status.autosaveTitle")}>
                  {saved ? t("status.autosaved") : t("status.saving")}
                </span>
                <button
                  className="canvas-status-history"
                  onClick={undo}
                  disabled={!history.canUndo}
                  title={t("btn.undoTitle")}
                  aria-label={t("btn.undoTitle")}
                >
                  <UndoIcon />
                </button>
                <button
                  className="canvas-status-history"
                  onClick={redo}
                  disabled={!history.canRedo}
                  title={t("btn.redoTitle")}
                  aria-label={t("btn.redoTitle")}
                >
                  <RedoIcon />
                </button>
              </div>
            </div>
            {showLog && (
              <RunLog
                entries={runLog}
                onClear={clearLog}
                onClose={() => setShowLog(false)}
                onExport={exportLog}
                onSelectNode={focusNode}
              />
            )}
          </div>
        </div>
        <ProductionDrawer
          mode={drawerMode}
          onSetMode={changeDrawerMode}
          target={productionTarget}
          assets={binAssets}
          activeAssetId={activeAssetId}
          onSelectAsset={handleSelectBinAsset}
          onRemoveAsset={handleRemoveBinAsset}
          addableAsset={addableAsset}
          onAddSelected={handleAddSelectedToBin}
          timeline={timeline}
          selectedClipId={selectedClipId}
          onSelectClip={handleSelectClip}
          onAddActiveToTimeline={handleAddActiveToTimeline}
          onAddActiveToTrack={handleAddActiveToTrack}
          onAddTrack={handleAddTrack}
          onRemoveTrack={handleRemoveTrack}
          onRemoveClip={handleRemoveClip}
          onOpenImageEdit={handleOpenImageEdit}
          onOpenAudioEdit={handleOpenAudioEdit}
          onOpenClipGrade={handleOpenClipGrade}
          onSplitClipToLayers={handleSplitClipToLayers}
          onOpenExport={() => setExportOpen(true)}
          clipGradeDoc={clipGradeDoc}
          layeredAsset={layeredAsset}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
          layerVisibility={layerVisibility}
          onToggleLayerVisibility={handleToggleLayerVisibility}
          onMergeLayers={isTauri() ? handleMergeLayers : undefined}
          onSplitLayer={isTauri() ? handleSplitLayer : undefined}
          onToggleProtected={handleToggleProtected}
        />
      </NodeEditingContext.Provider>
      <ToolRail assistantOpen={assistantOpen} onToggleAssistant={toggleAssistant} />
      {assistantOpen && (
        <FloatingDock>
          <PromptAssistantPanel
            insertTargetTitle={assistantInsertTarget ? assistantInsertTarget.id : null}
            onInsertIntoSelected={handleAssistantInsert}
            onCreatePromptNode={handleAssistantCreate}
            onClose={toggleAssistant}
          />
        </FloatingDock>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}

      {imagePreviewPath && (
        <PreviewModal
          title={imagePreviewPath.split(/[\\/]/).pop() || t("preview.imageTitle")}
          layers={[{ label: "Image", path: imagePreviewPath }]}
          onOpenImageEditor={() => {
            const path = imagePreviewPath;
            setImagePreviewPath(null);
            openImageEditorOnPath(path);
          }}
          onClose={() => setImagePreviewPath(null)}
        />
      )}

      {previewNode && (
        <PreviewModal
          title={(previewNode.data as HgripeNodeData).maskPath ? "Subject Mask · preview" : "Preview"}
          layers={[
            { label: "Image", path: connectedImagePath(previewNode.id) },
            { label: "Mask", path: (previewNode.data as HgripeNodeData).maskPath },
            { label: "Cutout", path: (previewNode.data as HgripeNodeData).cutoutImagePath },
          ]}
          onEdit={() => {
            const id = previewNode.id;
            setPreviewNodeId(null);
            setMaskEditNodeId(id);
          }}
          onOpenImageEditor={() => {
            const id = previewNode.id;
            setPreviewNodeId(null);
            openMediaEdit(id);
          }}
          onClose={() => setPreviewNodeId(null)}
        />
      )}

      <EditorHost request={editorRequest} onClose={closeEditor} />

      {modelsRequest && (
        <ModelManagerModal
          capability={modelsRequest.capability}
          onClose={() => setModelsRequest(null)}
        />
      )}

      {exportOpen && (
        <ExportDialog
          timeline={timeline}
          assets={binAssets}
          clipGradeDoc={clipGradeDoc}
          clipAudioEdit={clipAudioEdit}
          onClose={() => setExportOpen(false)}
        />
      )}

      {audioEditClip && audioEditClipId && (
        <AudioEditModal
          title={
            binAssets.find((a) => a.id === audioEditClip.clip.assetId)?.name ??
            audioEditClip.clip.assetId
          }
          sourceDurationSec={
            audioEdits[audioEditClipId]?.sourceDurationSec ?? audioEditClip.clip.duration
          }
          initialEdit={audioEdits[audioEditClipId]?.edit ?? defaultAudioEdit()}
          onCommit={handleAudioEditCommit}
          onClose={() => setAudioEditClipId(null)}
        />
      )}

    </div>
  );
}

export default function NodeEditor({ onToggleLang }: { onToggleLang: () => void }) {
  // Provider gives FlowCanvas access to screenToFlowPosition for drag-and-drop.
  return (
    <ReactFlowProvider>
      <Studio onToggleLang={onToggleLang} />
    </ReactFlowProvider>
  );
}
