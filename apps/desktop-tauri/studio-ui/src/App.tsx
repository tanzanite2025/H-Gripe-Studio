import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  withHgripeDataEdge,
  useReactFlow,
  type Edge,
  type Node,
} from "@hgripe/flow";

import { FlowCanvas } from "./editor/FlowCanvas";
import { RunHud } from "./editor/RunHud";
import { Palette } from "./editor/Palette";
import { ContextMenu } from "./editor/ContextMenu";
import { NodeEditingContext } from "./editor/editingContext";
import { PreviewModal } from "./editor/PreviewModal";
import { EditorHost } from "./editor/host/EditorHost";
import type { ImageDocument } from "./editor/imageDocument";
import { useHistory } from "./editor/useHistory";
import { useCanvasDocument } from "./editor/useCanvasDocument";
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
import { validateGraph } from "./runtime/dag";
import { isTauri } from "./bridge/tauri";
import { ProductionDrawer } from "./production/ProductionDrawer";
import { toggleDrawer } from "./production/drawerState";
import {
  IMAGE_MEDIA_EXTS,
  VIDEO_MEDIA_EXTS,
} from "./production/mediaBin";
import { defaultAudioEdit } from "./production/audioEdit";
import { applyGpuMaxJobs, getGpuMaxJobs } from "./bridge/scheduler";
import { unregisterNodeOutput } from "./bridge/viewport";
import { AudioEditModal } from "./production/AudioEditModal";
import { ExportDialog } from "./production/ExportDialog";
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
import { useProjectRestoreController } from "./app/useProjectRestoreController";
import { useProductionWorkspaceController } from "./app/useProductionWorkspaceController";
import { useEditorLaunchController } from "./app/useEditorLaunchController";
import { useCanvasWorkspaceController } from "./app/useCanvasWorkspaceController";

// Canvas file-drop ingestion: which dropped files become a media card. Images
// land on the generic image card (`imageSource`); videos land on the generic
// video card (`videoSource`), a separate track that shows a poster frame +
// metadata (see docs/cards/generic-media-card.md).
const IMAGE_DROP_EXTS = new Set<string>(IMAGE_MEDIA_EXTS);
const VIDEO_DROP_EXTS = new Set<string>(VIDEO_MEDIA_EXTS);

