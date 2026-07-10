import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { defaultClipProperties, type ClipProperties } from "./clipProps";
import type { DrawerMode } from "./drawerState";
import { DrawerToolbar, type TimelineTool } from "./DrawerToolbar";
import { findLayer, type LayeredImageAsset } from "../domain/layeredImage";
import type { AddableAsset } from "./MediaWorkspacePopover";
import type { MediaAsset } from "./mediaBin";
import { ProgramMonitor } from "./ProgramMonitor";
import { ProductionInspector } from "./ProductionInspector";
import type { ProductionTarget } from "./productionTarget";
import {
  addAssetClip,
  addTimelineTrack,
  clipGradeDocOf,
  productionStore,
  removeAssetFromBin,
  removeTimelineClip,
  removeTimelineMarker,
  removeTimelineTrack,
  selectBinAsset,
  selectClip,
  setClipProperties,
  splitTimelineClip,
  toggleTimelineMarker,
  toggleTimelineTrackHidden,
  toggleTimelineTrackLock,
  useProductionState,
} from "./productionStore";
import { ProductionTimeline } from "./ProductionTimeline";
import type { TimelineModel, TrackKind } from "./timeline";

export interface ProductionDrawerPorts {
  assetBin: {
    addableAsset: AddableAsset | null;
    addSelected: () => void;
    importMedia?: () => void;
  };
  editorLauncher: {
    openImageEdit: (assetId: string) => void;
    openAudioEdit: (clipId: string) => void;
    openClipGrade: (clipId: string) => void;
    splitClipToLayers: (clipId: string) => void;
  };
  exportService: {
    open: () => void;
    addExportedFrame?: (asset: { path: string; name: string }) => void;
  };
  layerService: {
    asset: LayeredImageAsset | null;
    selectedLayerId: string | null;
    selectLayer: (layerId: string | null) => void;
    visibility: Record<string, boolean>;
    toggleVisibility: (layerId: string) => void;
    merge?: (layerIds: string[]) => void;
    split?: (layerId: string) => void;
    toggleProtected?: (layerId: string) => void;
  };
}

export interface ProductionDrawerProps {
  mode: DrawerMode;
  onSetMode: (mode: DrawerMode) => void;
  target: ProductionTarget | null;
  ports: ProductionDrawerPorts;
}

export interface ProductionDrawerViewProps {
  mode: DrawerMode;
  onSetMode: (mode: DrawerMode) => void;
  target: ProductionTarget | null;
  assets: MediaAsset[];
  activeAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  addableAsset: AddableAsset | null;
  onAddSelected: () => void;
  onImportMedia?: () => void;
  timeline: TimelineModel;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  onAddActiveToTrack: (trackId: string) => void;
  onAddTrack: (kind: TrackKind) => void;
  onRemoveTrack: (trackId: string) => void;
  onRemoveClip: (clipId: string) => void;
  onSplitClipAt: (clipId: string, atSec: number) => void;
  onToggleMarkerAt?: (sec: number) => void;
  onRemoveMarker?: (markerId: string) => void;
  onToggleTrackLock?: (trackId: string) => void;
  onToggleTrackHidden?: (trackId: string) => void;
  onOpenImageEdit: (assetId: string) => void;
  onOpenAudioEdit: (clipId: string) => void;
  onOpenClipGrade: (clipId: string) => void;
  onSplitClipToLayers: (clipId: string) => void;
  onOpenExport: () => void;
  onAddExportedFrame?: (asset: { path: string; name: string }) => void;
  clipGradeDoc?: (clipId: string) => string | null;
  clipPropsDoc?: (clipId: string) => string | null;
  clipProperties?: ClipProperties;
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
  layeredAsset: LayeredImageAsset | null;
  selectedLayerId: string | null;
  onSelectLayer: (layerId: string | null) => void;
  layerVisibility: Record<string, boolean>;
  onToggleLayerVisibility: (layerId: string) => void;
  onMergeLayers?: (layerIds: string[]) => void;
  onSplitLayer?: (layerId: string) => void;
  onToggleProtected?: (layerId: string) => void;
}

