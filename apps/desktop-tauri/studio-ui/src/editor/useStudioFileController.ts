import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Edge, Node } from "@hgripe/flow";

import { fromWorkflowGraph, toWorkflowGraph } from "./adapter";
import { baseName } from "./ProjectPanel";
import type { SnapshotDiffView } from "./SnapshotsPanel";
import { diffGraphs } from "./snapshotdiff";
import {
  addSnapshot,
  loadAutoSnapshotPref,
  loadSnapshots,
  newSnapshotId,
  parseSnapshots,
  removeSnapshot,
  renameSnapshot,
  saveAutoSnapshotPref,
  saveSnapshots,
  type Snapshot,
} from "./snapshots";
import { useProjectScopedStore } from "./useProjectScopedStore";
import { clearPersistedGraph } from "./persist";
import { deserializeGraph, serializeGraph, type WorkflowGraph } from "../graph/model";
import {
  clearStudioAutosave,
  deleteStudioWorkflow,
  duplicateStudioWorkflow,
  isTauri,
  listStudioWorkflows,
  pickProjectFolder,
  pickWorkflowOpenPath,
  pickWorkflowSavePath,
  readStudioRecents,
  readStudioSnapshots,
  readStudioWorkflow,
  renameStudioWorkflow,
  writeStudioRecents,
  writeStudioSnapshots,
  writeStudioWorkflow,
  type StudioWorkflowFile,
} from "../bridge/tauri";

function graphSaveSignature(nodes: Node[], edges: Edge[]): string {
  return serializeGraph(toWorkflowGraph(nodes, edges));
}

export interface StudioFileControllerOptions {
  /** Live editor graph (serialized on save / autosave / snapshot capture). */
  nodes: Node[];
  edges: Edge[];
  /** React Flow setters, for loading graphs back into the editor. */
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  /** Push an undo checkpoint before a destructive graph swap. */
  takeSnapshot: () => void;
  /** Surface a status-bar message. */
  setMessage: (message: string) => void;
  /** Pre-wired sample graph, restored by "reset to sample". */
  sampleNodes: Node[];
  sampleEdges: Edge[];
  /**
   * Open a loaded workflow in a new canvas tab instead of replacing the
   * active graph (multi-canvas workspace plan: "Open Workflow" imports into
   * a new tab). When the path is already open, its tab is activated.
   */
  openInCanvasTab?: (
    graph: WorkflowGraph,
    path: string | null,
  ) => "opened" | "activated" | "already-active" | "limit";
}

export interface StudioFileController {
  // --- explicit save/open + project folder ---
  /** On-disk workflow backing the editor (null = untitled). */
  currentFile: string | null;
  /** Unsaved edits against `currentFile` (separate from the workspace autosave). */
  fileDirty: boolean;
  projectDir: string | null;
  workflowFiles: StudioWorkflowFile[];
  recentFiles: string[];
  showProject: boolean;
  setShowProject: Dispatch<SetStateAction<boolean>>;
  projectBusy: boolean;
  /** Hidden <input type=file> used by the browser-preview open fallback. */
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  handleOpen: () => Promise<void>;
  handlePickFolder: () => Promise<void>;
  handleNewInFolder: () => Promise<void>;
  handleRenameFile: (path: string) => Promise<void>;
  handleDuplicateFile: (path: string) => Promise<void>;
  handleDeleteFile: (path: string) => Promise<void>;
  openFromPath: (path: string) => Promise<void>;
  refreshProjectFiles: (dir: string) => Promise<void>;
  /** Browser-preview upload handler for the hidden file input. */
  load: (file: File) => Promise<void>;
  newWorkflow: () => void;
  clear: () => void;
  resetSample: () => void;

  // --- snapshots (project-scoped version history) ---
  snapshots: Snapshot[];
  showSnapshots: boolean;
  setShowSnapshots: Dispatch<SetStateAction<boolean>>;
  snapshotDiff: SnapshotDiffView | null;
  clearSnapshotDiff: () => void;
  autoSnapshot: boolean;
  setAutoSnapshot: Dispatch<SetStateAction<boolean>>;
  captureSnapshot: () => void;
  restoreSnapshot: (id: string) => void;
  diffSnapshot: (id: string) => void;
  renameSnapshotById: (id: string) => void;
  deleteSnapshot: (id: string) => void;

