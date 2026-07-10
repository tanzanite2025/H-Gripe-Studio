import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge, Node } from "@hgripe/flow";

import { mergeLayerMasks, pickFile, primeIngest, splitLayerMask } from "../bridge/tauri";
import type { HgripeNodeData } from "../editor/HgripeNode";
import type { UseCanvasDocument } from "../editor/useCanvasDocument";
import type { MsgKey } from "../i18n";
import type { AddableAsset } from "../production/MediaWorkspacePopover";
import {
  loadDrawerMode,
  saveDrawerMode,
  type DrawerMode,
} from "../production/drawerState";
import {
  findLayer,
  mergeLayersIntoAsset,
  setLayerProtected,
  splitLayerInAsset,
  stubLayeredImageAsset,
  type LayeredImageAsset,
} from "../production/layeredImage";
import {
  assetKindForNodeKind,
  assetKindForPath,
  MEDIA_IMPORT_EXTS,
} from "../production/mediaBin";
import {
  assetTarget,
  imageLayerTarget,
  layeredImageTarget,
  nodeOutputTarget,
  type ProductionTarget,
} from "../production/productionTarget";
import {
  addAssetToBin,
  clearProductionSelection,
  productionStore,
  useProductionState,
} from "../production/productionStore";
import { findClip } from "../production/timeline";

type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;

interface UseProductionWorkspaceControllerArgs {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | null;
  setSelectedId: UseCanvasDocument["setSelectedId"];
  setNodes: UseCanvasDocument["setNodes"];
  setMessage: Dispatch<SetStateAction<string>>;
  isDesktop: boolean;
  t: Translate;
}

