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

import { listenFileDrop, primeIngest } from "../bridge/tauri";
import { setGraphHelperLines } from "../editor/graphStore";
import {
  detachChildren,
  findContainingGroup,
  isGroupNode,
  reparentNode,
} from "../editor/grouping";
import { getHelperLines } from "../editor/helperLines";
import type { RunHudScope } from "../editor/RunHud";
import { makeNode, useNodeEditing } from "../editor/useNodeEditing";
import type { UseCanvasDocument } from "../editor/useCanvasDocument";
import type { MsgKey } from "../i18n";
import type { ProductionState } from "../production/productionStore";
import { findClip } from "../production/timeline";
import { startIngestListener } from "../runtime/ingestStore";
import { useStudioRunController } from "../editor/useStudioRunController";

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
      const created = media.map(({ path, kind }, index) => ({
        ...makeNode(
          newNodeId(kind),
          kind,
          origin.x + index * 28,
          origin.y + index * 28,
          { path },
        ),
        selected: index === media.length - 1,
      }));
      setNodes((items) => [
        ...items.map((item) => ({ ...item, selected: false })),
        ...created,
      ]);
      setSelectedId(created[created.length - 1]?.id ?? null);
      void primeIngest(
        media
          .filter((item) => item.kind === "imageSource")
          .map((item) => item.path),
      );
      const images = media.filter(
        (item) => item.kind === "imageSource",
      ).length;
      const videos = media.length - images;
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
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listenFileDrop((event) =>
      ingestDroppedFiles(event.paths, event.position),
    ).then((stop) => {
      if (disposed) stop?.();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ingestDroppedFiles]);

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
      const handle = asset.kind === "video" ? "video" : "image";
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
          x: window.innerWidth / 2 - 320,
          y: window.innerHeight / 3,
        });
        created.push(
          makeNode(
            sourceId,
            sourceKind,
            sourcePosition.x,
            sourcePosition.y,
            { path: asset.path },
          ),
        );
      }
      const splitId = newNodeId("smartLayerSplit");
      created.push({
        ...makeNode(
          splitId,
          "smartLayerSplit",
          sourcePosition.x + 320,
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
        void runActions.runSelection(selectedNodeIds);
      } else if (scope === "selection_only") {
        void runActions.runSelectionOnly(selectedNodeIds);
      } else {
        void runActions.run();
      }
    },
    [runActions, selectedNodeIds],
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
