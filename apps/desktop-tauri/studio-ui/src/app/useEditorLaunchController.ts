import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Node } from "@hgripe/flow";

import { pickFile, primeIngest } from "../bridge/tauri";
import type { CropCommit } from "../editor/CropEditModal";
import type { HgripeNodeData } from "../editor/HgripeNode";
import type { EditorRequest } from "../editor/host/EditorHost";
import {
  imageEditorBridgeGap,
  toImageEditorDocument,
  type ImageDocument,
} from "../editor/imageDocument";
import { normalizeEditPaths, serializeEditState } from "../editor/imageEditorState";
import { makeNode, useNodeEditing } from "../editor/useNodeEditing";
import { useModals } from "../editor/useModals";
import type { UseCanvasDocument } from "../editor/useCanvasDocument";
import type { MsgKey } from "../i18n";
import type { AudioClipEdit } from "../production/audioEdit";
import {
  clipGradeKey,
  commitAudioEdit,
  productionStore,
  selectClip,
  setClipGradeDoc,
  type ProductionState,
} from "../production/productionStore";
import { findClip } from "../production/timeline";
import {
  imageSourceParamsFromPaths,
  normalizeImageSourceSlots,
} from "../domain/imageSourceSlots";
import {
  IMAGE_SOURCE_THUMB_MODE,
  IMAGE_SOURCE_THUMB_SIZE,
} from "../editor/nodeGeometry";

type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;
type NodeEditingActions = Pick<
  ReturnType<typeof useNodeEditing>,
  "addBoundEdit" | "newNodeId" | "onParamChange" | "patchNode"
>;

interface UseEditorLaunchControllerArgs {
  nodes: Node[];
  setNodes: UseCanvasDocument["setNodes"];
  setSelectedId: UseCanvasDocument["setSelectedId"];
  binAssets: ProductionState["binAssets"];
  timeline: ProductionState["timeline"];
  gradeDocs: ProductionState["gradeDocs"];
  audioEdits: ProductionState["audioEdits"];
  clipProps: ProductionState["clipProps"];
  modals: ReturnType<typeof useModals>;
  nodeEditing: NodeEditingActions;
  selectedNodeIds: string[];
  pendingRunNode: MutableRefObject<string | null>;
  imageSourceEditorDrafts: MutableRefObject<Map<string, ImageDocument>>;
  setMediaDraftRevision: Dispatch<SetStateAction<number>>;
  takeSnapshot: () => void;
  screenToFlowPosition: (position: { x: number; y: number }) => {
    x: number;
    y: number;
  };
  setMessage: Dispatch<SetStateAction<string>>;
  isDesktop: boolean;
  imageExtensions: ReadonlySet<string>;
  t: Translate;
}

