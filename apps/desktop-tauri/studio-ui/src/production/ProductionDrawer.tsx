import { useEffect, useRef, useState } from "react";

import { useT, type MsgKey } from "../i18n";
import type { DrawerMode } from "./drawerState";
import { LayerReviewPanel } from "./LayerReviewPanel";
import { findLayer, type LayeredImageAsset } from "./layeredImage";
import type { MediaAsset, MediaAssetKind } from "./mediaBin";
import { ProgramMonitor } from "./ProgramMonitor";
import type { ProductionTarget } from "./productionTarget";
import {
  clipKindForAsset,
  timelineDuration,
  trackEnd,
  trackKindForClip,
  type ClipKind,
  type TimelineModel,
  type TrackKind,
} from "./timeline";

export interface AddableAsset {
  kind: MediaAssetKind;
  path: string;
  sourceNodeId: string;
}

export interface ProductionDrawerProps {
  mode: DrawerMode;
  onSetMode: (mode: DrawerMode) => void;
  /** Current unified production selection (drawer + on-demand editors). */
  target: ProductionTarget | null;
  assets: MediaAsset[];
  /** Asset id currently selected in the bin (targets `{kind:"asset"}`). */
  activeAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  /** The selected canvas node as a bin-addable media reference, when it is one. */
  addableAsset: AddableAsset | null;
  onAddSelected: () => void;
  timeline: TimelineModel;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  /** Append the active bin asset as a clip at the end of a compatible track. */
  onAddActiveToTimeline: () => void;
  /** Append the active bin asset at the end of a specific track. */
  onAddActiveToTrack: (trackId: string) => void;
  /** Append an empty video / audio track to the timeline. */
  onAddTrack: (kind: TrackKind) => void;
  /** Remove a track and its clips (the last remaining track stays). */
  onRemoveTrack: (trackId: string) => void;
  onRemoveClip: (clipId: string) => void;
  /** Right-click on an image asset / still clip: open the existing image editor. */
  onOpenImageEdit: (assetId: string) => void;
  /** Right-click on an audio clip: open the minimal trim/gain/fade editor. */
  onOpenAudioEdit: (clipId: string) => void;
  /** Clip context menu “grade”: open the grade modal for a still / video clip. */
  onOpenClipGrade: (clipId: string) => void;
  /** Clip context menu “split to layers”: spawn a Smart Layer Split card for the clip. */
  onSplitClipToLayers: (clipId: string) => void;
  /** Export command: open the on-demand export dialog for the timeline. */
  onOpenExport: () => void;
  /** A clip's stored grade doc (JSON string), for the program monitor. */
  clipGradeDoc?: (clipId: string) => string | null;
  /** Layered asset of the selected split node, when one is targeted. */
  layeredAsset: LayeredImageAsset | null;
  /** Selected layer inside `layeredAsset` (`image_layer` target), if any. */
  selectedLayerId: string | null;
  onSelectLayer: (layerId: string | null) => void;
  layerVisibility: Record<string, boolean>;
  onToggleLayerVisibility: (layerId: string) => void;
  /** Merge checked layers (desktop only; omitted in the browser preview). */
  onMergeLayers?: (layerIds: string[]) => void;
  /** Split the selected layer (desktop only; omitted in the browser preview). */
  onSplitLayer?: (layerId: string) => void;
  /** Mark / unmark a layer as protected (pure asset transform, runs anywhere). */
  onToggleProtected?: (layerId: string) => void;
}

function kindKey(kind: MediaAssetKind): MsgKey {
  return kind === "image" ? "drawer.kindImage" : kind === "video" ? "drawer.kindVideo" : "drawer.kindAudio";
}

