import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type NodePositionChange,
} from "@xyflow/react";

import { FlowCanvas, type EdgeStyle } from "./editor/FlowCanvas";
import { Inspector } from "./editor/Inspector";
import { Palette } from "./editor/Palette";
import { ContextMenu } from "./editor/ContextMenu";
import { NodeEditingContext } from "./editor/editingContext";
import { PreviewModal } from "./editor/PreviewModal";
import { MaskEditModal } from "./editor/MaskEditModal";
import { CropEditModal } from "./editor/CropEditModal";
import { GradeEditModal } from "./editor/GradeEditModal";
import { MediaEditModal } from "./editor/MediaEditModal";
import { normalizeEditPaths } from "./editor/maskEdit";
import { useHistory } from "./editor/useHistory";
import {
  detachChildren,
  findContainingGroup,
  isGroupNode,
  reparentNode,
} from "./editor/grouping";
import { getHelperLines } from "./editor/helperLines";
import type { HgripeNodeData } from "./editor/HgripeNode";
import { fromWorkflowGraph, toWorkflowGraph } from "./editor/adapter";
import { ProjectPanel } from "./editor/ProjectPanel";
import { Toolbar } from "./editor/Toolbar";
import { RunLog } from "./editor/RunLogPanel";
import { SnapshotsPanel } from "./editor/SnapshotsPanel";
import { RunHistoryPanel } from "./editor/RunHistoryPanel";
import { useKeyboardShortcuts } from "./editor/useKeyboardShortcuts";
import { useStudioRunController } from "./editor/useStudioRunController";
import { useStudioFileController } from "./editor/useStudioFileController";
import { makeNode, useNodeEditing } from "./editor/useNodeEditing";
import { useContextMenu } from "./editor/useContextMenu";
import { useModals } from "./editor/useModals";
import { loadPersistedGraph } from "./editor/persist";
import { validateGraph } from "./runtime/dag";
import {
  isTauri,
  listenFileDrop,
  mergeLayerMasks,
  primeIngest,
  splitLayerMask,
} from "./bridge/tauri";
import { ProductionDrawer, type AddableAsset } from "./production/ProductionDrawer";
import {
  loadDrawerMode,
  loadDrawerTab,
  saveDrawerMode,
  saveDrawerTab,
  type DrawerMode,
  type DrawerTab,
} from "./production/drawerState";
import { addAsset, assetKindForNodeKind, removeAsset, type MediaAsset } from "./production/mediaBin";
import {
  assetTarget,
  imageLayerTarget,
  layeredImageTarget,
  nodeOutputTarget,
  targetKey,
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
import {
  appendClip,
  createTimeline,
  findClip,
  removeClip,
  removeClipsForAsset,
  trimClip,
  type TimelineModel,
} from "./production/timeline";
import {
  clampAudioEdit,
  defaultAudioEdit,
  editedDuration,
  type AudioClipEdit,
} from "./production/audioEdit";
import { AudioEditModal } from "./production/AudioEditModal";
import { ExportDialog } from "./production/ExportDialog";
import { startIngestListener } from "./runtime/ingestStore";
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

// Minimal pre-wired workflow: Prompt -> Generate -> Preview.
const initialNodes: Node[] = [
  makeNode("prompt-1", "prompt", 40, 120, { text: "a watercolor fox" }),
  makeNode("generate-1", "generate", 360, 80),
  makeNode("preview-1", "preview", 700, 120),
];
const initialEdges: Edge[] = [
  { id: "e1", source: "prompt-1", sourceHandle: "text", target: "generate-1", targetHandle: "prompt" },
  { id: "e2", source: "generate-1", sourceHandle: "image", target: "preview-1", targetHandle: "image" },
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

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [helperLines, setHelperLines] = useState<{ horizontal?: number; vertical?: number }>({});
  const [edgeType, setEdgeType] = useState<EdgeStyle>("default");
  const [showMinimap, setShowMinimap] = useState(true);
  // Bottom production drawer (Edit / Timeline + Grade) shell state, plus the
  // lightweight media bin and the unified production selection it consumes.
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(() => loadDrawerMode());
  const [drawerTab, setDrawerTab] = useState<DrawerTab>(() => loadDrawerTab());
  const [binAssets, setBinAssets] = useState<MediaAsset[]>([]);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineModel>(() => createTimeline());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // Per-target grade documents (JSON strings) keyed by targetKey, edited by
  // the drawer's Grade tab through the embeddable GradePanel.
  const [gradeDocs, setGradeDocs] = useState<Record<string, string>>({});
  // Per-clip non-destructive audio edits (trim/gain/fade), plus the source
  // duration assumed when the clip was first opened (until audio probing
  // lands, the clip's untrimmed length stands in for the media length).
  const [audioEdits, setAudioEdits] = useState<
    Record<string, { edit: AudioClipEdit; sourceDurationSec: number }>
  >({});
  const [audioEditClipId, setAudioEditClipId] = useState<string | null>(null);
  // Layer selection inside the targeted layered image asset (review panel):
  // the selected candidate layer id plus per-layer visibility overrides.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  // On-demand export dialog (plan step 9): opened by the drawer's export command.
  const [exportOpen, setExportOpen] = useState(false);
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

  const history = useHistory({ nodes, edges, setNodes, setEdges });
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
  const changeDrawerTab = useCallback((tab: DrawerTab) => {
    setDrawerTab(tab);
    saveDrawerTab(tab);
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
    if (!addableAsset) return;
    setBinAssets((assets) => {
      const result = addAsset(assets, addableAsset);
      setActiveAssetId(result.asset.id);
      return result.assets;
    });
  }, [addableAsset]);

  const handleRemoveBinAsset = useCallback((id: string) => {
    setBinAssets((assets) => removeAsset(assets, id));
    setActiveAssetId((cur) => (cur === id ? null : cur));
    // Clips are references to bin assets, so they leave with the asset.
    const next = removeClipsForAsset(timeline, id);
    setTimeline(next);
    setSelectedClipId((cur) => (cur && !findClip(next, cur) ? null : cur));
  }, [timeline]);

  const handleAddActiveToTimeline = useCallback(() => {
    if (!activeAssetId) return;
    const asset = binAssets.find((a) => a.id === activeAssetId);
    if (!asset) return;
    const result = appendClip(timeline, asset);
    if (!result) return;
    setTimeline(result.timeline);
    setSelectedClipId(result.clip.id);
  }, [activeAssetId, binAssets, timeline]);

  const handleRemoveClip = useCallback((clipId: string) => {
    setTimeline((tl) => removeClip(tl, clipId));
    setSelectedClipId((cur) => (cur === clipId ? null : cur));
  }, []);

  const handleSelectClip = useCallback((clipId: string | null) => {
    setSelectedClipId(clipId);
    if (clipId) setActiveAssetId(null);
  }, []);

  const handleSelectBinAsset = useCallback((assetId: string | null) => {
    setActiveAssetId(assetId);
    if (assetId) setSelectedClipId(null);
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
    if (id) {
      setActiveAssetId(null);
      setSelectedClipId(null);
    }
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
    newWorkflow,
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
  } = file;

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

  // What the drawer's Grade tab previews for the current target: image bin
  // assets, still clips (over their source image) and image node outputs
  // grade an image; video clips grade a frame of their source video.
  const gradeSource = useMemo<{ imagePath: string | null; videoPath: string | null }>(() => {
    const none = { imagePath: null, videoPath: null };
    if (!productionTarget) return none;
    switch (productionTarget.kind) {
      case "asset": {
        const asset = binAssets.find((a) => a.id === productionTarget.assetId);
        return asset && asset.kind === "image" ? { imagePath: asset.path, videoPath: null } : none;
      }
      case "video_clip": {
        const found = findClip(timeline, productionTarget.clipId);
        const asset = found ? binAssets.find((a) => a.id === found.clip.assetId) : undefined;
        if (!found || !asset) return none;
        return found.clip.kind === "still"
          ? { imagePath: asset.path, videoPath: null }
          : { imagePath: null, videoPath: asset.path };
      }
      case "node_output":
        return { imagePath: connectedImagePath(productionTarget.nodeId), videoPath: null };
      case "layered_image":
        return layeredAsset && layeredAsset.id === productionTarget.assetId
          ? { imagePath: layeredAsset.preview_composite.path, videoPath: null }
          : none;
      case "image_layer": {
        if (!layeredAsset || layeredAsset.id !== productionTarget.assetId) return none;
        const layer = findLayer(layeredAsset, productionTarget.layerId);
        return {
          imagePath: layer?.rgba?.path ?? layeredAsset.base_image.path,
          videoPath: null,
        };
      }
      default:
        return none;
    }
  }, [productionTarget, binAssets, timeline, connectedImagePath, layeredAsset]);

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

  const handleAudioEditCommit = useCallback(
    (edit: AudioClipEdit) => {
      if (!audioEditClipId) return;
      const found = findClip(timeline, audioEditClipId);
      if (!found) {
        setAudioEditClipId(null);
        return;
      }
      const sourceDurationSec =
        audioEdits[audioEditClipId]?.sourceDurationSec ?? found.clip.duration;
      const clamped = clampAudioEdit(edit, sourceDurationSec);
      setAudioEdits((prev) => ({ ...prev, [audioEditClipId]: { edit: clamped, sourceDurationSec } }));
      // Reflect the trim on the timeline: the clip plays only the trimmed span.
      setTimeline(
        trimClip(timeline, audioEditClipId, { duration: editedDuration(clamped, sourceDurationSec) }),
      );
      setAudioEditClipId(null);
    },
    [audioEditClipId, audioEdits, timeline],
  );

  const audioEditClip = audioEditClipId ? findClip(timeline, audioEditClipId) : null;

  const handleGradeCommit = useCallback(
    (gradeDoc: string) => {
      if (!productionTarget) return;
      setGradeDocs((docs) => ({ ...docs, [targetKey(productionTarget)]: gradeDoc }));
    },
    [productionTarget],
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
    runBatch,
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
    newWorkflow,
    run: () => void run(),
    canRun: !running && issues.length === 0,
  });

  // Stable context value so memoized node cards can edit their own params.
  const editing = useMemo(
    () => ({ onParamChange, openPreview, openMaskEdit, openCropEdit, openGradeEdit, openMediaEdit, addBoundEdit, runUpToNode }),
    [onParamChange, openPreview, openMaskEdit, openCropEdit, openGradeEdit, openMediaEdit, addBoundEdit, runUpToNode],
  );

  return (
    <div className="app">
      <Toolbar
        issues={issues}
        isDesktop={isDesktop}
        currentFile={currentFile}
        fileDirty={fileDirty}
        saved={saved}
        message={message}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={undo}
        onRedo={redo}
        onToggleLang={onToggleLang}
        showProject={showProject}
        setShowProject={setShowProject}
        showSnapshots={showSnapshots}
        setShowSnapshots={setShowSnapshots}
        showLog={showLog}
        setShowLog={setShowLog}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        snapshotCount={snapshots.length}
        logCount={runLog.length}
        historyCount={runHistory.length}
        nodes={nodes}
        onJumpToNode={jumpToNode}
        onNew={newWorkflow}
        onOpen={() => void handleOpen()}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onReset={resetSample}
        onClear={clear}
        fileInputRef={fileInputRef}
        onFilePicked={(f) => void load(f)}
        snapToGrid={snapToGrid}
        setSnapToGrid={setSnapToGrid}
        onTidyLayout={tidyLayout}
        edgeType={edgeType}
        onChangeEdgeType={changeEdgeType}
        showMinimap={showMinimap}
        setShowMinimap={setShowMinimap}
        running={running}
        canCancel={canCancel}
        onRun={run}
        onCancelRun={cancelRun}
        hasBatch={hasBatch}
        batchCount={batchCount}
        onRunBatch={runBatch}
      />

      <NodeEditingContext.Provider value={editing}>
        <div className="workspace">
          {isDesktop && showProject && (
            <ProjectPanel
              projectDir={projectDir}
              files={workflowFiles}
              recentFiles={recentFiles}
              currentFile={currentFile}
              busy={projectBusy}
              onPickFolder={() => void handlePickFolder()}
              onRefresh={() => projectDir && void refreshProjectFiles(projectDir)}
              onOpenFile={(path) => void openFromPath(path)}
              onNew={newWorkflow}
              onNewInFolder={() => void handleNewInFolder()}
              onRenameFile={(path) => void handleRenameFile(path)}
              onDuplicateFile={(path) => void handleDuplicateFile(path)}
              onDeleteFile={(path) => void handleDeleteFile(path)}
            />
          )}
          {showSnapshots && (
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
          )}
          {showHistory && (
            <RunHistoryPanel
              history={runHistory}
              onClear={clearHistory}
              onClose={() => setShowHistory(false)}
              onSelectNode={focusNode}
            />
          )}
          <Palette onAdd={addNode} />
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
                snapToGrid={snapToGrid}
                helperLines={helperLines}
                edgeType={edgeType}
                showMinimap={showMinimap}
                onNodeContextMenu={openNodeMenu}
                onPaneContextMenu={openPaneMenu}
              />
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
          <Inspector node={selectedNode} onParamChange={onParamChange} />
        </div>
        <ProductionDrawer
          mode={drawerMode}
          onSetMode={changeDrawerMode}
          tab={drawerTab}
          onSetTab={changeDrawerTab}
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
          onRemoveClip={handleRemoveClip}
          onOpenImageEdit={handleOpenImageEdit}
          onOpenAudioEdit={handleOpenAudioEdit}
          onOpenExport={() => setExportOpen(true)}
          gradeImagePath={gradeSource.imagePath}
          gradeVideoPath={gradeSource.videoPath}
          gradeDoc={productionTarget ? (gradeDocs[targetKey(productionTarget)] ?? null) : null}
          onGradeCommit={handleGradeCommit}
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
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
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
          onClose={() => setPreviewNodeId(null)}
        />
      )}

      {maskEditNode && (
        <MaskEditModal
          title={t((maskEditNode.data as HgripeNodeData).kind === "subjectMask" ? "mask.titleSubject" : "mask.titleDefault")}
          imagePath={connectedImagePath(maskEditNode.id)}
          initial={normalizeEditPaths((maskEditNode.data as HgripeNodeData).params.edit_paths)}
          wandTolerance={Number((maskEditNode.data as HgripeNodeData).params.wand_tolerance ?? 24)}
          onCommit={(edits) => {
            // Commit the edit, then run up to this node so the result shows
            // immediately (the effect fires once `nodes` reflects the commit).
            pendingRunNode.current = maskEditNode.id;
            onParamChange(maskEditNode.id, "edit_paths", edits);
          }}
          onClose={() => setMaskEditNodeId(null)}
        />
      )}

      {cropEditNode && (
        <CropEditModal
          title={t("crop.title")}
          imagePath={connectedImagePath(cropEditNode.id)}
          initialMode={
            (cropEditNode.data as HgripeNodeData).params.mode === "auto_subject"
              ? "auto_subject"
              : "manual"
          }
          initialBox={
            Array.isArray((cropEditNode.data as HgripeNodeData).params.crop_box) &&
            ((cropEditNode.data as HgripeNodeData).params.crop_box as unknown[]).length === 4
              ? ((cropEditNode.data as HgripeNodeData).params.crop_box as [
                  number,
                  number,
                  number,
                  number,
                ])
              : null
          }
          initialAspect={String((cropEditNode.data as HgripeNodeData).params.aspect ?? "free")}
          initialMargin={Number((cropEditNode.data as HgripeNodeData).params.margin_pct ?? 6)}
          onCommit={(commit) => {
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
          }}
          onClose={() => setCropEditNodeId(null)}
        />
      )}

      {gradeEditNode && (
        <GradeEditModal
          title={t("grade.title")}
          imagePath={connectedImagePath(gradeEditNode.id)}
          initialDoc={
            typeof (gradeEditNode.data as HgripeNodeData).params.grade_doc === "string"
              ? ((gradeEditNode.data as HgripeNodeData).params.grade_doc as string)
              : null
          }
          onCommit={(commit) => {
            // Fold the dialog's op stack into the node's grade_doc, then run
            // up to this node so the graded result shows immediately.
            pendingRunNode.current = gradeEditNode.id;
            onParamChange(gradeEditNode.id, "grade_doc", commit.gradeDoc);
          }}
          onClose={() => setGradeEditNodeId(null)}
        />
      )}

      {exportOpen && (
        <ExportDialog timeline={timeline} assets={binAssets} onClose={() => setExportOpen(false)} />
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

      {mediaEditSource && (
        <MediaEditModal
          title={t("node.mediaEdit")}
          imagePath={
            (mediaEditSource.data as HgripeNodeData).imagePath ??
            (typeof (mediaEditSource.data as HgripeNodeData).params?.path === "string"
              ? ((mediaEditSource.data as HgripeNodeData).params.path as string)
              : null)
          }
          // Apply spawns exactly one bound edit node of the chosen kind from the
          // source (never mutating it) and runs it — same pipeline as the
          // right-click auto entries, but seeded with the manual edits.
          onCommitMask={(edits) => {
            addBoundEdit(mediaEditSource.id, "subjectMask", {
              params: { edit_paths: edits },
              openEditor: false,
              run: true,
            });
            setMediaEditSourceId(null);
          }}
          onCommitCrop={(commit) => {
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
            setMediaEditSourceId(null);
          }}
          onClose={() => setMediaEditSourceId(null)}
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
