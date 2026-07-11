import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import {
  loadLocalProjectManifest,
  parseProjectManifest,
  saveLocalProjectManifest,
  serializeProjectManifest,
  type ProjectManifest,
} from "../editor/projectManifest";
import { fromWorkflowGraph, toWorkflowGraph } from "../editor/adapter";
import { deserializeGraph } from "../graph/model";
import type { ImageDocument } from "../editor/imageDocument";
import type { UseCanvasDocument } from "../editor/useCanvasDocument";
import {
  readStudioAutosave,
  readStudioProjectManifest,
  writeStudioProjectManifest,
} from "../bridge/tauri";

interface UseProjectRestoreControllerArgs {
  canvas: UseCanvasDocument;
  currentFile: string | null;
  fileDirty: boolean;
  isDesktop: boolean;
  imageSourceEditorDrafts: MutableRefObject<Map<string, ImageDocument>>;
  mediaDraftRevision: number;
  setMediaDraftRevision: Dispatch<SetStateAction<number>>;
  suppressNextDirty: () => void;
  setMessage: Dispatch<SetStateAction<string>>;
  restoredMessage: string;
}

export function useProjectRestoreController({
  canvas,
  currentFile,
  fileDirty,
  isDesktop,
  imageSourceEditorDrafts,
  mediaDraftRevision,
  setMediaDraftRevision,
  suppressNextDirty,
  setMessage,
  restoredMessage,
}: UseProjectRestoreControllerArgs): void {
  const {
    documentId,
    edges,
    exportCanvases,
    nodes,
    restoreCanvases,
    setEdges,
    setNodes,
    setSelectedId,
    tabs,
  } = canvas;
  const manifestRestored = useRef(false);
  const [manifestReady, setManifestReady] = useState(false);

  useEffect(() => {
    if (manifestRestored.current) return;
    manifestRestored.current = true;
    const apply = (manifest: ProjectManifest | null) => {
      if (!manifest) return false;
      const restoredDrafts = new Map<string, ImageDocument>();
      restoreCanvases(
        manifest.activeCanvasId,
        manifest.canvases.map((entry) => {
          const graph = fromWorkflowGraph(entry.graph);
          for (const [nodeId, draft] of Object.entries(entry.imageSourceEditorDrafts)) {
            restoredDrafts.set(nodeId, draft);
          }
          return {
            id: entry.id,
            path: entry.path,
            dirty: entry.dirty,
            name: entry.name,
            selectedNodeId: entry.selectedNodeId,
            viewport: entry.viewport,
            nodes: graph.nodes,
            edges: graph.edges,
          };
        }),
      );
      imageSourceEditorDrafts.current = restoredDrafts;
      setMediaDraftRevision((value) => value + 1);
      setMessage(restoredMessage);
      return true;
    };
    if (isDesktop) {
      void readStudioProjectManifest()
        .then(async (raw) => {
          if (apply(parseProjectManifest(raw))) return;
          const legacy = await readStudioAutosave();
          if (!legacy) return;
          const restored = fromWorkflowGraph(deserializeGraph(legacy));
          suppressNextDirty();
          setNodes(restored.nodes);
          setEdges(restored.edges);
          setSelectedId(null);
          setMessage("restored desktop workflow");
        })
        .catch((error) => setMessage(`project manifest restore failed: ${String(error)}`))
        .finally(() => setManifestReady(true));
    } else {
      apply(loadLocalProjectManifest());
      setManifestReady(true);
    }
  }, [
    isDesktop,
    imageSourceEditorDrafts,
    restoreCanvases,
    restoredMessage,
    setEdges,
    setMediaDraftRevision,
    setMessage,
    setNodes,
    setSelectedId,
    suppressNextDirty,
  ]);

  useEffect(() => {
    if (!manifestReady) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { activeCanvasId, canvases } = exportCanvases({
        path: currentFile,
        dirty: fileDirty,
      });
      const manifest: ProjectManifest = {
        version: 2,
        activeCanvasId,
        canvases: canvases.map((entry) => ({
          id: entry.id,
          path: entry.path,
          dirty: entry.dirty,
          name: entry.name ?? null,
          selectedNodeId: entry.selectedNodeId,
          viewport: entry.viewport,
          graph: toWorkflowGraph(entry.nodes, entry.edges),
          imageSourceEditorDrafts: Object.fromEntries(
            entry.nodes
              .map((node) => [node.id, imageSourceEditorDrafts.current.get(node.id)] as const)
              .filter(
                (draft): draft is readonly [string, ImageDocument] => draft[1] != null,
              ),
          ),
        })),
      };
      if (isDesktop) {
        void writeStudioProjectManifest(serializeProjectManifest(manifest)).catch((error) => {
          if (!cancelled) {
            setMessage(`project manifest save failed: ${String(error)}`);
          }
        });
      } else {
        saveLocalProjectManifest(manifest);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    currentFile,
    documentId,
    edges,
    exportCanvases,
    fileDirty,
    isDesktop,
    manifestReady,
    mediaDraftRevision,
    imageSourceEditorDrafts,
    nodes,
    setMessage,
    tabs,
  ]);
}
