import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  Node,
  NodePositionChange,
  OnEdgesChange,
  OnNodesChange,
} from "@hgripe/flow";
import { withHgripeDataEdge } from "@hgripe/flow";

import { primeIngest } from "../bridge/tauri";
import { setGraphHelperLines } from "../editor/graphStore";
import {
  detachChildren,
  findContainingGroup,
  isGroupNode,
  reparentNode,
} from "../editor/grouping";
import { getHelperLines } from "../editor/helperLines";
import {
  IMAGE_SOURCE_COLUMN_GAP,
  IMAGE_SOURCE_THUMB_MODE,
  IMAGE_SOURCE_THUMB_SIZE,
  NODE_COLUMN_GAP,
} from "../editor/nodeGeometry";
import type { RunHudScope } from "../editor/RunHud";
import { makeNode, useNodeEditing } from "../editor/useNodeEditing";
import type { UseCanvasDocument } from "../editor/useCanvasDocument";
import type { MsgKey } from "../i18n";
import type { ProductionState } from "../production/productionStore";
import { findClip } from "../production/timeline";
import { startIngestListener } from "../runtime/ingestStore";
import { useStudioRunController } from "../editor/useStudioRunController";
import {
  appendImageSourcePaths,
  firstImageSourceSlotPortId,
  imageSourcePathGroups,
  imageSourceParamsFromPaths,
  MAX_IMAGE_SOURCE_SLOTS,
  normalizeImageSourceSlots,
} from "../domain/imageSourceSlots";
import { nativeFileDropRouter } from "./nativeFileDropRouter";

type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;
type NewNodeId = ReturnType<typeof useNodeEditing>["newNodeId"];
type RunActions = Pick<
  ReturnType<typeof useStudioRunController>,
  "run" | "runSelection" | "runSelectionOnly"
>;

function dropExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

interface UseCanvasWorkspaceControllerArgs {
  nodes: Node[];
  setNodes: UseCanvasDocument["setNodes"];
  onNodesChange: UseCanvasDocument["onNodesChange"];
  setEdges: UseCanvasDocument["setEdges"];
  onEdgesChange: UseCanvasDocument["onEdgesChange"];
  setSelectedId: UseCanvasDocument["setSelectedId"];
  timeline: ProductionState["timeline"];
  binAssets: ProductionState["binAssets"];
  importMediaPathsToBin: (paths: string[]) => void;
  handleCanvasSelect: (id: string | null) => void;
  newNodeId: NewNodeId;
  takeSnapshot: () => void;
  screenToFlowPosition: (position: { x: number; y: number }) => {
    x: number;
    y: number;
  };
  setMessage: Dispatch<SetStateAction<string>>;
  runActions: RunActions;
  imageExtensions: ReadonlySet<string>;
  videoExtensions: ReadonlySet<string>;
  t: Translate;
}