export function ProductionDrawer({
  mode,
  onSetMode,
  target,
  ports,
}: ProductionDrawerProps) {
  const assets = useProductionState((state) => state.binAssets);
  const activeAssetId = useProductionState((state) => state.activeAssetId);
  const timeline = useProductionState((state) => state.timeline);
  const selectedClipId = useProductionState((state) => state.selectedClipId);
  const clipProps = useProductionState((state) => state.clipProps);
  const clipProperties = selectedClipId
    ? (clipProps[selectedClipId] ?? defaultClipProperties())
    : undefined;
  const clipGradeDoc = useCallback(
    (clipId: string) => clipGradeDocOf(productionStore.getState(), clipId),
    [],
  );
  const clipPropsDoc = useCallback((clipId: string) => {
    const props = productionStore.getState().clipProps[clipId];
    return props ? JSON.stringify(props) : null;
  }, []);

  return (
    <ProductionDrawerView
      mode={mode}
      onSetMode={onSetMode}
      target={target}
      assets={assets}
      activeAssetId={activeAssetId}
      onSelectAsset={(assetId) => selectBinAsset(productionStore, assetId)}
      onRemoveAsset={(assetId) => removeAssetFromBin(productionStore, assetId)}
      addableAsset={ports.assetBin.addableAsset}
      onAddSelected={ports.assetBin.addSelected}
      onImportMedia={ports.assetBin.importMedia}
      timeline={timeline}
      selectedClipId={selectedClipId}
      onSelectClip={(clipId) => selectClip(productionStore, clipId)}
      onAddActiveToTrack={(trackId) => {
        const assetId = productionStore.getState().activeAssetId;
        if (assetId) addAssetClip(productionStore, assetId, { trackId });
      }}
      onAddTrack={(kind) => addTimelineTrack(productionStore, kind)}
      onRemoveTrack={(trackId) => removeTimelineTrack(productionStore, trackId)}
      onRemoveClip={(clipId) => removeTimelineClip(productionStore, clipId)}
      onSplitClipAt={(clipId, atSec) => splitTimelineClip(productionStore, clipId, atSec)}
      onToggleMarkerAt={(sec) => toggleTimelineMarker(productionStore, sec)}
      onRemoveMarker={(markerId) => removeTimelineMarker(productionStore, markerId)}
      onToggleTrackLock={(trackId) => toggleTimelineTrackLock(productionStore, trackId)}
      onToggleTrackHidden={(trackId) => toggleTimelineTrackHidden(productionStore, trackId)}
      onOpenImageEdit={ports.editorLauncher.openImageEdit}
      onOpenAudioEdit={ports.editorLauncher.openAudioEdit}
      onOpenClipGrade={ports.editorLauncher.openClipGrade}
      onSplitClipToLayers={ports.editorLauncher.splitClipToLayers}
      onOpenExport={ports.exportService.open}
      onAddExportedFrame={ports.exportService.addExportedFrame}
      clipGradeDoc={clipGradeDoc}
      clipPropsDoc={clipPropsDoc}
      clipProperties={clipProperties}
      onSetClipProperties={(clipId, props) => setClipProperties(productionStore, clipId, props)}
      layeredAsset={ports.layerService.asset}
      selectedLayerId={ports.layerService.selectedLayerId}
      onSelectLayer={ports.layerService.selectLayer}
      layerVisibility={ports.layerService.visibility}
      onToggleLayerVisibility={ports.layerService.toggleVisibility}
      onMergeLayers={ports.layerService.merge}
      onSplitLayer={ports.layerService.split}
      onToggleProtected={ports.layerService.toggleProtected}
    />
  );
}