function AssetBinIcon() {
  return (
    <svg className="production-asset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7.5h5l1.4 2H20v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 7.5V6a2 2 0 0 1 2-2h3.2l1.4 2H18a2 2 0 0 1 2 2v1.5" />
      <path d="M8 14h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg className="production-asset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

type TimelineTool = "select" | "track" | "trim" | "razor" | "pen" | "shape" | "hand" | "type";

const TIMELINE_TOOLS: Array<{ id: TimelineTool; label: string }> = [
  { id: "select", label: "Selection tool" },
  { id: "track", label: "Track select tool" },
  { id: "trim", label: "Trim tool" },
  { id: "razor", label: "Razor tool" },
  { id: "pen", label: "Pen tool" },
  { id: "shape", label: "Shape tool" },
  { id: "hand", label: "Hand tool" },
  { id: "type", label: "Type tool" },
];

function TimelineToolIcon({ tool }: { tool: TimelineTool }) {
  return (
    <svg className="production-timeline-tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {tool === "select" ? (
        <path d="M6 4l11 8-5 1.2 3.2 5.6-2.8 1.6-3.1-5.5L6 18z" />
      ) : tool === "track" ? (
        <>
          <path d="M4 7h10" />
          <path d="M4 12h16" />
          <path d="M4 17h10" />
          <path d="m15 8 4 4-4 4" />
        </>
      ) : tool === "trim" ? (
        <>
          <path d="M7 5v14" />
          <path d="M17 5v14" />
          <path d="m11 8-3 4 3 4" />
          <path d="m13 8 3 4-3 4" />
        </>
      ) : tool === "razor" ? (
        <>
          <path d="m5 18 12-12 2 2L7 20z" />
          <path d="m14 9 3 3" />
          <path d="M4 4h5" />
        </>
      ) : tool === "pen" ? (
        <>
          <path d="M5 19l4.5-1 8-8L14 6.5l-8 8z" />
          <path d="m13 8 3 3" />
          <path d="M9.5 18 6 14.5" />
        </>
      ) : tool === "shape" ? (
        <>
          <rect x="5" y="6" width="14" height="12" rx="2" />
          <path d="M8 10h8" />
        </>
      ) : tool === "hand" ? (
        <>
          <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M11 11V5.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M14 11V7a1.5 1.5 0 0 1 3 0v7.5c0 3-2.2 5.5-5.5 5.5H10c-2.3 0-3.6-1.1-4.8-3.1L4 14.8a1.6 1.6 0 0 1 2.7-1.7L8 15" />
        </>
      ) : (
        <>
          <path d="M5 6h14" />
          <path d="M12 6v12" />
          <path d="M9 18h6" />
        </>
      )}
    </svg>
  );
}

/**
 * Bottom production drawer (UNIFIED_PRODUCTION_DRAWER_PLAN.md): the resident
 * Edit / Timeline workspace under the node canvas. Image / audio / grade /
 * export editors open on demand from the workspace selection (clip context
 * menu) instead of mounting with the drawer. Collapses to a slim rail so the
 * canvas keeps its space when unused.
 */