export function useEditorLaunchController({
  nodes,
  setNodes,
  setSelectedId,
  binAssets,
  timeline,
  gradeDocs,
  audioEdits,
  clipProps,
  modals,
  nodeEditing,
  selectedNodeIds,
  pendingRunNode,
  imageSourceEditorDrafts,
  setMediaDraftRevision,
  takeSnapshot,
  screenToFlowPosition,
  setMessage,
  isDesktop,
  imageExtensions,
  t,
}: UseEditorLaunchControllerArgs) {
  const {
    imageEditorNode,
    cropEditNode,
    gradeEditNode,
    imageSourceEditorSource,
    setImageEditorNodeId,
    setCropEditNodeId,
    setGradeEditNodeId,
    setImageSourceEditorSourceId,
    openImageSourceEditor,
    connectedImagePath,
  } = modals;
  const { addBoundEdit, newNodeId, onParamChange, patchNode } = nodeEditing;
  const [gradeClipId, setGradeClipId] = useState<string | null>(null);
  const [audioEditClipId, setAudioEditClipId] = useState<string | null>(null);
  const [imageSourceEditorBlank, setImageSourceEditorBlank] = useState(false);

  const handleOpenImageEdit = useCallback(
    (assetId: string) => {
      const asset = binAssets.find((candidate) => candidate.id === assetId);
      if (!asset || asset.kind !== "image") return;
      if (
        asset.sourceNodeId &&
        nodes.some((node) => node.id === asset.sourceNodeId)
      ) {
        openImageSourceEditor(asset.sourceNodeId);
      } else {
        setMessage(t("drawer.imageEditNoSource"));
      }
    },
    [binAssets, nodes, openImageSourceEditor, setMessage, t],
  );

  const handleOpenAudioEdit = useCallback(
    (clipId: string) => {
      const found = findClip(timeline, clipId);
      if (found && found.clip.kind === "audio") {
        setAudioEditClipId(clipId);
      }
    },
    [timeline],
  );

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
      if (audioEditClipId) {
        commitAudioEdit(productionStore, audioEditClipId, edit);
      }
      setAudioEditClipId(null);
    },
    [audioEditClipId],
  );

  const audioEditClip = audioEditClipId
    ? findClip(timeline, audioEditClipId)
    : null;

  const clipGradeDoc = useCallback(
    (clipId: string): string | null => {
      const key = clipGradeKey(timeline, clipId);
      return key ? (gradeDocs[key] ?? null) : null;
    },
    [timeline, gradeDocs],
  );

  const clipPropsDoc = useCallback(
    (clipId: string): string | null => {
      const props = clipProps[clipId];
      return props ? JSON.stringify(props) : null;
    },
    [clipProps],
  );

  const clipAudioEdit = useCallback(
    (clipId: string): AudioClipEdit | null => audioEdits[clipId]?.edit ?? null,
    [audioEdits],
  );

  const gradeClip = gradeClipId ? findClip(timeline, gradeClipId) : null;
  const gradeClipAsset = gradeClip
    ? (binAssets.find((asset) => asset.id === gradeClip.clip.assetId) ?? null)
    : null;

  const pickIntoImageEditor = async () => {
    const path = await pickFile({
      title: t("imageEdit.pickTitle"),
      filterName: "Images",
      extensions: [...imageExtensions],
    });
    if (!path) {
      if (!isDesktop) window.alert(t("imageEdit.selectFirst"));
      return;
    }
    takeSnapshot();
    const origin = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node = {
      ...makeNode(newNodeId("imageSource"), "imageSource", origin.x, origin.y, {
        ...imageSourceParamsFromPaths([path]),
      }),
      selected: true,
    };
    setNodes((items) => [
      ...items.map((item) => ({ ...item, selected: false })),
      node,
    ]);
    setSelectedId(node.id);
    void primeIngest([path], IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE);
    setImageSourceEditorBlank(false);
    openImageSourceEditor(node.id);
  };

  const editorRequest: EditorRequest | null = gradeClip
    ? {
        editor: "grade",
        target: {
          title: gradeClipAsset?.name ?? gradeClip.clip.assetId,
          imagePath:
            gradeClip.clip.kind === "still"
              ? (gradeClipAsset?.path ?? null)
              : null,
          videoPath:
            gradeClip.clip.kind === "video"
              ? (gradeClipAsset?.path ?? null)
              : null,
        },
        initialDoc: clipGradeDoc(gradeClip.clip.id),
        onCommit: (commit) => {
          setClipGradeDoc(productionStore, gradeClip.clip.id, commit.gradeDoc);
        },
      }
    : imageEditorNode
      ? {
          editor: "mask",
          target: {
            title: t(
              (imageEditorNode.data as HgripeNodeData).kind === "subjectMask"
                ? "mask.titleSubject"
                : "mask.titleDefault",
            ),
            imagePath: connectedImagePath(imageEditorNode.id) ?? null,
            nodeId: imageEditorNode.id,
          },
          initial:
            (imageEditorNode.data as HgripeNodeData).params.edit_history ??
            normalizeEditPaths(
              (imageEditorNode.data as HgripeNodeData).params.edit_paths,
            ),
          wandTolerance: Number(
            (imageEditorNode.data as HgripeNodeData).params.wand_tolerance ?? 24,
          ),
          onCommit: (edits, editState) => {
            const data = imageEditorNode.data as HgripeNodeData;
            pendingRunNode.current = imageEditorNode.id;
            takeSnapshot();
            patchNode(imageEditorNode.id, {
              params: {
                ...data.params,
                edit_paths: edits,
                edit_history: serializeEditState(editState),
              },
            });
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
              (cropEditNode.data as HgripeNodeData).params.mode ===
              "auto_subject"
                ? "auto_subject"
                : "manual",
            initialBox:
              Array.isArray(
                (cropEditNode.data as HgripeNodeData).params.crop_box,
              ) &&
              (
                (cropEditNode.data as HgripeNodeData).params
                  .crop_box as unknown[]
              ).length === 4
                ? ((cropEditNode.data as HgripeNodeData).params.crop_box as [
                    number,
                    number,
                    number,
                    number,
                  ])
                : null,
            initialAspect: String(
              (cropEditNode.data as HgripeNodeData).params.aspect ?? "free",
            ),
            initialMargin: Number(
              (cropEditNode.data as HgripeNodeData).params.margin_pct ?? 6,
            ),
            onCommit: (commit) => {
              const id = cropEditNode.id;
              takeSnapshot();
              setNodes((items) =>
                items.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        data: {
                          ...(item.data as HgripeNodeData),
                          params: {
                            ...(item.data as HgripeNodeData).params,
                            mode: commit.mode,
                            aspect: commit.aspect,
                            margin_pct: commit.marginPct,
                            crop_box: commit.cropBox,
                          },
                        },
                      }
                    : item,
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
                typeof (gradeEditNode.data as HgripeNodeData).params
                  .grade_doc === "string"
                  ? ((gradeEditNode.data as HgripeNodeData).params
                      .grade_doc as string)
                  : null,
              onCommit: (commit) => {
                pendingRunNode.current = gradeEditNode.id;
                onParamChange(
                  gradeEditNode.id,
                  "grade_doc",
                  commit.gradeDoc,
                );
              },
            }
          : imageSourceEditorSource || imageSourceEditorBlank
            ? (() => {
                const data = imageSourceEditorSource
                  ? (imageSourceEditorSource.data as HgripeNodeData)
                  : null;
                const imagePath = data
                  ? (data.cutoutImagePath ??
                    data.imagePath ??
                    normalizeImageSourceSlots(data.params)[0]?.path ??
                    (typeof data.params?.path === "string" ? data.params.path : null))
                  : null;
                const base = imagePath?.split(/[\\/]/).pop();
                const tabs = nodes
                  .filter(
                    (node) =>
                      (node.data as HgripeNodeData).kind === "imageSource",
                  )
                  .map((node) => {
                    const nodeData = node.data as HgripeNodeData;
                    const path =
                      nodeData.imagePath ??
                      normalizeImageSourceSlots(nodeData.params)[0]?.path ??
                      (typeof nodeData.params?.path === "string" ? nodeData.params.path : null);
                    return {
                      id: node.id,
                      label: path?.split(/[\\/]/).pop() || null,
                      active: node.id === imageSourceEditorSource?.id,
                    };
                  })
                  .filter(
                    (
                      tab,
                    ): tab is {
                      id: string;
                      label: string;
                      active: boolean;
                    } => tab.label != null,
                  );
                return {
                  editor: "imageSource" as const,
                  target: {
                    title: base || t("imageSourceEditor.title"),
                    imagePath,
                    nodeId: imageSourceEditorSource?.id ?? null,
                  },
                  onPickFile: () => void pickIntoImageEditor(),
                  tabs,
                  onSelectTab: (id: string) => {
                    setImageSourceEditorBlank(false);
                    setImageSourceEditorSourceId(id);
                  },
                  initial: imageSourceEditorSource
                    ? (imageSourceEditorDrafts.current.get(imageSourceEditorSource.id) ?? null)
                    : null,
                  onDocChange: (doc: ImageDocument) => {
                    if (imageSourceEditorSource) {
                      imageSourceEditorDrafts.current.set(imageSourceEditorSource.id, doc);
                      setMediaDraftRevision((value) => value + 1);
                    }
                  },
                  onCommitMask: (edits: ImageDocument) => {
                    const lowered = toImageEditorDocument(edits);
                    if (imageSourceEditorSource && lowered) {
                      if (imageSourceEditorDrafts.current.delete(imageSourceEditorSource.id)) {
                        setMediaDraftRevision((value) => value + 1);
                      }
                      addBoundEdit(imageSourceEditorSource.id, "subjectMask", {
                        params: {
                          edit_paths: lowered,
                          ...(edits.editHistory
                            ? { edit_history: edits.editHistory }
                            : null),
                        },
                        openEditor: false,
                        run: true,
                      });
                    } else if (imageSourceEditorSource && !lowered) {
                      console.warn(
                        `image edit apply skipped 鈥?document cannot lower to edit_paths (${imageEditorBridgeGap(edits)})`,
                      );
                    }
                    setImageSourceEditorSourceId(null);
                    setImageSourceEditorBlank(false);
                  },
                  onCommitCrop: (commit: CropCommit) => {
                    if (imageSourceEditorSource) {
                      addBoundEdit(imageSourceEditorSource.id, "crop", {
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
                    setImageSourceEditorSourceId(null);
                    setImageSourceEditorBlank(false);
                  },
                };
              })()
            : null;

  const lastImageSourceEditorId = useRef<string | null>(null);
  useEffect(() => {
    if (imageSourceEditorSource) lastImageSourceEditorId.current = imageSourceEditorSource.id;
  }, [imageSourceEditorSource]);

  const openImageEditor = () => {
    const isImage = (node: Node) =>
      (node.data as HgripeNodeData).kind === "imageSource";
    const selected = nodes.find(
      (node) => selectedNodeIds.includes(node.id) && isImage(node),
    );
    if (selected) {
      openImageSourceEditor(selected.id);
      return;
    }
    const last = lastImageSourceEditorId.current;
    if (last && nodes.some((node) => node.id === last && isImage(node))) {
      openImageSourceEditor(last);
      return;
    }
    const cards = nodes.filter(isImage);
    if (cards.length > 0) {
      openImageSourceEditor(cards[cards.length - 1].id);
      return;
    }
    setImageSourceEditorBlank(true);
  };

  const openImageEditorOnPath = (path: string) => {
    const owner = nodes.find(
      (node) =>
        (node.data as HgripeNodeData).kind === "imageSource" &&
        normalizeImageSourceSlots((node.data as HgripeNodeData).params).some(
          (slot) => slot.path === path,
        ),
    );
    if (owner) {
      openImageSourceEditor(owner.id);
      return;
    }
    takeSnapshot();
    const origin = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node = {
      ...makeNode(newNodeId("imageSource"), "imageSource", origin.x, origin.y, {
        ...imageSourceParamsFromPaths([path]),
      }),
      selected: true,
    };
    setNodes((items) => [
      ...items.map((item) => ({ ...item, selected: false })),
      node,
    ]);
    setSelectedId(node.id);
    void primeIngest([path], IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE);
    openImageSourceEditor(node.id);
  };

  const closeEditor = () => {
    setGradeClipId(null);
    setImageEditorNodeId(null);
    setCropEditNodeId(null);
    setGradeEditNodeId(null);
    setImageSourceEditorSourceId(null);
    setImageSourceEditorBlank(false);
  };

  return {
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
  };
}