export function ProductionDrawerView({
  mode,
  onSetMode,
  target,
  assets,
  activeAssetId,
  onSelectAsset,
  onRemoveAsset,
  addableAsset,
  onAddSelected,
  onImportMedia,
  timeline,
  selectedClipId,
  onSelectClip,
  onAddActiveToTrack,
  onAddTrack,
  onRemoveTrack,
  onRemoveClip,
  onSplitClipAt,
  onToggleMarkerAt,
  onRemoveMarker,
  onToggleTrackLock,
  onToggleTrackHidden,
  onOpenImageEdit,
  onOpenAudioEdit,
  onOpenClipGrade,
  onSplitClipToLayers,
  onOpenExport,
  onAddExportedFrame,
  clipGradeDoc,
  clipPropsDoc,
  clipProperties,
  onSetClipProperties,
  layeredAsset,
  selectedLayerId,
  onSelectLayer,
  layerVisibility,
  onToggleLayerVisibility,
  onMergeLayers,
  onSplitLayer,
  onToggleProtected,
}: ProductionDrawerViewProps) {
  const t = useT();
  const expanded = mode !== "collapsed";
  const [renderExpanded, setRenderExpanded] = useState(expanded);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
  const [playheadSec, setPlayheadSec] = useState(0);
  const programColumnRef = useRef<HTMLDivElement | null>(null);
  const [monitorCardHeight, setMonitorCardHeight] = useState<number | null>(null);

  useEffect(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (expanded) {
      setRenderExpanded(true);
      setClosing(false);
      return;
    }
    if (!renderExpanded) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setRenderExpanded(false);
      setClosing(false);
      closeTimer.current = null;
    }, 220);
    return () => {
      if (closeTimer.current != null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [expanded, renderExpanded]);

  useEffect(() => {
    if (!renderExpanded) {
      setMonitorCardHeight(null);
      return;
    }
    let observer: ResizeObserver | null = null;
    let raf = 0;
    let cleanupResize: (() => void) | null = null;
    const attach = () => {
      const monitor = programColumnRef.current?.querySelector<HTMLElement>(".production-monitor");
      if (!monitor) {
        setMonitorCardHeight(null);
        return;
      }
      const syncHeight = () => {
        const next = Math.ceil(monitor.getBoundingClientRect().height);
        setMonitorCardHeight((current) => (current === next ? current : next));
      };
      syncHeight();
      window.addEventListener("resize", syncHeight);
      cleanupResize = () => window.removeEventListener("resize", syncHeight);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(syncHeight);
        observer.observe(monitor);
      }
    };
    raf = window.requestAnimationFrame(attach);
    return () => {
      window.cancelAnimationFrame(raf);
      cleanupResize?.();
      observer?.disconnect();
    };
  }, [renderExpanded]);

  if (!renderExpanded) {
    return (
      <div className="production-drawer production-drawer-rail">
        <button
          className="production-drawer-handle"
          onClick={() => onSetMode("open")}
          title={t("drawer.openTitle")}
        >
          › {t("drawer.title")}
        </button>
        <span className="production-drawer-rail-meta">
          {t("drawer.assetCount", { n: assets.length })}
        </span>
      </div>
    );
  }

  const activeAsset = assets.find((asset) => asset.id === activeAssetId) ?? null;
  const selectedClip =
    timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === selectedClipId) ?? null;
  const selectedClipAsset = selectedClip
    ? (assets.find((asset) => asset.id === selectedClip.assetId) ?? null)
    : null;
  const clipAssetName = (clipId: string): string => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip) return assets.find((asset) => asset.id === clip.assetId)?.name ?? clip.assetId;
    }
    return clipId;
  };
  const targetLabel = !target
    ? t("drawer.targetNone")
    : target.kind === "asset"
      ? `${t("drawer.targetAsset")} · ${assets.find((asset) => asset.id === target.assetId)?.name ?? target.assetId}`
      : target.kind === "node_output"
        ? `${t("drawer.targetNode")} · ${target.nodeId}`
        : target.kind === "video_clip"
          ? `${t("drawer.targetVideoClip")} · ${clipAssetName(target.clipId)}`
          : target.kind === "audio_clip"
            ? `${t("drawer.targetAudioClip")} · ${clipAssetName(target.clipId)}`
            : target.kind === "layered_image"
              ? `${t("drawer.targetLayeredImage")} · ${target.assetId}`
              : target.kind === "image_layer"
                ? `${t("drawer.targetImageLayer")} · ${
                    (layeredAsset && findLayer(layeredAsset, target.layerId)?.name) ?? target.layerId
                  }`
                : target.kind;

  return (
    <div className={`production-drawer production-drawer-open${closing ? " production-drawer-closing" : ""}`}>
      <div className="production-drawer-head">
        <span className="production-drawer-title">{t("drawer.tabEdit")}</span>
        <span className="production-drawer-target" title={targetLabel}>
          {targetLabel}
        </span>
        <div className="spacer" />
        <button
          className="production-drawer-collapse"
          onClick={() => onSetMode("collapsed")}
          title={t("drawer.collapseTitle")}
          aria-label={t("drawer.collapseTitle")}
        >
          <svg viewBox="0 0 48 8" width="48" height="8" aria-hidden="true">
            <path
              d="M2 1.5 L24 6.5 L46 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="production-drawer-body production-edit">
        <DrawerToolbar
          assets={assets}
          activeAssetId={activeAssetId}
          addableAsset={addableAsset}
          assetPanelOpen={assetPanelOpen}
          onAssetPanelOpenChange={setAssetPanelOpen}
          onAddSelected={onAddSelected}
          onImportMedia={onImportMedia}
          onSelectAsset={onSelectAsset}
          onRemoveAsset={onRemoveAsset}
          onOpenImageEdit={onOpenImageEdit}
          onDragAssetChange={setDragAssetId}
          onOpenExport={onOpenExport}
          exportDisabled={timeline.tracks.every((track) => track.clips.length === 0)}
          timelineTool={timelineTool}
          onTimelineToolChange={setTimelineTool}
        />
        <div className="production-edit-workspace">
          <div className="production-edit-top">
            <div className="production-program-column" ref={programColumnRef}>
              <ProgramMonitor
                timeline={timeline}
                assets={assets}
                clipGradeDoc={clipGradeDoc}
                clipPropsDoc={clipPropsDoc}
                playheadSec={playheadSec}
                onPlayheadSecChange={setPlayheadSec}
                onExportedFrame={(asset) => {
                  onAddExportedFrame?.(asset);
                  setAssetPanelOpen(true);
                }}
              />
            </div>
            <ProductionInspector
              activeAsset={activeAsset}
              selectedClip={selectedClip}
              selectedClipAsset={selectedClipAsset}
              playheadSec={playheadSec}
              clipProperties={clipProperties}
              onSetClipProperties={onSetClipProperties}
              layeredAsset={layeredAsset}
              selectedLayerId={selectedLayerId}
              onSelectLayer={onSelectLayer}
              layerVisibility={layerVisibility}
              onToggleLayerVisibility={onToggleLayerVisibility}
              onMergeLayers={onMergeLayers}
              onSplitLayer={onSplitLayer}
              onToggleProtected={onToggleProtected}
              height={monitorCardHeight}
            />
          </div>
          <ProductionTimeline
            timeline={timeline}
            assets={assets}
            activeAsset={activeAsset}
            selectedClipId={selectedClipId}
            clipProperties={clipProperties}
            timelineTool={timelineTool}
            dragAssetId={dragAssetId}
            playheadSec={playheadSec}
            onPlayheadSecChange={setPlayheadSec}
            onDragAssetChange={setDragAssetId}
            onSelectClip={onSelectClip}
            onAddActiveToTrack={onAddActiveToTrack}
            onAddTrack={onAddTrack}
            onRemoveTrack={onRemoveTrack}
            onRemoveClip={onRemoveClip}
            onSplitClipAt={onSplitClipAt}
            onToggleMarkerAt={onToggleMarkerAt}
            onRemoveMarker={onRemoveMarker}
            onToggleTrackLock={onToggleTrackLock}
            onToggleTrackHidden={onToggleTrackHidden}
            onSetClipProperties={onSetClipProperties}
            onOpenImageEdit={onOpenImageEdit}
            onOpenAudioEdit={onOpenAudioEdit}
            onOpenClipGrade={onOpenClipGrade}
            onSplitClipToLayers={onSplitClipToLayers}
          />
        </div>
      </div>
    </div>
  );
}
