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
  onAddActiveToTimeline,
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
        <div className="production-edit-workspace">
          <div className="production-edit-top">
          <div className="production-bin">
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
            </div>
            {assets.length === 0 ? (
              <p className="production-bin-empty">{t("drawer.binEmpty")}</p>
            ) : (
              <ul className="production-bin-list">
                {assets.map((a) => (
                  <li key={a.id} className={a.id === activeAssetId ? "active" : ""}>
                    <button
                      className="production-bin-item"
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
          </div>

          <div className="production-program-column">
            <ProgramMonitor timeline={timeline} assets={assets} clipGradeDoc={clipGradeDoc} />
          </div>

          <aside className="production-detail-panel">
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

          <div className="production-timeline">
            <div className="production-timeline-head">
              <h3>{t("drawer.timelineTitle")}</h3>
              <span className="production-timeline-duration">
                {t("drawer.timelineDuration", { s: timelineDuration(timeline).toFixed(1) })}
              </span>
              <div className="spacer" />
              <button
                onClick={onAddActiveToTimeline}
                disabled={!activeAssetId}
                title={t("drawer.addToTimelineTitle")}
              >
                {t("drawer.addToTimeline")}
              </button>
              <button onClick={() => onAddTrack("video")} title={t("drawer.addVideoTrackTitle")}>
                {t("drawer.addVideoTrack")}
              </button>
              <button onClick={() => onAddTrack("audio")} title={t("drawer.addAudioTrackTitle")}>
                {t("drawer.addAudioTrack")}
              </button>
              <button
                onClick={onOpenExport}
                disabled={timeline.tracks.every((track) => track.clips.length === 0)}
                title={t("drawer.exportTitle")}
              >
                {t("drawer.export")}
              </button>
            </div>
            {timeline.tracks.every((track) => track.clips.length === 0) ? (
              <p className="production-timeline-empty">{t("drawer.timelineEmpty")}</p>
            ) : null}
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
                          onClick={() => onAddActiveToTrack(track.id)}
                          disabled={!acceptsActive}
                          title={t("drawer.addToTrackTitle")}
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
                    <div className="production-track-lane">
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
