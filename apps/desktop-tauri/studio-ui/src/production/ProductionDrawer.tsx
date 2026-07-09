import { useEffect, useRef, useState } from "react";

import { useT, type MsgKey } from "../i18n";
import { ClipPropertiesPanel } from "./ClipPropertiesPanel";
import type { ClipProperties } from "./clipProps";
import type { DrawerMode } from "./drawerState";
import {
  moveKeyframesAtTime,
  removeKeyframesAtTime,
  timelineKeyframeGroups,
} from "./keyframes";
import { LayerReviewPanel } from "./LayerReviewPanel";
import { findLayer, type LayeredImageAsset } from "./layeredImage";
import type { MediaAsset } from "./mediaBin";
import {
  MediaWorkspacePopover,
  mediaAssetKindLabel,
  type AddableAsset,
} from "./MediaWorkspacePopover";
import { ProgramMonitor } from "./ProgramMonitor";
import type { ProductionTarget } from "./productionTarget";
import { TimelineRuler, timelineRulerDuration } from "./TimelineRuler";
import {
  clipKindForAsset,
  DEFAULT_TIMELINE_FPS,
  MIN_CLIP_SECONDS,
  timelineDuration,
  timelineSnapPoints,
  snapTimeToPoints,
  trackKindForClip,
  type ClipKind,
  type TimelineModel,
  type TrackKind,
} from "./timeline";

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
  onImportMedia?: () => void;
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
  onSplitClipAt: (clipId: string, atSec: number) => void;
  /** M key on the ruler: add / clear a sequence marker at the playhead. */
  onToggleMarkerAt?: (sec: number) => void;
  /** Right-click a ruler marker to remove it. */
  onRemoveMarker?: (markerId: string) => void;
  /** Track head lock toggle: a locked track rejects drops and razor cuts. */
  onToggleTrackLock?: (trackId: string) => void;
  /** Track head eye toggle: hide (video) / mute (audio) the track. */
  onToggleTrackHidden?: (trackId: string) => void;
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
  /** Register a monitor frame export as a media-bin image. */
  onAddExportedFrame?: (asset: { path: string; name: string }) => void;
  /** A clip's stored grade doc (JSON string), for the program monitor. */
  clipGradeDoc?: (clipId: string) => string | null;
  /** A clip's property document (JSON string), resolved at the playhead
   * time and composited by the program monitor. */
  clipPropsDoc?: (clipId: string) => string | null;
  /** The selected clip's property document (transform / crop), when a
   * visual clip is selected. */
  clipProperties?: ClipProperties;
  /** Commit the selected clip's property document. */
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
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

function TrackToggleIcon({ kind }: { kind: "visible" | "hidden" | "locked" | "unlocked" }) {
  return (
    <svg className="production-track-toggle-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === "visible" ? (
        <>
          <path d="M2.5 12c2.6-4.4 5.8-6.5 9.5-6.5s6.9 2.1 9.5 6.5c-2.6 4.4-5.8 6.5-9.5 6.5S5.1 16.4 2.5 12z" />
          <circle cx="12" cy="12" r="2.6" />
        </>
      ) : kind === "hidden" ? (
        <>
          <path d="M2.5 12c2.6-4.4 5.8-6.5 9.5-6.5s6.9 2.1 9.5 6.5c-2.6 4.4-5.8 6.5-9.5 6.5S5.1 16.4 2.5 12z" />
          <path d="m4 20 16-16" />
        </>
      ) : kind === "locked" ? (
        <>
          <rect x="5.5" y="11" width="13" height="8.5" rx="1.6" />
          <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
        </>
      ) : (
        <>
          <rect x="5.5" y="11" width="13" height="8.5" rx="1.6" />
          <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0" />
        </>
      )}
    </svg>
  );
}

// Timeline edit modes, Premiere/Resolve-style: the rail only offers tools
// that are actually wired up (Resolve's three core modes — pointer, blade,
// hand). New tools join this list once their lane behavior exists.
type TimelineTool = "select" | "razor" | "hand";

const TIMELINE_TOOLS: Array<{ id: TimelineTool; labelKey: MsgKey }> = [
  { id: "select", labelKey: "drawer.timelineToolSelect" },
  { id: "razor", labelKey: "drawer.timelineToolRazor" },
  { id: "hand", labelKey: "drawer.timelineToolHand" },
];