export function ProductionDrawer({
  mode,
  onSetMode,
  target,
  assets,
  activeAssetId,
  onSelectAsset,
  onRemoveAsset,
  addableAsset,
  onAddSelected,
  timeline,
  selectedClipId,
  onSelectClip,
  onAddActiveToTrack,
  onAddTrack,
  onRemoveTrack,
  onRemoveClip,
  onOpenImageEdit,
  onOpenAudioEdit,
  onOpenClipGrade,
  onSplitClipToLayers,
  onOpenExport,
  clipGradeDoc,
  layeredAsset,
  selectedLayerId,
  onSelectLayer,
  layerVisibility,
  onToggleLayerVisibility,
  onMergeLayers,
  onSplitLayer,
  onToggleProtected,
}: ProductionDrawerProps) {
  const t = useT();
  const expanded = mode !== "collapsed";
  const [renderExpanded, setRenderExpanded] = useState(expanded);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // Clip context menu: right-click a clip for grade / edit / remove actions.
  const [clipMenu, setClipMenu] = useState<{
    x: number;
    y: number;
    clipId: string;
    assetId: string;
    kind: ClipKind;
  } | null>(null);
  const [detailTab, setDetailTab] = useState<"details" | "grade">("details");
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  const [timelineTool, setTimelineTool] = useState<TimelineTool>("select");
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
          ▴ {t("drawer.title")}
        </button>
        <span className="production-drawer-rail-meta">
          {t("drawer.assetCount", { n: assets.length })}
        </span>
      </div>
    );
  }

  const activeAsset = assets.find((a) => a.id === activeAssetId) ?? null;
  const selectedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId) ?? null;
  const selectedClipAsset = selectedClip ? (assets.find((a) => a.id === selectedClip.assetId) ?? null) : null;

  // Premiere-style track stack: video tracks on top with the highest lane
  // first (V2 above V1), audio tracks below in ascending order (A1 first).
  const videoTracks = timeline.tracks.filter((track) => track.kind === "video");
  const audioTracks = timeline.tracks.filter((track) => track.kind === "audio");
  const orderedTracks = [
    ...videoTracks.map((track, i) => ({ track, laneNumber: i + 1 })).reverse(),
    ...audioTracks.map((track, i) => ({ track, laneNumber: i + 1 })),
  ].map((entry, i, all) => ({
    ...entry,
    groupBoundary: i > 0 && all[i - 1].track.kind !== entry.track.kind,
  }));

  const clipAssetName = (clipId: string): string => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return assets.find((a) => a.id === clip.assetId)?.name ?? clip.assetId;
    }
    return clipId;
  };

  const targetLabel = !target
    ? t("drawer.targetNone")
    : target.kind === "asset"
      ? `${t("drawer.targetAsset")} · ${assets.find((a) => a.id === target.assetId)?.name ?? target.assetId}`
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

  const assetPanel = (
    <aside className="production-bin production-bin-popover" aria-label={t("drawer.binTitle")}>
      <div className="production-bin-head">
        <h3>{t("drawer.binTitle")}</h3>
        <div className="spacer" />
        <button
          onClick={onAddSelected}
          disabled={!addableAsset}
          title={t("drawer.addSelectedTitle")}
        >
          {t("drawer.addSelected")}
        </button>
        <button
          className="production-bin-close"
          onClick={() => setAssetPanelOpen(false)}
          title="关闭素材面板"
        >
          ×
        </button>
      </div>
      {assets.length === 0 ? (
        <p className="production-bin-empty">{t("drawer.binEmpty")}</p>
      ) : (
        <ul className="production-bin-list">
          {assets.map((a) => (
            <li key={a.id} className={a.id === activeAssetId ? "active" : ""}>
              <button
                className="production-bin-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("application/x-hgripe-asset", a.id);
                  onSelectAsset(a.id);
                  setDragAssetId(a.id);
                }}
                onDragEnd={() => setDragAssetId(null)}
                onClick={() => onSelectAsset(a.id === activeAssetId ? null : a.id)}
                onContextMenu={(e) => {
                  if (a.kind !== "image") return;
                  e.preventDefault();
                  onSelectAsset(a.id);
                  onOpenImageEdit(a.id);
                }}
                title={a.kind === "image" ? `${a.path} · ${t("drawer.imageEditHint")}` : a.path}
              >
                <span className={`production-bin-kind kind-${a.kind}`}>{t(kindKey(a.kind))}</span>
                <span className="production-bin-name">{a.name}</span>
              </button>
              <button
                className="production-bin-remove"
                onClick={() => onRemoveAsset(a.id)}
                title={t("drawer.removeTitle")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );

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
            <path d="M2 1.5 L24 6.5 L46 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="production-drawer-body production-edit">
        <div className="production-asset-side">
          <div className="production-side-actions">
            <button
              type="button"
              className={`production-asset-toggle${assetPanelOpen ? " active" : ""}`}
              onClick={() => setAssetPanelOpen((open) => !open)}
              title={t("drawer.binTitle")}
              aria-label={t("drawer.binTitle")}
            >
              <AssetBinIcon />
              <span className="production-asset-count">{assets.length}</span>
            </button>
            <button
              type="button"
              className="production-asset-toggle production-export-toggle"
              onClick={onOpenExport}
              disabled={timeline.tracks.every((track) => track.clips.length === 0)}
              title={t("drawer.exportTitle")}
              aria-label={t("drawer.exportTitle")}
            >
              <ExportIcon />
            </button>
          </div>
          <div className="production-timeline-tools production-timeline-side-tools" role="toolbar" aria-label="Timeline tools">
            {TIMELINE_TOOLS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={`production-timeline-tool${timelineTool === tool.id ? " active" : ""}`}
                onClick={() => setTimelineTool(tool.id)}
                title={tool.label}
                aria-label={tool.label}
                aria-pressed={timelineTool === tool.id}
              >
                <TimelineToolIcon tool={tool.id} />
              </button>
            ))}
          </div>
        </div>
        {assetPanelOpen ? <div className="production-bin-popover-shell">{assetPanel}</div> : null}
        <div className="production-edit-workspace">
          <div className="production-edit-top">
          <div className="production-program-column" ref={programColumnRef}>
            <ProgramMonitor timeline={timeline} assets={assets} clipGradeDoc={clipGradeDoc} />
          </div>

          <aside
            className="production-detail-panel"
            style={monitorCardHeight ? { height: `${monitorCardHeight}px`, maxHeight: `${monitorCardHeight}px` } : undefined}
          >
            <div className="production-detail-tabs" role="tablist" aria-label={t("drawer.detailTabs")}>
              <button
                type="button"
                className={detailTab === "details" ? "active" : ""}
                aria-selected={detailTab === "details"}
                onClick={() => setDetailTab("details")}
              >
                {t("drawer.detailsTab")}
              </button>
              <button
                type="button"
                className={detailTab === "grade" ? "active" : ""}
                aria-selected={detailTab === "grade"}
                onClick={() => setDetailTab("grade")}
              >
                {t("drawer.gradeTab")}
              </button>
            </div>
            <div className="production-detail-body">
              {detailTab === "details" ? (
                layeredAsset ? (
                  <LayerReviewPanel
                    asset={layeredAsset}
                    selectedLayerId={selectedLayerId}
                    onSelectLayer={onSelectLayer}
                    visibility={layerVisibility}
                    onToggleVisibility={onToggleLayerVisibility}
                    onMergeLayers={onMergeLayers}
                    onSplitLayer={onSplitLayer}
                    onToggleProtected={onToggleProtected}
                  />
                ) : selectedClip ? (
                  <dl className="production-detail-list">
                    <div>
                      <dt>{t("drawer.detailClip")}</dt>
                      <dd>{selectedClipAsset?.name ?? selectedClip.assetId}</dd>
                    </div>
                    <div>
                      <dt>{t("drawer.detailKind")}</dt>
                      <dd>{selectedClip.kind}</dd>
                    </div>
                    <div>
                      <dt>{t("drawer.detailRange")}</dt>
                      <dd>
                        {selectedClip.start.toFixed(2)}s - {(selectedClip.start + selectedClip.duration).toFixed(2)}s
                      </dd>
                    </div>
                  </dl>
                ) : activeAsset ? (
                  <dl className="production-detail-list">
                    <div>
                      <dt>{t("drawer.detailAsset")}</dt>
                      <dd>{activeAsset.name}</dd>
                    </div>
                    <div>
                      <dt>{t("drawer.detailKind")}</dt>
                      <dd>{t(kindKey(activeAsset.kind))}</dd>
                    </div>
                    <div>
                      <dt>{t("drawer.detailPath")}</dt>
                      <dd title={activeAsset.path}>{activeAsset.path}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="production-detail-empty">{t("drawer.detailEmpty")}</p>
                )
              ) : (
                <p className="production-detail-empty">{t("drawer.gradePlaceholder")}</p>
              )}
            </div>
          </aside>
          </div>

          <div className="production-timeline-shell">
            <div className="production-timeline">
            <div className="production-timeline-head">
              <h3>{t("drawer.timelineTitle")}</h3>
              <span className="production-timeline-duration">
                {t("drawer.timelineDuration", { s: timelineDuration(timeline).toFixed(1) })}
              </span>
              <div className="spacer" />
              </div>
              <div className="production-timeline-tracks">
              {orderedTracks.map(({ track, laneNumber, groupBoundary }) => {
                // Scale every lane to the same overall timeline length so clip
                // positions line up vertically across tracks.
                const total = Math.max(timelineDuration(timeline), Math.max(trackEnd(track), 1));
                const acceptsActive =
                  !!activeAsset && trackKindForClip(clipKindForAsset(activeAsset.kind)) === track.kind;
                return (
                  <div
                    key={track.id}
                    className={`production-track${groupBoundary ? " production-track-group-start" : ""}`}
                  >
                    <span className="production-track-head">
                      <span className={`production-track-label track-${track.kind}`}>
                        {(track.kind === "video" ? t("drawer.trackVideo") : t("drawer.trackAudio")) + laneNumber}
                      </span>
                      <span className="production-track-controls">
                          <button
                            onClick={() => onAddTrack(track.kind)}
                            title={track.kind === "video" ? t("drawer.addVideoTrackTitle") : t("drawer.addAudioTrackTitle")}
                          >
                            +
                          </button>
                        <button
                          onClick={() => onRemoveTrack(track.id)}
                          disabled={timeline.tracks.length <= 1}
                          title={t("drawer.removeTrackTitle")}
                        >
                          ×
                        </button>
                      </span>
                    </span>
                    <div
                      className={`production-track-lane${dragAssetId && acceptsActive ? " drop-ready" : ""}`}
                      onDragOver={(e) => {
                        if (!acceptsActive) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                      }}
                      onDrop={(e) => {
                        if (!acceptsActive) return;
                        e.preventDefault();
                        onAddActiveToTrack(track.id);
                        setDragAssetId(null);
                      }}
                    >
                      {track.clips.map((clip) => {
                        const selected = clip.id === selectedClipId;
                        return (
                          <button
                            key={clip.id}
                            className={`production-clip clip-${clip.kind}${selected ? " active" : ""}`}
                            style={{
                              left: `${(clip.start / total) * 100}%`,
                              width: `${(clip.duration / total) * 100}%`,
                            }}
                            onClick={() => onSelectClip(selected ? null : clip.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              onSelectClip(clip.id);
                              setClipMenu({
                                x: e.clientX,
                                y: e.clientY,
                                clipId: clip.id,
                                assetId: clip.assetId,
                                kind: clip.kind,
                              });
                            }}
                            title={`${clipAssetName(clip.id)} · ${clip.start.toFixed(1)}s → ${(clip.start + clip.duration).toFixed(1)}s · ${t("drawer.clipMenuHint")}`}
                          >
                            <span className="production-clip-name">{clipAssetName(clip.id)}</span>
                            {selected ? (
                              <span
                                className="production-clip-remove"
                                role="button"
                                title={t("drawer.removeClipTitle")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRemoveClip(clip.id);
                                }}
                              >
                                ×
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
          </div>
        </div>
      </div>
      {clipMenu ? (
        <div
          className="production-clip-menu-backdrop"
          onClick={() => setClipMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setClipMenu(null);
          }}
        >
          <div
            className="production-clip-menu"
            style={{ left: clipMenu.x, top: clipMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {clipMenu.kind !== "audio" ? (
              <button
                onClick={() => {
                  onOpenClipGrade(clipMenu.clipId);
                  setClipMenu(null);
                }}
              >
                {t("drawer.menuGrade")}
              </button>
            ) : null}
            {clipMenu.kind === "still" ? (
              <button
                onClick={() => {
                  onOpenImageEdit(clipMenu.assetId);
                  setClipMenu(null);
                }}
              >
                {t("drawer.menuEditImage")}
              </button>
            ) : null}
            {clipMenu.kind !== "audio" ? (
              <button
                onClick={() => {
                  onSplitClipToLayers(clipMenu.clipId);
                  setClipMenu(null);
                }}
              >
                {t("drawer.menuSplitLayers")}
              </button>
            ) : null}
            {clipMenu.kind === "audio" ? (
              <button
                onClick={() => {
                  onOpenAudioEdit(clipMenu.clipId);
                  setClipMenu(null);
                }}
              >
                {t("drawer.menuEditAudio")}
              </button>
            ) : null}
            <button
              onClick={() => {
                onRemoveClip(clipMenu.clipId);
                setClipMenu(null);
              }}
            >
              {t("drawer.menuRemoveClip")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