  // --- shared with the run controller ---
  /** Sink folder for project-scoped stores (null → localStorage). */
  projectStoreDir: string | null;
  /** Auto-capture a snapshot before a run (when enabled and non-empty). */
  autoSnapshotBeforeRun: () => void;
  /** Suppress the next dirty-mark for a programmatic graph/selection swap. */
  suppressNextDirty: () => void;
  /** Rebind the file state (path + dirty) when the active canvas changes. */
  adoptFileState: (path: string | null, dirty: boolean) => void;
}

// Owns the studio's file layer: explicit save/open into a project folder,
// the recent-files list, and the project-scoped snapshot history. The graph
// editor (node/edge mutation, selection, undo history) stays in the caller
// and is reached through the supplied setters; this hook only swaps whole
// graphs in/out and tracks their on-disk state. The workspace autosave is
// the project manifest (App). Run/log/history live in useStudioRunController.
export function useStudioFileController({
  nodes,
  edges,
  setNodes,
  setEdges,
  setSelectedId,
  takeSnapshot,
  setMessage,
  sampleNodes,
  sampleEdges,
  openInCanvasTab,
}: StudioFileControllerOptions): StudioFileController {
  const isDesktop = isTauri();

  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [workflowFiles, setWorkflowFiles] = useState<StudioWorkflowFile[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [recentsReady, setRecentsReady] = useState(!isDesktop);

  const [snapshots, setSnapshots] = useState<Snapshot[]>(() => loadSnapshots());
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [snapshotDiff, setSnapshotDiff] = useState<SnapshotDiffView | null>(null);
  const [autoSnapshot, setAutoSnapshot] = useState<boolean>(() => loadAutoSnapshotPref());

  // Skips the next dirty-mark when the graph is swapped programmatically
  // (mount restore, open, new) rather than by a user edit.
  const skipDirty = useRef(true);
  const cleanGraphSignature = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const suppressNextDirty = useCallback(() => {
    skipDirty.current = true;
  }, []);

  // Canvas-tab switches rebind which on-disk file the editor tracks.
  const adoptFileState = useCallback((path: string | null, dirty: boolean) => {
    setCurrentFile(path);
    setFileDirty(dirty);
  }, []);

  // Swap the editor graph without flagging it as an unsaved user edit.
  const loadGraphIntoEditor = useCallback(
    (graph: WorkflowGraph) => {
      skipDirty.current = true;
      const next = fromWorkflowGraph(graph);
      setNodes(next.nodes);
      setEdges(next.edges);
      setSelectedId(null);
    },
    [setNodes, setEdges, setSelectedId],
  );

  // Project-scoped snapshot store: persisted into the selected project folder
  // on desktop (so it travels with the project), else to localStorage.
  const projectStoreDir = isDesktop ? projectDir : null;
  useProjectScopedStore({
    dir: projectStoreDir,
    state: snapshots,
    setState: setSnapshots,
    parse: parseSnapshots,
    read: readStudioSnapshots,
    write: writeStudioSnapshots,
    saveLocal: saveSnapshots,
    label: "snapshots",
    onError: setMessage,
  });

  // Persist the auto-snapshot preference.
  useEffect(() => {
    saveAutoSnapshotPref(autoSnapshot);
  }, [autoSnapshot]);

  // Capture the current graph under a given name (no prompt).
  const captureNamed = useCallback(
    (name: string) => {
      const graph = toWorkflowGraph(nodes, edges);
      const snap: Snapshot = { id: newSnapshotId(), name, t: Date.now(), graph };
      setSnapshots((list) => addSnapshot(list, snap));
      return snap;
    },
    [nodes, edges],
  );

  // Capture the current graph as a named snapshot (prompts for a name).
  const captureSnapshot = useCallback(() => {
    const suggested = `Snapshot ${new Date().toLocaleString()}`;
    const name = window.prompt("Snapshot name", suggested);
    if (name === null) return;
    const snap = captureNamed(name.trim() || suggested);
    setMessage(`snapshot saved: ${snap.name}`);
  }, [captureNamed, setMessage]);

  // Auto-capture before a run (when enabled and the graph is non-empty).
  const autoSnapshotBeforeRun = useCallback(() => {
    if (!autoSnapshot || nodes.length === 0) return;
    captureNamed(`Auto · ${new Date().toLocaleTimeString()}`);
  }, [autoSnapshot, nodes.length, captureNamed]);

  // Browser-preview download: there is no native filesystem, so Save / Save As
  // fall back to a JSON download.
  const downloadWorkflow = useCallback(() => {
    const json = graphSaveSignature(nodes, edges);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile ? baseName(currentFile) : "workflow.json";
    a.click();
    URL.revokeObjectURL(url);
    cleanGraphSignature.current = json;
    setFileDirty(false);
  }, [nodes, edges, currentFile]);

  // Guard destructive actions that would replace the current graph. Returns
  // true when it is safe to proceed (no unsaved edits, or the user confirms).
  const confirmDiscard = useCallback(
    (action: string): boolean => {
      if (!fileDirty) return true;
      const label = currentFile ? baseName(currentFile) : "this workflow";
      return window.confirm(`Discard unsaved changes to ${label}? (${action})`);
    },
    [fileDirty, currentFile],
  );

  // Restore a snapshot into the editor (guarded by the unsaved-changes check).
  const restoreSnapshot = useCallback(
    (id: string) => {
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) return;
      if (!confirmDiscard(`restore ${snap.name}`)) return;
      takeSnapshot();
      loadGraphIntoEditor(snap.graph);
      setFileDirty(true);
      setMessage(`restored snapshot: ${snap.name}`);
    },
    [snapshots, confirmDiscard, takeSnapshot, loadGraphIntoEditor, setMessage],
  );

  // Compare a snapshot against the live graph (no mutation — read-only diff).
  const diffSnapshot = useCallback(
    (id: string) => {
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) return;
      const current = toWorkflowGraph(nodes, edges);
      setSnapshotDiff({ id: snap.id, name: snap.name, diff: diffGraphs(snap.graph, current) });
    },
    [snapshots, nodes, edges],
  );

  const renameSnapshotById = useCallback((id: string) => {
    setSnapshots((list) => {
      const snap = list.find((s) => s.id === id);
      const name = window.prompt("Rename snapshot", snap?.name ?? "");
      if (name === null) return list;
      return renameSnapshot(list, id, name);
    });
  }, []);

  const deleteSnapshot = useCallback((id: string) => {
    setSnapshots((list) => {
      const snap = list.find((s) => s.id === id);
      if (snap && !window.confirm(`Delete snapshot "${snap.name}"?`)) return list;
      return removeSnapshot(list, id);
    });
  }, []);

  const clearSnapshotDiff = useCallback(() => setSnapshotDiff(null), []);

  // Browser-preview upload (the hidden file input). Desktop uses native dialogs.
  const load = useCallback(
    async (file: File) => {
      try {
        const graph = deserializeGraph(await file.text());
        if (openInCanvasTab) {
          skipDirty.current = true;
          const result = openInCanvasTab(graph, null);
          if (result === "limit") {
            skipDirty.current = false;
            setMessage("canvas tab limit reached: close one before opening another");
            return;
          }
          setMessage(`loaded ${file.name} in a new canvas`);
          return;
        }
        if (!confirmDiscard(`load ${file.name}`)) return;
        takeSnapshot();
        loadGraphIntoEditor(graph);
        setCurrentFile(null);
        setFileDirty(false);
        setMessage(`loaded ${file.name}`);
      } catch (err) {
        setMessage(`load failed: ${String(err)}`);
      }
    },
    [takeSnapshot, loadGraphIntoEditor, confirmDiscard, setMessage, openInCanvasTab],
  );

  const refreshProjectFiles = useCallback(
    async (dir: string) => {
      setProjectBusy(true);
      try {
        setWorkflowFiles(await listStudioWorkflows(dir));
      } catch (err) {
        setMessage(`folder scan failed: ${String(err)}`);
      } finally {
        setProjectBusy(false);
      }
    },
    [setMessage],
  );

  // Most-recent-first, de-duplicated, capped recent-files list.
  const rememberFile = useCallback((path: string) => {
    setRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, 8));
  }, []);

  const openFromPath = useCallback(
    async (path: string) => {
      try {
        if (openInCanvasTab) {
          const graph = deserializeGraph(await readStudioWorkflow(path));
          skipDirty.current = true;
          const result = openInCanvasTab(graph, path);
          if (result === "limit") {
            skipDirty.current = false;
            setMessage("canvas tab limit reached: close one before opening another");
            return;
          }
          rememberFile(path);
          setMessage(
            result === "opened"
              ? `opened ${baseName(path)} in a new canvas`
              : `${baseName(path)} is already open`,
          );
          return;
        }
        if (!confirmDiscard(`open ${baseName(path)}`)) return;
        takeSnapshot();
        const graph = deserializeGraph(await readStudioWorkflow(path));
        loadGraphIntoEditor(graph);
        setCurrentFile(path);
        setFileDirty(false);
        rememberFile(path);
        setMessage(`opened ${baseName(path)}`);
      } catch (err) {
        setMessage(`open failed: ${String(err)}`);
      }
    },
    [takeSnapshot, loadGraphIntoEditor, rememberFile, confirmDiscard, setMessage, openInCanvasTab],
  );

  const saveToPath = useCallback(
    async (path: string) => {
      try {
        await writeStudioWorkflow(path, toWorkflowGraph(nodes, edges));
        cleanGraphSignature.current = graphSaveSignature(nodes, edges);
        setCurrentFile(path);
        setFileDirty(false);
        rememberFile(path);
        if (projectDir && path.startsWith(projectDir)) void refreshProjectFiles(projectDir);
        setMessage(`saved ${baseName(path)}`);
      } catch (err) {
        setMessage(`save failed: ${String(err)}`);
      }
    },
    [nodes, edges, projectDir, rememberFile, refreshProjectFiles, setMessage],
  );

  const handleSaveAs = useCallback(async () => {
    if (!isDesktop) {
      downloadWorkflow();
      return;
    }
    const defaultName = currentFile ? baseName(currentFile) : "workflow.json";
    const path = await pickWorkflowSavePath(defaultName, projectDir);
    if (path) await saveToPath(path);
  }, [isDesktop, currentFile, projectDir, saveToPath, downloadWorkflow]);

  const handleSave = useCallback(async () => {
    if (!isDesktop) {
      downloadWorkflow();
      return;
    }
    if (currentFile) await saveToPath(currentFile);
    else await handleSaveAs();
  }, [isDesktop, currentFile, saveToPath, handleSaveAs, downloadWorkflow]);

  const handleOpen = useCallback(async () => {
    if (!isDesktop) {
      fileInput.current?.click();
      return;
    }
    const path = await pickWorkflowOpenPath(projectDir);
    if (path) await openFromPath(path);
  }, [isDesktop, projectDir, openFromPath]);

  const handlePickFolder = useCallback(async () => {
    const dir = await pickProjectFolder(projectDir);
    if (dir) {
      setProjectDir(dir);
      void refreshProjectFiles(dir);
    }
  }, [projectDir, refreshProjectFiles]);

  // Create a new, empty workflow saved straight into the active project folder.
  const handleNewInFolder = useCallback(async () => {
    if (!projectDir) return;
    if (!confirmDiscard("New file")) return;
    const input = window.prompt("New workflow file name", "workflow.json");
    if (!input) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const fileName = /\.json$/i.test(trimmed) ? trimmed : `${trimmed}.json`;
    const sep = projectDir.includes("\\") ? "\\" : "/";
    const target = `${projectDir.replace(/[\\/]$/, "")}${sep}${fileName}`;
    try {
      await writeStudioWorkflow(target, toWorkflowGraph([], []));
      skipDirty.current = true;
      setNodes([]);
      setEdges([]);
      setSelectedId(null);
      setCurrentFile(target);
      setFileDirty(false);
      rememberFile(target);
      void refreshProjectFiles(projectDir);
      setMessage(`created ${fileName}`);
    } catch (err) {
      setMessage(`create failed: ${String(err)}`);
    }
  }, [
    projectDir,
    confirmDiscard,
    setNodes,
    setEdges,
    setSelectedId,
    rememberFile,
    refreshProjectFiles,
    setMessage,
  ]);

  const handleRenameFile = useCallback(
    async (path: string) => {
      const current = baseName(path);
      const input = window.prompt("Rename workflow", current);
      if (!input) return;
      const next = input.trim();
      if (!next || next === current) return;
      try {
        const newPath = await renameStudioWorkflow(path, next);
        setCurrentFile((cur) => (cur === path ? newPath : cur));
        setRecentFiles((prev) => prev.map((p) => (p === path ? newPath : p)));
        if (projectDir) void refreshProjectFiles(projectDir);
        setMessage(`renamed to ${baseName(newPath)}`);
      } catch (err) {
        setMessage(`rename failed: ${String(err)}`);
      }
    },
    [projectDir, refreshProjectFiles, setMessage],
  );

  const handleDuplicateFile = useCallback(
    async (path: string) => {
      try {
        const newPath = await duplicateStudioWorkflow(path);
        if (projectDir) void refreshProjectFiles(projectDir);
        setMessage(`duplicated to ${baseName(newPath)}`);
      } catch (err) {
        setMessage(`duplicate failed: ${String(err)}`);
      }
    },
    [projectDir, refreshProjectFiles, setMessage],
  );

  const handleDeleteFile = useCallback(
    async (path: string) => {
      if (!window.confirm(`Delete ${baseName(path)}? This cannot be undone.`)) return;
      try {
        await deleteStudioWorkflow(path);
        setCurrentFile((cur) => (cur === path ? null : cur));
        setRecentFiles((prev) => prev.filter((p) => p !== path));
        if (projectDir) void refreshProjectFiles(projectDir);
        setMessage(`deleted ${baseName(path)}`);
      } catch (err) {
        setMessage(`delete failed: ${String(err)}`);
      }
    },
    [projectDir, refreshProjectFiles, setMessage],
  );

  const newWorkflow = useCallback(() => {
    if (!confirmDiscard("New")) return;
    takeSnapshot();
    skipDirty.current = true;
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setCurrentFile(null);
    setFileDirty(false);
    setMessage("new workflow");
  }, [setNodes, setEdges, setSelectedId, takeSnapshot, confirmDiscard, setMessage]);

  const clear = useCallback(() => {
    if (!confirmDiscard("Clear")) return;
    takeSnapshot();
    skipDirty.current = true;
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setCurrentFile(null);
    setFileDirty(false);
    clearPersistedGraph();
    if (isTauri()) void clearStudioAutosave().catch((err) => setMessage(`clear autosave failed: ${String(err)}`));
  }, [setNodes, setEdges, setSelectedId, takeSnapshot, confirmDiscard, setMessage]);

  const resetSample = useCallback(() => {
    if (!confirmDiscard("Reset")) return;
    takeSnapshot();
    skipDirty.current = true;
    setNodes(sampleNodes);
    setEdges(sampleEdges);
    setSelectedId(null);
    setCurrentFile(null);
    setFileDirty(false);
    setMessage("reset to sample workflow");
  }, [setNodes, setEdges, setSelectedId, takeSnapshot, confirmDiscard, sampleNodes, sampleEdges, setMessage]);

  // Restore the persisted project folder + recent files on desktop start.
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void readStudioRecents()
      .then((recents) => {
        if (cancelled) return;
        setProjectDir(recents.project_dir ?? null);
        setCurrentFile(recents.current_file ?? null);
        setRecentFiles(recents.files ?? []);
        if (recents.project_dir) {
          setShowProject(true);
          void refreshProjectFiles(recents.project_dir);
        }
      })
      .catch(() => {
        /* no recents yet — start clean */
      })
      .finally(() => {
        if (!cancelled) setRecentsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, refreshProjectFiles]);

  // Persist project folder + recent files whenever they change (after restore).
  useEffect(() => {
    if (!isDesktop || !recentsReady) return;
    void writeStudioRecents({
      project_dir: projectDir,
      current_file: currentFile,
      files: recentFiles,
    }).catch(() => {
      /* best-effort */
    });
  }, [isDesktop, recentsReady, projectDir, currentFile, recentFiles]);

  // Flag the current file dirty on durable workflow edits. Renderer-only
  // state (selection, drag flags, measured sizes) does not enter the workflow
  // signature, so it cannot turn the save light red.
  useEffect(() => {
    const signature = graphSaveSignature(nodes, edges);
    if (skipDirty.current) {
      skipDirty.current = false;
      cleanGraphSignature.current = signature;
      return;
    }
    if (signature === cleanGraphSignature.current) return;
    setFileDirty(true);
  }, [nodes, edges]);

  // Warn before closing the tab/window while there are unsaved file edits.
  useEffect(() => {
    if (!fileDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [fileDirty]);

  return useMemo(
    () => ({
      currentFile,
      fileDirty,
      projectDir,
      workflowFiles,
      recentFiles,
      showProject,
      setShowProject,
      projectBusy,
      fileInputRef: fileInput,
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
      adoptFileState,
    }),
    [
      currentFile,
      fileDirty,
      projectDir,
      workflowFiles,
      recentFiles,
      showProject,
      projectBusy,
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
      snapshotDiff,
      clearSnapshotDiff,
      autoSnapshot,
      captureSnapshot,
      restoreSnapshot,
      diffSnapshot,
      renameSnapshotById,
      deleteSnapshot,
      projectStoreDir,
      autoSnapshotBeforeRun,
      suppressNextDirty,
      adoptFileState,
    ],
  );
}