export function useCanvasWorkspaceController({
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
  runActions,
  imageExtensions,
  videoExtensions,
  t,
}: UseCanvasWorkspaceControllerArgs) {
  const dragging = useRef(false);
  const { run, runSelection, runSelectionOnly } = runActions;

  const ingestDroppedFiles = useCallback(
    (paths: string[], physical: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      const dropTarget = document.elementFromPoint(
        physical.x / dpr,
        physical.y / dpr,
      );
      if (dropTarget?.closest(".production-bin-popover")) {
        importMediaPathsToBin(paths);
        return;
      }
      const origin = screenToFlowPosition({
        x: physical.x / dpr,
        y: physical.y / dpr,
      });
      const media = paths.flatMap((path) => {
        const extension = dropExtension(path);
        if (imageExtensions.has(extension)) {
          return [{ path, kind: "imageSource" }];
        }
        if (videoExtensions.has(extension)) {
          return [{ path, kind: "videoSource" }];
        }
        return [];
      });
      if (media.length === 0) {
        setMessage(t("canvas.dropUnsupported"));
        return;
      }
      takeSnapshot();
      const imagePaths = media
        .filter((item) => item.kind === "imageSource")
        .map((item) => item.path);
      const videoPaths = media
        .filter((item) => item.kind === "videoSource")
        .map((item) => item.path);
      const targetImageSourceId = (
        dropTarget?.closest("[data-image-source-node-id]") as HTMLElement | null
      )?.dataset.imageSourceNodeId;
      const targetImageSource =
        targetImageSourceId != null
          ? nodes.find((node) => {
              const data = node.data as { kind?: string };
              return node.id === targetImageSourceId && data.kind === "imageSource";
            })
          : undefined;
      if (targetImageSource && imagePaths.length > 0) {
        const currentSlots = normalizeImageSourceSlots(
          (targetImageSource.data as { params?: Record<string, unknown> }).params,
        );
        const remaining = Math.max(0, MAX_IMAGE_SOURCE_SLOTS - currentSlots.length);
        const appendPaths = imagePaths.slice(0, remaining);
        const overflowImages = imagePaths.slice(appendPaths.length);
        const created: Node[] = [];
        imageSourcePathGroups(overflowImages).forEach((group, index) => {
          created.push(
            makeNode(
              newNodeId("imageSource"),
              "imageSource",
              targetImageSource.position.x + (index + 1) * IMAGE_SOURCE_COLUMN_GAP,
              targetImageSource.position.y,
              imageSourceParamsFromPaths(group),
            ),
          );
        });
        videoPaths.forEach((path, index) => {
          created.push(
            makeNode(
              newNodeId("videoSource"),
              "videoSource",
              targetImageSource.position.x +
                (created.length + 1) * IMAGE_SOURCE_COLUMN_GAP +
                index * NODE_COLUMN_GAP,
              targetImageSource.position.y + index * 28,
              { path },
            ),
          );
        });
        const selectedId = created[created.length - 1]?.id ?? targetImageSource.id;
        setNodes((items) =>
          items
            .map((item) => {
              const selected = item.id === selectedId;
              if (item.id !== targetImageSource.id) return { ...item, selected };
              const data = item.data as { params?: Record<string, unknown> };
              return {
                ...item,
                selected,
                data: {
                  ...item.data,
                  params: appendImageSourcePaths(data.params, appendPaths),
                },
              };
            })
            .concat(created.map((node) => ({ ...node, selected: node.id === selectedId }))),
        );
        setSelectedId(selectedId);
        void primeIngest(imagePaths, IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE);
        setMessage(t("canvas.dropImages", { n: imagePaths.length }));
        return;
      }
      const created: Node[] = [];
      const imageGroups = imageSourcePathGroups(imagePaths);
      imageGroups.forEach((group, index) => {
        created.push(
          makeNode(
            newNodeId("imageSource"),
            "imageSource",
            origin.x + index * IMAGE_SOURCE_COLUMN_GAP,
            origin.y,
            imageSourceParamsFromPaths(group),
          ),
        );
      });
      videoPaths.forEach((path, index) => {
        const videoBaseX =
          imageGroups.length > 0 ? imageGroups.length * IMAGE_SOURCE_COLUMN_GAP : 0;
        created.push(
          makeNode(
            newNodeId("videoSource"),
            "videoSource",
            origin.x + videoBaseX + index * NODE_COLUMN_GAP,
            origin.y + index * 28,
            { path },
          ),
        );
      });
      const selectedId = created[created.length - 1]?.id ?? null;
      const selected = created.map((node) => ({
        ...node,
        selected: node.id === selectedId,
      }));
      setNodes((items) => [
        ...items.map((item) => ({ ...item, selected: false })),
        ...selected,
      ]);
      setSelectedId(selectedId);
      void primeIngest(imagePaths, IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE);
      const images = imagePaths.length;
      const videos = videoPaths.length;
      const note =
        images > 0 && videos > 0
          ? t("canvas.dropMedia", { images, videos })
          : videos > 0
            ? t("canvas.dropVideos", { n: videos })
            : t("canvas.dropImages", { n: images });
      setMessage(note);
    },
    [
      imageExtensions,
      importMediaPathsToBin,
      newNodeId,
      nodes,
      screenToFlowPosition,
      setMessage,
      setNodes,
      setSelectedId,
      t,
      takeSnapshot,
      videoExtensions,
    ],
  );

  useEffect(() => {
    startIngestListener();
  }, []);
  useEffect(() => nativeFileDropRouter.register({
    id: "canvas-workspace",
    priority: 10,
    claims: ({ target }) => Boolean(target?.closest(
      ".production-bin-popover, .react-flow, [data-image-source-node-id]",
    )),
    handle: ({ event }) => ingestDroppedFiles(event.paths, event.position),
  }), [ingestDroppedFiles]);

  const handleSplitClipToLayers = useCallback(
    (clipId: string) => {
      const found = findClip(timeline, clipId);
      if (!found || found.clip.kind === "audio") return;
      const asset = binAssets.find(
        (candidate) => candidate.id === found.clip.assetId,
      );
      if (!asset || asset.kind === "audio") return;
      takeSnapshot();
      const existing = asset.sourceNodeId
        ? nodes.find((node) => node.id === asset.sourceNodeId)
        : undefined;
      let handle = asset.kind === "video" ? "video" : "image";
      const created: Node[] = [];
      let sourceId: string;
      let sourcePosition: { x: number; y: number };
      if (existing) {
        sourceId = existing.id;
        sourcePosition = existing.position;
      } else {
        const sourceKind =
          asset.kind === "video" ? "videoSource" : "imageSource";
        sourceId = newNodeId(sourceKind);
        sourcePosition = screenToFlowPosition({
          x: window.innerWidth / 2 - NODE_COLUMN_GAP,
          y: window.innerHeight / 3,
        });
        created.push(
          makeNode(
            sourceId,
            sourceKind,
            sourcePosition.x,
            sourcePosition.y,
            asset.kind === "video" ? { path: asset.path } : imageSourceParamsFromPaths([asset.path]),
          ),
        );
      }
      if (asset.kind === "image") {
        const sourceParams = existing
          ? ((existing.data as { params?: Record<string, unknown> }).params ?? {})
          : imageSourceParamsFromPaths([asset.path]);
        handle = firstImageSourceSlotPortId(sourceParams);
      }
      const splitId = newNodeId("smartLayerSplit");
      const xGap = asset.kind === "image" ? IMAGE_SOURCE_COLUMN_GAP : NODE_COLUMN_GAP;
      created.push({
        ...makeNode(
          splitId,
          "smartLayerSplit",
          sourcePosition.x + xGap,
          sourcePosition.y,
        ),
        selected: true,
      });
      setNodes((items) => [
        ...items.map((item) => ({ ...item, selected: false })),
        ...created,
      ]);
      setEdges((items) =>
        items.concat(
          withHgripeDataEdge({
            id: `edge-${splitId}`,
            source: sourceId,
            sourceHandle: handle,
            target: splitId,
            targetHandle: handle,
          }),
        ),
      );
      handleCanvasSelect(splitId);
      setMessage(t("drawer.splitLayersCreated"));
    },
    [
      binAssets,
      handleCanvasSelect,
      newNodeId,
      nodes,
      screenToFlowPosition,
      setEdges,
      setMessage,
      setNodes,
      t,
      takeSnapshot,
      timeline,
    ],
  );

  const handleNodeDragStop = useCallback(
    (dragged: Node) => {
      if (isGroupNode(dragged)) return;
      setNodes((items) => {
        const merged = items.map((item) =>
          item.id === dragged.id
            ? {
                ...item,
                position: dragged.position,
                parentId: dragged.parentId,
                measured: dragged.measured ?? item.measured,
              }
            : item,
        );
        return reparentNode(
          merged,
          dragged.id,
          findContainingGroup(dragged.id, merged),
        );
      });
    },
    [setNodes],
  );

  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (changes.some((change) => change.type === "remove")) {
        takeSnapshot();
        const removed = new Set(
          changes
            .filter((change) => change.type === "remove")
            .map((change) => change.id),
        );
        const removedGroups = new Set(
          nodes
            .filter((node) => removed.has(node.id) && isGroupNode(node))
            .map((node) => node.id),
        );
        if (removedGroups.size > 0) {
          setNodes((items) => detachChildren(items, removedGroups));
        }
      } else if (
        changes.some(
          (change) => change.type === "position" && change.dragging,
        ) &&
        !dragging.current
      ) {
        dragging.current = true;
        takeSnapshot();
      }
      if (
        changes.some(
          (change) =>
            change.type === "position" && change.dragging === false,
        )
      ) {
        dragging.current = false;
      }
      let lines: { horizontal?: number; vertical?: number } = {};
      if (
        changes.length === 1 &&
        changes[0].type === "position" &&
        changes[0].dragging &&
        changes[0].position
      ) {
        const change = changes[0] as NodePositionChange;
        const helper = getHelperLines(change, nodes);
        if (helper.snapPosition.x !== undefined) {
          change.position!.x = helper.snapPosition.x;
        }
        if (helper.snapPosition.y !== undefined) {
          change.position!.y = helper.snapPosition.y;
        }
        lines = {
          horizontal: helper.horizontal,
          vertical: helper.vertical,
        };
      }
      setGraphHelperLines(lines);
      onNodesChange(changes);
    },
    [nodes, onNodesChange, setNodes, takeSnapshot],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      if (changes.some((change) => change.type === "remove")) {
        takeSnapshot();
      }
      onEdgesChange(changes);
    },
    [onEdgesChange, takeSnapshot],
  );

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  );

  const runHudScope = useCallback(
    (scope: RunHudScope) => {
      if (scope === "selection_with_upstream") {
        void runSelection(selectedNodeIds);
      } else if (scope === "selection_only") {
        void runSelectionOnly(selectedNodeIds);
      } else {
        void run();
      }
    },
    [run, runSelection, runSelectionOnly, selectedNodeIds],
  );

  return {
    handleEdgesChange,
    handleNodeDragStop,
    handleNodesChange,
    handleSplitClipToLayers,
    runHudScope,
    selectedNodeIds,
  };
}
