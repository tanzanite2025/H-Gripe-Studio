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
  maskBridgeGap,
  toMaskDocument,
  type ImageDocument,
} from "../editor/imageDocument";
import { normalizeEditPaths, serializeEditState } from "../editor/maskEdit";
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
  mediaEditDrafts: MutableRefObject<Map<string, ImageDocument>>;
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
  mediaEditDrafts,
  setMediaDraftRevision,
  takeSnapshot,
  screenToFlowPosition,
  setMessage,
  isDesktop,
  imageExtensions,
  t,
}: UseEditorLaunchControllerArgs) {
  const {
    maskEditNode,
    cropEditNode,
    gradeEditNode,
    mediaEditSource,
    setMaskEditNodeId,
    setCropEditNodeId,
    setGradeEditNodeId,
    setMediaEditSourceId,
    openMediaEdit,
    connectedImagePath,
  } = modals;
  const { addBoundEdit, newNodeId, onParamChange, patchNode } = nodeEditing;
  const [gradeClipId, setGradeClipId] = useState<string | null>(null);
  const [audioEditClipId, setAudioEditClipId] = useState<string | null>(null);
  const [mediaEditBlank, setMediaEditBlank] = useState(false);

  const handleOpenImageEdit = useCallback(
    (assetId: string) => {
      const asset = binAssets.find((candidate) => candidate.id === assetId);
      if (!asset || asset.kind !== "image") return;
      if (
        asset.sourceNodeId &&
        nodes.some((node) => node.id === asset.sourceNodeId)
      ) {
        openMediaEdit(asset.sourceNodeId);
      } else {
        setMessage(t("drawer.imageEditNoSource"));
      }
    },
    [binAssets, nodes, openMediaEdit, setMessage, t],
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
    setMediaEditBlank(false);
    openMediaEdit(node.id);
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
    : maskEditNode
      ? {
          editor: "mask",
          target: {
            title: t(
              (maskEditNode.data as HgripeNodeData).kind === "subjectMask"
                ? "mask.titleSubject"
                : "mask.titleDefault",
            ),
            imagePath: connectedImagePath(maskEditNode.id) ?? null,
            nodeId: maskEditNode.id,
          },
          initial:
            (maskEditNode.data as HgripeNodeData).params.edit_history ??
            normalizeEditPaths(
              (maskEditNode.data as HgripeNodeData).params.edit_paths,
            ),
          wandTolerance: Number(
            (maskEditNode.data as HgripeNodeData).params.wand_tolerance ?? 24,
          ),
          onCommit: (edits, editState) => {
            const data = maskEditNode.data as HgripeNodeData;
            pendingRunNode.current = maskEditNode.id;
            takeSnapshot();
            patchNode(maskEditNode.id, {
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
          : mediaEditSource || mediaEditBlank
            ? (() => {
                const data = mediaEditSource
                  ? (mediaEditSource.data as HgripeNodeData)
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
                      active: node.id === mediaEditSource?.id,
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
                  editor: "media" as const,
                  target: {
                    title: base || t("mediaEdit.title"),
                    imagePath,
                    nodeId: mediaEditSource?.id ?? null,
                  },
                  onPickFile: () => void pickIntoImageEditor(),
                  tabs,
                  onSelectTab: (id: string) => {
                    setMediaEditBlank(false);
                    setMediaEditSourceId(id);
                  },
                  initial: mediaEditSource
                    ? (mediaEditDrafts.current.get(mediaEditSource.id) ?? null)
                    : null,
                  onDocChange: (doc: ImageDocument) => {
                    if (mediaEditSource) {
                      mediaEditDrafts.current.set(mediaEditSource.id, doc);
                      setMediaDraftRevision((value) => value + 1);
                    }
                  },
                  onCommitMask: (edits: ImageDocument) => {
                    const lowered = toMaskDocument(edits);
                    if (mediaEditSource && lowered) {
                      if (mediaEditDrafts.current.delete(mediaEditSource.id)) {
                        setMediaDraftRevision((value) => value + 1);
                      }
                      addBoundEdit(mediaEditSource.id, "subjectMask", {
                        params: {
                          edit_paths: lowered,
                          ...(edits.editHistory
                            ? { edit_history: edits.editHistory }
                            : null),
                        },
                        openEditor: false,
                        run: true,
                      });
                    } else if (mediaEditSource && !lowered) {
                      console.warn(
                        `image edit apply skipped — document cannot lower to edit_paths (${maskBridgeGap(edits)})`,
                      );
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

  const lastMediaEditId = useRef<string | null>(null);
  useEffect(() => {
    if (mediaEditSource) lastMediaEditId.current = mediaEditSource.id;
  }, [mediaEditSource]);

  const openImageEditor = () => {
    const isImage = (node: Node) =>
      (node.data as HgripeNodeData).kind === "imageSource";
    const selected = nodes.find(
      (node) => selectedNodeIds.includes(node.id) && isImage(node),
    );
    if (selected) {
      openMediaEdit(selected.id);
      return;
    }
    const last = lastMediaEditId.current;
    if (last && nodes.some((node) => node.id === last && isImage(node))) {
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

  const openImageEditorOnPath = (path: string) => {
    const owner = nodes.find(
      (node) =>
        (node.data as HgripeNodeData).kind === "imageSource" &&
        normalizeImageSourceSlots((node.data as HgripeNodeData).params).some(
          (slot) => slot.path === path,
        ),
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
    openMediaEdit(node.id);
  };

  const closeEditor = () => {
    setGradeClipId(null);
    setMaskEditNodeId(null);
    setCropEditNodeId(null);
    setGradeEditNodeId(null);
    setMediaEditSourceId(null);
    setMediaEditBlank(false);
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