// Minimal pre-wired workflow: Prompt -> Generate.
const initialNodes: Node[] = [
  makeNode("prompt-1", "promptOptimize", 40, 120, { text: "a watercolor fox" }),
  makeNode("generate-1", "generate", 360, 80),
];
const initialEdges: Edge[] = [
  withHgripeDataEdge({
    id: "e1",
    source: "prompt-1",
    sourceHandle: "text",
    target: "generate-1",
    targetHandle: "prompt",
  }),
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
  const [showMinimap, setShowMinimap] = useState(true);
  // On-demand export dialog (plan step 9): opened by the drawer's export command.
  const [exportOpen, setExportOpen] = useState(false);
  // System "Models / APIs" manager (system model manager surface plan): one
  // application-level surface, opened from the global toolbar entry or a
  // card's "Manage…" entry (which preselects that card's capability).
  const [modelsRequest, setModelsRequest] = useState<{ capability: ModelCapability | null } | null>(null);
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
  const openNewCanvasOrWarn = useCallback(() => {
    const result = openNewCanvas();
    if (result === "limit") setMessage(t("canvasTabs.limitMessage"));
  }, [openNewCanvas, t]);

  // Node id queued for a "run up to this node" once the committing param edit
  // has landed in `nodes` state (setNodes is async, so we defer to an effect).
  const pendingRunNode = useRef<string | null>(null);
  // Per-image in-progress edit documents for the unified image editor's
  // document tabs: switching tabs remounts the editor, so drafts live here.
  const mediaEditDrafts = useRef(new Map<string, ImageDocument>());
  const [mediaDraftRevision, setMediaDraftRevision] = useState(0);

  // Deleting a canvas node cascades: its in-progress image-editor draft and
  // its host-side output registrations must not outlive it.
  const knownNodeIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    let draftsChanged = false;
    if (knownNodeIds.current) {
      for (const id of knownNodeIds.current) {
        if (ids.has(id)) continue;
        draftsChanged = mediaEditDrafts.current.delete(id) || draftsChanged;
        unregisterNodeOutput(id).catch(() => {});
      }
    }
    knownNodeIds.current = ids;
    if (draftsChanged) setMediaDraftRevision((v) => v + 1);
  }, [nodes]);

  const history = useHistory({ nodes, edges, setNodes, setEdges, scopeId: canvas.documentId });
  const { takeSnapshot, undo, redo } = history;

  const {
    activeAssetId,
    addableAsset,
    audioEdits,
    binAssets,
    changeDrawerMode,
    clipProps,
    drawerMode,
    gradeDocs,
    handleAddActiveToTimeline,
    handleAddActiveToTrack,
    handleAddExportedFrame,
    handleAddSelectedToBin,
    handleAddTrack,
    handleCanvasSelect,
    handleImportMediaToBin,
    handleMergeLayers,
    handleRemoveBinAsset,
    handleRemoveClip,
    handleRemoveMarker,
    handleRemoveTrack,
    handleSelectBinAsset,
    handleSelectClip,
    handleSetClipProperties,
    handleSplitLayer,
    handleSplitTimelineClip,
    handleToggleLayerVisibility,
    handleToggleMarker,
    handleToggleProtected,
    handleToggleTrackHidden,
    handleToggleTrackLock,
    importMediaPathsToBin,
    layeredAsset,
    layerVisibility,
    productionTarget,
    selectedClipId,
    selectedClipProperties,
    selectedLayerId,
    setSelectedLayerId,
    timeline,
  } = useProductionWorkspaceController({
    nodes,
    edges,
    selectedId,
    setSelectedId,
    setNodes,
    setMessage,
    isDesktop,
    t,
  });

  // The active graph in the renderer-agnostic model, shared by validation and
  // the run HUD preview so each edit converts once.
  const workflowGraph = useMemo(() => toWorkflowGraph(nodes, edges), [nodes, edges]);

  // Static validation surfaced in the toolbar (type mismatches, cycles, …).
  const issues = useMemo(() => validateGraph(workflowGraph), [workflowGraph]);

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
    openInCanvasTab: useCallback(
      (graph: WorkflowGraph, path: string | null) => {
        const { nodes, edges } = fromWorkflowGraph(graph);
        return canvas.openCanvasWith({ nodes, edges, path });
      },
      [canvas],
    ),
  });
  const {
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

  useProjectRestoreController({
    canvas,
    currentFile,
    fileDirty,
    isDesktop,
    mediaEditDrafts,
    mediaDraftRevision,
    setMediaDraftRevision,
    suppressNextDirty,
    setMessage,
    restoredMessage: t("canvasTabs.restored"),
  });

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
  const modals = useModals({ nodes, edges });
  const {
    previewNode,
    setPreviewNodeId,
    setMaskEditNodeId,
    setCropEditNodeId,
    openPreview,
    openMaskEdit,
    openCropEdit,
    openGradeEdit,
    openMediaEdit,
    connectedImagePath,
  } = modals;

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
        es.concat(
          withHgripeDataEdge({
            id: `edge-${id}`,
            source: id,
            sourceHandle: "text",
            target: target.id,
            targetHandle: "prompt",
          }),
        ),
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

  const {
    handleEdgesChange,
    handleNodeDragStop,
    handleNodesChange,
    handleSplitClipToLayers,
    runHudScope,
    selectedNodeIds,
  } = useCanvasWorkspaceController({
    nodes,
    setNodes,
    onNodesChange,
    setEdges,
    onEdgesChange,
    setSelectedId,
    timeline,
    binAssets,
    importMediaPathsToBin,
    handleCanvasSelect,
    newNodeId,
    takeSnapshot,
    screenToFlowPosition,
    setMessage,
    runActions: { run, runSelection, runSelectionOnly },
    imageExtensions: IMAGE_DROP_EXTS,
    videoExtensions: VIDEO_DROP_EXTS,
    t,
  });
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
    newWorkflow: openNewCanvasOrWarn,
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

  const {
    audioEditClip,
    audioEditClipId,
    clipAudioEdit,
    clipGradeDoc,
    clipPropsDoc,
    closeEditor,
    editorRequest,
    handleAudioEditCommit,
    handleOpenAudioEdit,
    handleOpenClipGrade,
    handleOpenImageEdit,
    openImageEditor,
    openImageEditorOnPath,
    setAudioEditClipId,
  } = useEditorLaunchController({
    nodes,
    setNodes,
    setSelectedId,
    binAssets,
    timeline,
    gradeDocs,
    audioEdits,
    clipProps,
    modals,
    nodeEditing: { addBoundEdit, newNodeId, onParamChange, patchNode },
    selectedNodeIds,
    pendingRunNode,
    mediaEditDrafts,
    setMediaDraftRevision,
    takeSnapshot,
    screenToFlowPosition,
    setMessage,
    isDesktop,
    imageExtensions: IMAGE_DROP_EXTS,
    t,
  });
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
        showSnapshots={showSnapshots}
        setShowSnapshots={setShowSnapshots}
        showLog={showLog}
        setShowLog={setShowLog}
        snapshotCount={snapshots.length}
        logCount={runLog.length}
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
        onNewCanvas={openNewCanvasOrWarn}
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
                  openNewCanvasOrWarn();
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
        <div className="workspace">
          <Palette
            onAdd={addNode}
            showMinimap={showMinimap}
            setShowMinimap={setShowMinimap}
            snapToGrid={snapToGrid}
            setSnapToGrid={setSnapToGrid}
            onTidyLayout={tidyLayout}
          />
          <div className="canvas">
            <div className="canvas-flow">
              <FlowCanvas
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                setEdges={setEdges}
                onSelect={handleCanvasSelect}
                onAddNode={addNode}
                onBeforeConnect={takeSnapshot}
                onBeforeEdgeEdit={takeSnapshot}
                onNodeDragStop={handleNodeDragStop}
                onViewportChange={setViewport}
                viewportKey={canvas.documentId}
                viewport={canvas.viewport}
                snapToGrid={snapToGrid}
                showMinimap={showMinimap}
                onNodeContextMenu={openNodeMenu}
                onPaneContextMenu={openPaneMenu}
              />
              <RunHud
                graph={workflowGraph}
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
          onImportMedia={handleImportMediaToBin}
          timeline={timeline}
          selectedClipId={selectedClipId}
          onSelectClip={handleSelectClip}
          onAddActiveToTimeline={handleAddActiveToTimeline}
          onAddActiveToTrack={handleAddActiveToTrack}
          onAddTrack={handleAddTrack}
          onRemoveTrack={handleRemoveTrack}
          onRemoveClip={handleRemoveClip}
          onSplitClipAt={handleSplitTimelineClip}
          onToggleMarkerAt={handleToggleMarker}
          onRemoveMarker={handleRemoveMarker}
          onToggleTrackLock={handleToggleTrackLock}
          onToggleTrackHidden={handleToggleTrackHidden}
          onOpenImageEdit={handleOpenImageEdit}
          onOpenAudioEdit={handleOpenAudioEdit}
          onOpenClipGrade={handleOpenClipGrade}
          onSplitClipToLayers={handleSplitClipToLayers}
          onOpenExport={() => setExportOpen(true)}
          onAddExportedFrame={handleAddExportedFrame}
          clipGradeDoc={clipGradeDoc}
          clipPropsDoc={clipPropsDoc}
          clipProperties={selectedClipProperties}
          onSetClipProperties={handleSetClipProperties}
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
          clipPropsDoc={clipPropsDoc}
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