function TimelineToolIcon({ tool }: { tool: TimelineTool }) {
  return (
    <svg className="production-timeline-tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {tool === "select" ? (
        <path d="M6 4l11 8-5 1.2 3.2 5.6-2.8 1.6-3.1-5.5L6 18z" />
      ) : tool === "razor" ? (
        <>
          <path d="m5 18 12-12 2 2L7 20z" />
          <path d="m14 9 3 3" />
          <path d="M4 4h5" />
        </>
      ) : (
        <>
          <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M11 11V5.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M14 11V7a1.5 1.5 0 0 1 3 0v7.5c0 3-2.2 5.5-5.5 5.5H10c-2.3 0-3.6-1.1-4.8-3.1L4 14.8a1.6 1.6 0 0 1 2.7-1.7L8 15" />
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
  const [razorPreview, setRazorPreview] = useState<{ clipId: string; ratio: number; valid: boolean } | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  // Horizontal timeline zoom (1 = fit): the ruler / lane content stretches to
  // zoom * viewport width inside the shared scroll viewport.
  const [timelineZoom, setTimelineZoom] = useState(1);
  const programColumnRef = useRef<HTMLDivElement | null>(null);
  const trackRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const handPan = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const keyframeDrag = useRef<{
    pointerId: number;
    clipId: string;
    fromT: number;
    clipStart: number;
    clipDuration: number;
    clipLeft: number;
    clipWidth: number;
    props: ClipProperties;
  } | null>(null);
  const navFlashTimer = useRef<number | null>(null);
  const [navFlashTrackId, setNavFlashTrackId] = useState<string | null>(null);
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

  useEffect(() => {
    if (timelineTool !== "razor") setRazorPreview(null);
  }, [timelineTool]);

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
  const timelineFps = timeline.fps ?? DEFAULT_TIMELINE_FPS;
  const timelineLen = timelineDuration(timeline);
  // One shared horizontal scale for the ruler and every lane, so the playhead
  // line and clip positions stay vertically aligned across tracks.
  const rulerDuration = timelineRulerDuration(timelineLen, playheadSec);
  const snapPoints = timelineSnapPoints(timeline);
  const playheadRatio = Math.min(1, Math.max(0, playheadSec / rulerDuration));

  // Track stack: image tracks on top (they override video in the program
  // output), then video tracks with the highest lane first (V2 above V1),
  // then audio tracks in ascending order (A1 first).
  const imageTracks = timeline.tracks.filter((track) => track.kind === "image");
  const videoTracks = timeline.tracks.filter((track) => track.kind === "video");
  const audioTracks = timeline.tracks.filter((track) => track.kind === "audio");
  const orderedTracks = [
    ...imageTracks.map((track, i) => ({ track, laneNumber: i + 1 })).reverse(),
    ...videoTracks.map((track, i) => ({ track, laneNumber: i + 1 })).reverse(),
    ...audioTracks.map((track, i) => ({ track, laneNumber: i + 1 })),
  ].map((entry, i, all) => ({
    ...entry,
    groupBoundary: i > 0 && all[i - 1].track.kind !== entry.track.kind,
  }));

  const trackKindLabel = (kind: TrackKind): string =>
    t(kind === "video" ? "drawer.trackVideo" : kind === "audio" ? "drawer.trackAudio" : "drawer.trackImage");

  const clipAssetName = (clipId: string): string => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return assets.find((a) => a.id === clip.assetId)?.name ?? clip.assetId;
    }
    return clipId;
  };

  // Scroll the tracks container itself (scrollIntoView would also drag the
  // page / drawer around) and flash the lane so short stacks still respond.
  const scrollTrackIntoView = (trackId: string) => {
    const el = trackRefs.current[trackId];
    const container = tracksScrollRef.current;
    if (el && container) {
      const top =
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        (container.clientHeight - el.clientHeight) / 2;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    setNavFlashTrackId(trackId);
    if (navFlashTimer.current != null) window.clearTimeout(navFlashTimer.current);
    navFlashTimer.current = window.setTimeout(() => {
      setNavFlashTrackId(null);
      navFlashTimer.current = null;
    }, 1000);
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
    <MediaWorkspacePopover
      assets={assets}
      activeAssetId={activeAssetId}
      addableAsset={addableAsset}
      onAddSelected={onAddSelected}
      onImportMedia={onImportMedia}
      onClose={() => setAssetPanelOpen(false)}
      onSelectAsset={onSelectAsset}
      onRemoveAsset={onRemoveAsset}
      onOpenImageEdit={onOpenImageEdit}
      onDragAssetChange={setDragAssetId}
    />
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
                  title={t(tool.labelKey)}
                  aria-label={t(tool.labelKey)}
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
                  <>
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
                    {selectedClip.kind !== "audio" && clipProperties && onSetClipProperties ? (
                      <ClipPropertiesPanel
                        clipName={selectedClipAsset?.name ?? selectedClip.assetId}
                        props={clipProperties}
                        clipLocalSec={Math.min(
                          Math.max(0, playheadSec - selectedClip.start),
                          selectedClip.duration,
                        )}
                        onChange={(next) => onSetClipProperties(selectedClip.id, next)}
                      />
                    ) : null}
                  </>
                ) : activeAsset ? (
                  <dl className="production-detail-list">
                    <div>
                      <dt>{t("drawer.detailAsset")}</dt>
                      <dd>{activeAsset.name}</dd>
                    </div>
                    <div>
                      <dt>{t("drawer.detailKind")}</dt>
                      <dd>{mediaAssetKindLabel(activeAsset.kind, t)}</dd>
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
            <div className="production-timeline production-timeline-track-card">
              <div
                className={`production-timeline-scroll${timelineTool === "hand" ? " hand-pan" : ""}`}
                ref={timelineScrollRef}
                onPointerDown={(e) => {
                  if (timelineTool !== "hand" || e.button !== 0) return;
                  const container = timelineScrollRef.current;
                  if (!container) return;
                  handPan.current = { pointerId: e.pointerId, startX: e.clientX, startLeft: container.scrollLeft };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  e.preventDefault();
                }}
                onPointerMove={(e) => {
                  const pan = handPan.current;
                  const container = timelineScrollRef.current;
                  if (!pan || pan.pointerId !== e.pointerId || !container) return;
                  container.scrollLeft = pan.startLeft - (e.clientX - pan.startX);
                }}
                onPointerUp={(e) => {
                  if (handPan.current?.pointerId === e.pointerId) handPan.current = null;
                }}
                onPointerCancel={(e) => {
                  if (handPan.current?.pointerId === e.pointerId) handPan.current = null;
                }}
              >
              <div
                className="production-timeline-scroll-inner"
                style={{ width: `${timelineZoom * 100}%` }}
              >
              <TimelineRuler
                fps={timelineFps}
                durationSec={timelineLen}
                playheadSec={playheadSec}
                onPlayheadSecChange={setPlayheadSec}
                snapPoints={snapPoints}
                markers={timeline.markers}
                onToggleMarker={onToggleMarkerAt ? () => onToggleMarkerAt(playheadSec) : undefined}
                onRemoveMarker={onRemoveMarker}
                zoom={timelineZoom}
                onZoomChange={setTimelineZoom}
              />
              <div className="production-timeline-playhead-overlay" aria-hidden="true">
                <span
                  className="production-timeline-playhead-line"
                  style={{ left: `${playheadRatio * 100}%` }}
                />
              </div>
              <div className="production-timeline-tracks" ref={tracksScrollRef}>
              {orderedTracks.map(({ track, laneNumber, groupBoundary }) => {
                const total = rulerDuration;
                const acceptsActive =
                  !!activeAsset &&
                  !track.locked &&
                  trackKindForClip(clipKindForAsset(activeAsset.kind)) === track.kind;
                return (
                    <div
                      key={track.id}
                      ref={(el) => {
                        if (el) trackRefs.current[track.id] = el;
                        else delete trackRefs.current[track.id];
                      }}
                      className={`production-track${groupBoundary ? " production-track-group-start" : ""}${navFlashTrackId === track.id ? " nav-flash" : ""}`}
                    >
                    <span className="production-track-head">
                      <span className={`production-track-label track-${track.kind}`}>
                        {trackKindLabel(track.kind) + laneNumber}
                      </span>
                      <span className="production-track-controls">
                        {onToggleTrackHidden ? (
                          <button
                            className={`production-track-toggle${track.hidden ? " active" : ""}`}
                            onClick={() => onToggleTrackHidden(track.id)}
                            title={t(track.hidden ? "drawer.showTrackTitle" : "drawer.hideTrackTitle")}
                          >
                            <TrackToggleIcon kind={track.hidden ? "hidden" : "visible"} />
                          </button>
                        ) : null}
                        {onToggleTrackLock ? (
                          <button
                            className={`production-track-toggle${track.locked ? " active" : ""}`}
                            onClick={() => onToggleTrackLock(track.id)}
                            title={t(track.locked ? "drawer.unlockTrackTitle" : "drawer.lockTrackTitle")}
                          >
                            <TrackToggleIcon kind={track.locked ? "locked" : "unlocked"} />
                          </button>
                        ) : null}
                          <button
                            onClick={() => onAddTrack(track.kind)}
                            title={t(
                              track.kind === "video"
                                ? "drawer.addVideoTrackTitle"
                                : track.kind === "audio"
                                  ? "drawer.addAudioTrackTitle"
                                  : "drawer.addImageTrackTitle",
                            )}
                          >
                            +
                          </button>
                        <button
                          onClick={() => onRemoveTrack(track.id)}
                          disabled={timeline.tracks.filter((t) => t.kind === track.kind).length <= 1}
                          title={t("drawer.removeTrackTitle")}
                        >
                          ×
                        </button>
                      </span>
                    </span>
                    <div
                      className={`production-track-lane${dragAssetId && acceptsActive ? " drop-ready" : ""}${track.locked ? " track-locked" : ""}${track.hidden ? " track-hidden" : ""}`}
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
                          const preview = razorPreview?.clipId === clip.id ? razorPreview : null;
                          const keyframeEps = 0.5 / timelineFps;
                          const keyframes =
                            selected && clipProperties
                              ? timelineKeyframeGroups(clipProperties, keyframeEps).filter(
                                  (group) => group.t >= 0 && group.t <= clip.duration,
                                )
                              : [];
                          return (
                            <div
                            key={clip.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={selected}
                            className={`production-clip clip-${clip.kind}${selected ? " active" : ""}${timelineTool === "razor" ? " razor-ready" : ""}`}
                            style={{
                              left: `${(clip.start / total) * 100}%`,
                              width: `${(clip.duration / total) * 100}%`,
                            }}
                            onClick={(e) => {
                              if (track.locked) return;
                              if (timelineTool === "razor") {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                                const clampedRatio = Math.min(1, Math.max(0, ratio));
                                const offset = clip.duration * clampedRatio;
                                if (offset >= MIN_CLIP_SECONDS && clip.duration - offset >= MIN_CLIP_SECONDS) {
                                  onSplitClipAt(clip.id, clip.start + offset);
                                }
                                return;
                              }
                              onSelectClip(selected ? null : clip.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              if (track.locked || timelineTool !== "select") return;
                              e.preventDefault();
                              onSelectClip(selected ? null : clip.id);
                            }}
                            onMouseMove={(e) => {
                              if (timelineTool !== "razor") return;
                              const rect = e.currentTarget.getBoundingClientRect();
                              const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                              const clampedRatio = Math.min(1, Math.max(0, ratio));
                              const offset = clip.duration * clampedRatio;
                              setRazorPreview({
                                clipId: clip.id,
                                ratio: clampedRatio,
                                valid: offset >= MIN_CLIP_SECONDS && clip.duration - offset >= MIN_CLIP_SECONDS,
                              });
                            }}
                            onMouseLeave={() => {
                              if (timelineTool === "razor") setRazorPreview(null);
                            }}
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
                            {preview ? (
                              <span
                                className={`production-clip-razor-preview${preview.valid ? "" : " invalid"}`}
                                style={{ left: `${preview.ratio * 100}%` }}
                              />
                            ) : null}
                            <span className="production-clip-name">{clipAssetName(clip.id)}</span>
                            {keyframes.map((group, groupIndex) => (
                              <button
                                key={groupIndex}
                                type="button"
                                className="production-clip-keyframe"
                                style={{ left: `${(group.t / clip.duration) * 100}%` }}
                                aria-label={t("drawer.timelineKeyframeTitle", {
                                  t: group.t.toFixed(2),
                                  n: group.count,
                                })}
                                title={t("drawer.timelineKeyframeTitle", {
                                  t: group.t.toFixed(2),
                                  n: group.count,
                                })}
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  if (!clipProperties || !onSetClipProperties || track.locked) return;
                                  onSetClipProperties(
                                    clip.id,
                                    removeKeyframesAtTime(clipProperties, group.t, keyframeEps),
                                  );
                                }}
                                onKeyDown={(e) => {
                                  if (
                                    (e.key !== "Delete" && e.key !== "Backspace") ||
                                    !clipProperties ||
                                    !onSetClipProperties ||
                                    track.locked
                                  ) {
                                    return;
                                  }
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onSetClipProperties(
                                    clip.id,
                                    removeKeyframesAtTime(clipProperties, group.t, keyframeEps),
                                  );
                                }}
                                onPointerDown={(e) => {
                                  if (
                                    e.button > 0 ||
                                    timelineTool !== "select" ||
                                    !clipProperties ||
                                    !onSetClipProperties ||
                                    track.locked
                                  ) {
                                    return;
                                  }
                                  const clipRect = e.currentTarget.parentElement?.getBoundingClientRect();
                                  if (!clipRect || clipRect.width <= 0) return;
                                  keyframeDrag.current = {
                                    pointerId: e.pointerId,
                                    clipId: clip.id,
                                    fromT: group.t,
                                    clipStart: clip.start,
                                    clipDuration: clip.duration,
                                    clipLeft: clipRect.left,
                                    clipWidth: clipRect.width,
                                    props: clipProperties,
                                  };
                                  e.currentTarget.setPointerCapture?.(e.pointerId);
                                  e.stopPropagation();
                                  e.preventDefault();
                                }}
                                onPointerMove={(e) => {
                                  const drag = keyframeDrag.current;
                                  if (
                                    !drag ||
                                    drag.pointerId !== e.pointerId ||
                                    drag.clipId !== clip.id ||
                                    !onSetClipProperties
                                  ) {
                                    return;
                                  }
                                  let localTime = Math.min(
                                    drag.clipDuration,
                                    Math.max(
                                      0,
                                      ((e.clientX - drag.clipLeft) / drag.clipWidth) *
                                        drag.clipDuration,
                                    ),
                                  );
                                  if (e.shiftKey) {
                                    const absoluteCandidates = [
                                      ...snapPoints,
                                      ...keyframes
                                        .filter((candidate) => candidate.t !== drag.fromT)
                                        .map((candidate) => drag.clipStart + candidate.t),
                                    ];
                                    const toleranceSec =
                                      (8 / drag.clipWidth) * drag.clipDuration;
                                    localTime =
                                      snapTimeToPoints(
                                        drag.clipStart + localTime,
                                        absoluteCandidates,
                                        toleranceSec,
                                      ) - drag.clipStart;
                                    localTime = Math.min(
                                      drag.clipDuration,
                                      Math.max(0, localTime),
                                    );
                                  }
                                  onSetClipProperties(
                                    clip.id,
                                    moveKeyframesAtTime(
                                      drag.props,
                                      drag.fromT,
                                      localTime,
                                      keyframeEps,
                                    ),
                                  );
                                }}
                                onPointerUp={(e) => {
                                  if (keyframeDrag.current?.pointerId === e.pointerId) {
                                    keyframeDrag.current = null;
                                  }
                                  e.stopPropagation();
                                }}
                                onPointerCancel={(e) => {
                                  if (keyframeDrag.current?.pointerId === e.pointerId) {
                                    keyframeDrag.current = null;
                                  }
                                }}
                              />
                            ))}
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
                            </div>
                          );
                        })}
                    </div>
                  </div>
                );
                })}
              </div>
              </div>
              </div>
              <div className="production-track-nav" aria-label="轨道定位">
                {orderedTracks.map(({ track, laneNumber }) => {
                  const label = `${track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "I"}${laneNumber}`;
                  return (
                    <button
                      key={`nav-${track.id}`}
                      type="button"
                      className={`production-track-nav-button nav-${track.kind}`}
                      onClick={() => scrollTrackIntoView(track.id)}
                      title={`${trackKindLabel(track.kind)}${laneNumber}`}
                    >
                      {label}
                    </button>
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
