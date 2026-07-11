// Modal-open state for the shared editor modals (Preview, Image Editor, Crop-Edit
// and the image source's standalone image editor), plus the connected-image
// lookup those modals use as their canvas underlay. Owns which node each modal
// targets; the modal components themselves stay in App's JSX.

import { useCallback, useMemo, useState } from "react";
import type { Edge, Node } from "@hgripe/flow";

import type { HgripeNodeData } from "./HgripeNode";

export function useModals({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  // Which node (if any) has the shared Preview / Image Editor modal open.
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [imageEditorNodeId, setImageEditorNodeId] = useState<string | null>(null);
  const [cropEditNodeId, setCropEditNodeId] = useState<string | null>(null);
  const [gradeEditNodeId, setGradeEditNodeId] = useState<string | null>(null);
  // Image source whose standalone image editor is open, if any.
  const [imageSourceEditorSourceId, setImageSourceEditorSourceId] = useState<string | null>(null);

  const openPreview = useCallback((nodeId: string) => setPreviewNodeId(nodeId), []);
  const openImageEditorForNode = useCallback((nodeId: string) => setImageEditorNodeId(nodeId), []);
  const openCropEdit = useCallback((nodeId: string) => setCropEditNodeId(nodeId), []);
  const openGradeEdit = useCallback((nodeId: string) => setGradeEditNodeId(nodeId), []);
  const openImageSourceEditor = useCallback((sourceId: string) => setImageSourceEditorSourceId(sourceId), []);

  // Resolve the image path feeding a node's `image` input port: follow the
  // incoming edge to its source node and read that node's last-run image / path
  // param. Used as the best-effort underlay for the Image Editor canvas and the
  // layers of the Preview modal (often empty in browser preview).
  const connectedImagePath = useCallback(
    (nodeId: string): string | null => {
      const edge = edges.find((e) => e.target === nodeId && e.targetHandle === "image");
      if (!edge) return null;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) return null;
      const d = src.data as HgripeNodeData;
      return d.imagePath ?? (typeof d.params?.path === "string" ? (d.params.path as string) : null);
    },
    [edges, nodes],
  );

  const previewNode = useMemo(
    () => nodes.find((n) => n.id === previewNodeId) ?? null,
    [nodes, previewNodeId],
  );
  const imageEditorNode = useMemo(
    () => nodes.find((n) => n.id === imageEditorNodeId) ?? null,
    [nodes, imageEditorNodeId],
  );
  const cropEditNode = useMemo(
    () => nodes.find((n) => n.id === cropEditNodeId) ?? null,
    [nodes, cropEditNodeId],
  );
  const gradeEditNode = useMemo(
    () => nodes.find((n) => n.id === gradeEditNodeId) ?? null,
    [nodes, gradeEditNodeId],
  );
  const imageSourceEditorSource = useMemo(
    () => nodes.find((n) => n.id === imageSourceEditorSourceId) ?? null,
    [nodes, imageSourceEditorSourceId],
  );

  return {
    previewNode,
    imageEditorNode,
    cropEditNode,
    gradeEditNode,
    imageSourceEditorSource,
    setPreviewNodeId,
    setImageEditorNodeId,
    setCropEditNodeId,
    setGradeEditNodeId,
    setImageSourceEditorSourceId,
    openPreview,
    openImageEditorForNode,
    openCropEdit,
    openGradeEdit,
    openImageSourceEditor,
    connectedImagePath,
  };
}
