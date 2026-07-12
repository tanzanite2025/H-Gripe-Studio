import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { defaultClipProperties } from "./clipProps";
import type { DrawerMode } from "./drawerState";
import { DrawerToolbar, type TimelineTool } from "./DrawerToolbar";
import { findLayer, type LayeredImageAsset } from "../domain/layeredImage";
import type { AddableAsset } from "./MediaWorkspacePopover";
import { ProgramMonitor } from "./ProgramMonitor";
import { ProductionInspector } from "./ProductionInspector";
import type { ProductionTarget } from "./productionTarget";
import {
  clearSequencePlaybackInPointAction,
  clearSequencePlaybackOutPointAction,
  clipGradeDocOf,
  copySelectedTimelineClipsToClipboard,
  cutSelectedTimelineClipsToClipboard,
  pasteTimelineClipboardAtTime,
  removeAssetFromBin,
  removeSelectedTimelineClips,
  selectBinAsset,
  setClipProperties,
  setSequencePlaybackInPoint,
  setSequencePlaybackOutPoint,
  toggleTimelineMarker,
} from "./productionStore";
import {
  useProductionStateFromContext,
  useProductionStoreFromContext,
} from "./productionStoreContext";
import { ProductionTimeline } from "./ProductionTimeline";

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

/** The production drawer reads bin/timeline/selection state from the
 * production store on context; only the drawer chrome (mode/target) and the
 * cross-module service ports remain props. */
export function ProductionDrawer({
  mode,
  onSetMode,
  target,
  ports,
}: ProductionDrawerProps) {
  const t = useT();
  const store = useProductionStoreFromContext();
  const assets = useProductionStateFromContext((state) => state.binAssets);
  const activeAssetId = useProductionStateFromContext((state) => state.activeAssetId);
  const timeline = useProductionStateFromContext((state) => state.timeline);
  const selectedClipId = useProductionStateFromContext((state) => state.selectedClipId);
  const clipProps = useProductionStateFromContext((state) => state.clipProps);
  const clipProperties = selectedClipId
    ? (clipProps[selectedClipId] ?? defaultClipProperties())
    : undefined;
  const clipGradeDoc = useCallback(
    (clipId: string) => clipGradeDocOf(store.getState(), clipId),
    [store],
  );
  const clipPropsDoc = useCallback(
    (clipId: string) => {
      const props = store.getState().clipProps[clipId];
      return props ? JSON.stringify(props) : null;
    },
    [store],
  );

  const { addableAsset, addSelected: onAddSelected, importMedia: onImportMedia } = ports.assetBin;
  const {
    openImageEdit: onOpenImageEdit,
    openAudioEdit: onOpenAudioEdit,
    openClipGrade: onOpenClipGrade,
    splitClipToLayers: onSplitClipToLayers,
  } = ports.editorLauncher;
  const {
    asset: layeredAsset,
    selectedLayerId,
    selectLayer: onSelectLayer,
    visibility: layerVisibility,
    toggleVisibility: onToggleLayerVisibility,
    merge: onMergeLayers,
    split: onSplitLayer,
    toggleProtected: onToggleProtected,
  } = ports.layerService;
  const expanded = mode !== "collapsed";
  const [renderExpanded, setRenderExpanded] = useState(expanded);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
  const [playheadSec, setPlayheadSec] = useState(0);
  const playheadSecRef = useRef(0);
  playheadSecRef.current = playheadSec;
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

  // Timeline keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
  // Ctrl+C / Ctrl+X / Ctrl+V copy / cut / paste-at-playhead the selected
  // clips, Delete / Backspace removes the selected clips, M toggles a
  // sequence marker and I / O set the playback in/out points at the playhead.
  // Skipped while typing in form fields or editable content.
  useEffect(() => {
    if (!renderExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      )
        return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        store.redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "c") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        copySelectedTimelineClipsToClipboard(store);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "x") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        cutSelectedTimelineClipsToClipboard(store);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") {
        if (store.getState().clipClipboard.length === 0) return;
        event.preventDefault();
        pasteTimelineClipboardAtTime(store, playheadSecRef.current);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        removeSelectedTimelineClips(store);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (key === "m") {
        event.preventDefault();
        toggleTimelineMarker(store, playheadSecRef.current);
        return;
      }
      if (key === "i") {
        event.preventDefault();
        setSequencePlaybackInPoint(store, playheadSecRef.current);
        return;
      }
      if (key === "o") {
        event.preventDefault();
        setSequencePlaybackOutPoint(store, playheadSecRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renderExpanded, store]);

  // Pointer-based asset drag ends wherever the pointer is released; track
  // lanes handle their own pointerup first, then this clears the drag state.
  useEffect(() => {
    if (dragAssetId == null) return;
    const clear = () => setDragAssetId(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
  }, [dragAssetId]);

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
          onSelectAsset={(assetId) => selectBinAsset(store, assetId)}
          onRemoveAsset={(assetId) => removeAssetFromBin(store, assetId)}
          onOpenImageEdit={onOpenImageEdit}
          onDragAssetChange={setDragAssetId}
          onOpenExport={ports.exportService.open}
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
                onToggleSequenceMarkerAtSec={(sec) => toggleTimelineMarker(store, sec)}
                onSetSequencePlaybackInPointSec={(sec) => setSequencePlaybackInPoint(store, sec)}
                onSetSequencePlaybackOutPointSec={(sec) => setSequencePlaybackOutPoint(store, sec)}
                onClearSequencePlaybackInPoint={() => clearSequencePlaybackInPointAction(store)}
                onClearSequencePlaybackOutPoint={() => clearSequencePlaybackOutPointAction(store)}
                onExportedFrame={(asset) => {
                  ports.exportService.addExportedFrame?.(asset);
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
              onSetClipProperties={(clipId, props) => setClipProperties(store, clipId, props)}
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
            timelineTool={timelineTool}
            dragAssetId={dragAssetId}
            playheadSec={playheadSec}
            onPlayheadSecChange={setPlayheadSec}
            onDragAssetChange={setDragAssetId}
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