export function useProductionWorkspaceController({
  nodes,
  edges,
  selectedId,
  setSelectedId,
  setNodes,
  setMessage,
  isDesktop,
  t,
}: UseProductionWorkspaceControllerArgs) {
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(() => loadDrawerMode());
  const binAssets = useProductionState((state) => state.binAssets);
  const activeAssetId = useProductionState((state) => state.activeAssetId);
  const timeline = useProductionState((state) => state.timeline);
  const selectedClipId = useProductionState((state) => state.selectedClipId);
  const gradeDocs = useProductionState((state) => state.gradeDocs);
  const audioEdits = useProductionState((state) => state.audioEdits);
  const clipProps = useProductionState((state) => state.clipProps);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const layeredAsset = useMemo<LayeredImageAsset | null>(() => {
    if (!selectedNode) return null;
    const data = selectedNode.data as HgripeNodeData;
    if (data.kind !== "smartLayerSplit") return null;
    if (data.layeredAsset) return data.layeredAsset;
    const edge = edges.find(
      (candidate) =>
        candidate.target === selectedNode.id && candidate.targetHandle === "image",
    );
    const source = edge ? nodes.find((node) => node.id === edge.source) : undefined;
    const sourceData = source?.data as HgripeNodeData | undefined;
    const imagePath =
      sourceData?.imagePath ??
      (typeof sourceData?.params?.path === "string"
        ? (sourceData.params.path as string)
        : null);
    if (!imagePath) return null;
    return stubLayeredImageAsset({ imagePath, nodeId: selectedNode.id });
  }, [selectedNode, nodes, edges]);

  const importMediaPathsToBin = useCallback(
    (paths: string[]) => {
      const imported: string[] = [];
      let skipped = 0;
      for (const path of paths) {
        const kind = assetKindForPath(path);
        if (!kind) {
          skipped += 1;
          continue;
        }
        addAssetToBin(productionStore, { kind, path });
        imported.push(path);
      }
      if (imported.length === 0) {
        setMessage(t("drawer.importUnsupported"));
        return;
      }
      void primeIngest(
        imported.filter((path) => assetKindForPath(path) === "image"),
      );
      setMessage(t("drawer.importedMedia", { n: imported.length, skipped }));
    },
    [setMessage, t],
  );

  const handleImportMediaToBin = useCallback(async () => {
    const path = await pickFile({
      title: t("drawer.importMediaTitle"),
      filterName: "Media",
      extensions: [...MEDIA_IMPORT_EXTS],
    });
    if (path) {
      importMediaPathsToBin([path]);
      return;
    }
    if (!isDesktop) window.alert(t("drawer.importNeedsDesktop"));
  }, [importMediaPathsToBin, isDesktop, t]);

  const handleAddExportedFrame = useCallback(
    (asset: { path: string; name: string }) => {
      addAssetToBin(productionStore, {
        kind: "image",
        path: asset.path,
        name: asset.name,
      });
      void primeIngest([asset.path]);
      setMessage(t("exportFrame.addedToProject"));
    },
    [setMessage, t],
  );

  const changeDrawerMode = useCallback((mode: DrawerMode) => {
    setDrawerMode(mode);
    saveDrawerMode(mode);
  }, []);

  const addableAsset = useMemo<AddableAsset | null>(() => {
    if (!selectedNode) return null;
    if (layeredAsset) {
      return {
        kind: "image",
        path: layeredAsset.preview_composite.path,
        sourceNodeId: selectedNode.id,
      };
    }
    const data = selectedNode.data as HgripeNodeData;
    const kind = assetKindForNodeKind(data.kind);
    const path = typeof data.params?.path === "string" ? data.params.path : "";
    if (!kind || !path) return null;
    return { kind, path, sourceNodeId: selectedNode.id };
  }, [selectedNode, layeredAsset]);

  const handleAddSelectedToBin = useCallback(() => {
    if (addableAsset) addAssetToBin(productionStore, addableAsset);
  }, [addableAsset]);

  const productionTarget = useMemo<ProductionTarget | null>(() => {
    if (selectedClipId) {
      const found = findClip(timeline, selectedClipId);
      if (found) {
        const base = {
          timelineId: timeline.id,
          trackId: found.track.id,
          clipId: found.clip.id,
        };
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
  }, [
    selectedClipId,
    timeline,
    activeAssetId,
    selectedId,
    layeredAsset,
    selectedLayerId,
  ]);

  const handleCanvasSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setSelectedLayerId(null);
      setLayerVisibility({});
      if (id) clearProductionSelection(productionStore);
    },
    [setSelectedId],
  );

  const handleToggleLayerVisibility = useCallback(
    (layerId: string) => {
      const current =
        layerVisibility[layerId] ??
        (layeredAsset ? (findLayer(layeredAsset, layerId)?.visible ?? true) : true);
      setLayerVisibility((visibility) => ({
        ...visibility,
        [layerId]: !current,
      }));
    },
    [layerVisibility, layeredAsset],
  );

  const handleToggleProtected = useCallback(
    (layerId: string) => {
      const node = selectedNode;
      const asset = layeredAsset;
      if (!node || !asset) return;
      const layer = findLayer(asset, layerId);
      if (!layer || layer.locked) return;
      const next = setLayerProtected(asset, layerId, !(layer.protected ?? false));
      if (next === asset) return;
      setNodes((items) =>
        items.map((item) =>
          item.id === node.id
            ? {
                ...item,
                data: { ...(item.data as HgripeNodeData), layeredAsset: next },
              }
            : item,
        ),
      );
    },
    [selectedNode, layeredAsset, setNodes],
  );

  const handleMergeLayers = useCallback(
    (layerIds: string[]) => {
      const node = selectedNode;
      const asset = layeredAsset;
      if (!node || !asset || layerIds.length < 2) return;
      const members = layerIds
        .map((id) => findLayer(asset, id))
        .filter(
          (layer): layer is NonNullable<typeof layer> =>
            layer !== null && !layer.locked,
        );
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
              mask: {
                path: artifacts.mask_path,
                width: artifacts.width,
                height: artifacts.height,
              },
              rgba: {
                path: artifacts.rgba_path,
                width: artifacts.width,
                height: artifacts.height,
              },
              bbox: artifacts.bbox,
            },
          );
          setNodes((items) =>
            items.map((item) =>
              item.id === node.id
                ? {
                    ...item,
                    data: {
                      ...(item.data as HgripeNodeData),
                      layeredAsset: next,
                    },
                  }
                : item,
            ),
          );
          setSelectedLayerId((id) =>
            id && layerIds.includes(id) ? mergedId : id,
          );
        })
        .catch((error) => setMessage(String(error)));
    },
    [selectedNode, layeredAsset, setNodes, setMessage],
  );

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
            artifacts.map((part, index) => ({
              id: `${splitTag}_${index + 1}`,
              name: `${source.name} part ${index + 1}`,
              mask: {
                path: part.mask_path,
                width: part.width,
                height: part.height,
              },
              rgba: {
                path: part.rgba_path,
                width: part.width,
                height: part.height,
              },
              bbox: part.bbox,
            })),
          );
          setNodes((items) =>
            items.map((item) =>
              item.id === node.id
                ? {
                    ...item,
                    data: {
                      ...(item.data as HgripeNodeData),
                      layeredAsset: next,
                    },
                  }
                : item,
            ),
          );
          setSelectedLayerId((id) =>
            id === layerId ? `${splitTag}_1` : id,
          );
        })
        .catch((error) => setMessage(String(error)));
    },
    [selectedNode, layeredAsset, setNodes, setMessage],
  );

  return {
    activeAssetId,
    addableAsset,
    audioEdits,
    binAssets,
    changeDrawerMode,
    clipProps,
    drawerMode,
    gradeDocs,
    handleAddExportedFrame,
    handleAddSelectedToBin,
    handleCanvasSelect,
    handleImportMediaToBin,
    handleMergeLayers,
    handleSplitLayer,
    handleToggleLayerVisibility,
    handleToggleProtected,
    importMediaPathsToBin,
    layeredAsset,
    layerVisibility,
    productionTarget,
    selectedClipId,
    selectedLayerId,
    setSelectedLayerId,
    timeline,
  };
}
