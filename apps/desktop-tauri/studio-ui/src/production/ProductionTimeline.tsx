import { useRef, useState } from "react";

import { useT } from "../i18n";
import type { TimelineTool } from "./DrawerToolbar";
import { defaultClipProperties, type ClipProperties } from "./clipProps";
import {
  addAssetClip,
  addTimelineTrack,
  moveTimelineClip,
  removeTimelineClip,
  removeTimelineMarker,
  removeTimelineTrack,
  selectClip,
  setClipProperties,
  splitTimelineClip,
  toggleClipInSelection,
  toggleTimelineMarker,
  toggleTimelineTrackHidden,
  toggleTimelineTrackLock,
  trimTimelineClipEdge,
} from "./productionStore";
import {
  useProductionStateFromContext,
  useProductionStoreFromContext,
} from "./productionStoreContext";
import {
  TimelineClipContextMenu,
  type TimelineClipMenuState,
} from "./TimelineClipContextMenu";
import { TimelineClipView } from "./TimelineClipView";
import { TimelineRuler, timelineRulerDuration } from "./TimelineRuler";
import {
  clipKindForAsset,
  DEFAULT_TIMELINE_FPS,
  snapTimeToFrame,
  timelineDuration,
  timelineSnapPoints,
  trackKindForClip,
  type ClipTrimEdge,
  type TrackKind,
} from "./timeline";

/** Timeline UI: reads/dispatches timeline state on the production store from
 * context; only drawer-local UI state (tool, drag, playhead) and the editor
 * launchers cross the props boundary. */
interface ProductionTimelineProps {
  timelineTool: TimelineTool;
  dragAssetId: string | null;
  playheadSec: number;
  onPlayheadSecChange: (sec: number) => void;
  onDragAssetChange: (assetId: string | null) => void;
  onOpenImageEdit: (assetId: string) => void;
  onOpenAudioEdit: (clipId: string) => void;
  onOpenClipGrade: (clipId: string) => void;
  onSplitClipToLayers: (clipId: string) => void;
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

export function ProductionTimeline({
  timelineTool,
  dragAssetId,
  playheadSec,
  onPlayheadSecChange,
  onDragAssetChange,
  onOpenImageEdit,
  onOpenAudioEdit,
  onOpenClipGrade,
  onSplitClipToLayers,
}: ProductionTimelineProps) {
  const t = useT();
  const store = useProductionStoreFromContext();
  const timeline = useProductionStateFromContext((state) => state.timeline);
  const assets = useProductionStateFromContext((state) => state.binAssets);
  const activeAssetId = useProductionStateFromContext((state) => state.activeAssetId);
  const selectedClipId = useProductionStateFromContext((state) => state.selectedClipId);
  const selectedClipIds = useProductionStateFromContext((state) => state.selectedClipIds);
  const clipProps = useProductionStateFromContext((state) => state.clipProps);
  const activeAsset = assets.find((asset) => asset.id === activeAssetId) ?? null;
  const clipProperties: ClipProperties | undefined = selectedClipId
    ? (clipProps[selectedClipId] ?? defaultClipProperties())
    : undefined;

  const onSelectClip = (clipId: string | null) => selectClip(store, clipId);
  const onToggleSelectClip = (clipId: string) => toggleClipInSelection(store, clipId);
  const onAddActiveToTrack = (trackId: string, atSec?: number) => {
    const assetId = store.getState().activeAssetId;
    if (assetId) addAssetClip(store, assetId, { trackId, atSec });
  };
  const onAddTrack = (kind: TrackKind) => addTimelineTrack(store, kind);
  const onRemoveTrack = (trackId: string) => removeTimelineTrack(store, trackId);
  const onRemoveClip = (clipId: string) => removeTimelineClip(store, clipId);
  const onSplitClipAt = (clipId: string, atSec: number) => splitTimelineClip(store, clipId, atSec);
  const onMoveClipTo = (clipId: string, toStartSec: number) =>
    moveTimelineClip(store, clipId, toStartSec);
  const onTrimClipEdge = (clipId: string, edge: ClipTrimEdge, toSec: number) =>
    trimTimelineClipEdge(store, clipId, edge, toSec);
  const onToggleMarkerAt = (sec: number) => toggleTimelineMarker(store, sec);
  const onRemoveMarker = (markerId: string) => removeTimelineMarker(store, markerId);
  const onToggleTrackLock = (trackId: string) => toggleTimelineTrackLock(store, trackId);
  const onToggleTrackHidden = (trackId: string) => toggleTimelineTrackHidden(store, trackId);
  const onSetClipProperties = (clipId: string, props: ClipProperties) =>
    setClipProperties(store, clipId, props);
  const [clipMenu, setClipMenu] = useState<TimelineClipMenuState | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const trackRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const handPan = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const navFlashTimer = useRef<number | null>(null);
  const [navFlashTrackId, setNavFlashTrackId] = useState<string | null>(null);

  const timelineFps = timeline.fps ?? DEFAULT_TIMELINE_FPS;
  const timelineLen = timelineDuration(timeline);
  const rulerDuration = timelineRulerDuration(timelineLen, playheadSec);
  const snapPoints = timelineSnapPoints(timeline);
  const playheadRatio = Math.min(1, Math.max(0, playheadSec / rulerDuration));
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

  const laneDropSec = (lane: HTMLElement, clientX: number): number => {
    const rect = lane.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return snapTimeToFrame(Math.min(1, Math.max(0, ratio)) * rulerDuration, timelineFps);
  };

  const trackKindLabel = (kind: TrackKind): string =>
    t(kind === "video" ? "drawer.trackVideo" : kind === "audio" ? "drawer.trackAudio" : "drawer.trackImage");

  const clipAssetName = (clipId: string): string => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip) return assets.find((asset) => asset.id === clip.assetId)?.name ?? clip.assetId;
    }
    return clipId;
  };

  const scrollTrackIntoView = (trackId: string) => {
    const element = trackRefs.current[trackId];
    const container = tracksScrollRef.current;
    if (element && container) {
      const top =
        element.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        (container.clientHeight - element.clientHeight) / 2;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    setNavFlashTrackId(trackId);
    if (navFlashTimer.current != null) window.clearTimeout(navFlashTimer.current);
    navFlashTimer.current = window.setTimeout(() => {
      setNavFlashTrackId(null);
      navFlashTimer.current = null;
    }, 1000);
  };

  return (
    <>
      <div className="production-timeline-shell">
        <div className="production-timeline production-timeline-track-card">
          <div
            className={`production-timeline-scroll${timelineTool === "hand" ? " hand-pan" : ""}`}
            ref={timelineScrollRef}
            onPointerDown={(event) => {
              if (timelineTool !== "hand" || event.button !== 0) return;
              const container = timelineScrollRef.current;
              if (!container) return;
              handPan.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startLeft: container.scrollLeft,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              const pan = handPan.current;
              const container = timelineScrollRef.current;
              if (!pan || pan.pointerId !== event.pointerId || !container) return;
              container.scrollLeft = pan.startLeft - (event.clientX - pan.startX);
            }}
            onPointerUp={(event) => {
              if (handPan.current?.pointerId === event.pointerId) handPan.current = null;
            }}
            onPointerCancel={(event) => {
              if (handPan.current?.pointerId === event.pointerId) handPan.current = null;
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
                onPlayheadSecChange={onPlayheadSecChange}
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
                >
                  <span className="production-timeline-playhead-head" />
                </span>
              </div>
              <div className="production-timeline-tracks" ref={tracksScrollRef}>
                {orderedTracks.map(({ track, laneNumber, groupBoundary }) => {
                  const acceptsActive =
                    !!activeAsset &&
                    !track.locked &&
                    trackKindForClip(clipKindForAsset(activeAsset.kind)) === track.kind;
                  return (
                    <div
                      key={track.id}
                      ref={(element) => {
                        if (element) trackRefs.current[track.id] = element;
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
                            disabled={timeline.tracks.filter((candidate) => candidate.kind === track.kind).length <= 1}
                            title={t("drawer.removeTrackTitle")}
                          >
                            ×
                          </button>
                        </span>
                      </span>
                      <div
                        className={`production-track-lane${dragAssetId && acceptsActive ? " drop-ready" : ""}${track.locked ? " track-locked" : ""}${track.hidden ? " track-hidden" : ""}`}
                        onDragOver={(event) => {
                          if (!acceptsActive) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                        }}
                        onDrop={(event) => {
                          if (!acceptsActive) return;
                          event.preventDefault();
                          onAddActiveToTrack(track.id, laneDropSec(event.currentTarget, event.clientX));
                          onDragAssetChange(null);
                        }}
                        onPointerUp={(event) => {
                          if (!dragAssetId || !acceptsActive) return;
                          onAddActiveToTrack(track.id, laneDropSec(event.currentTarget, event.clientX));
                          onDragAssetChange(null);
                        }}
                      >
                        {track.clips.map((clip) => (
                          <TimelineClipView
                            key={clip.id}
                            clip={clip}
                            clipDisplayName={clipAssetName(clip.id)}
                            selected={selectedClipIds.includes(clip.id)}
                            trackLocked={!!track.locked}
                            rulerDurationSec={rulerDuration}
                            timelineFps={timelineFps}
                            timelineTool={timelineTool}
                            snapPoints={snapPoints}
                            clipProperties={clip.id === selectedClipId ? clipProperties : undefined}
                            onSelectClip={onSelectClip}
                            onToggleSelectClip={onToggleSelectClip}
                            onSplitClipAt={onSplitClipAt}
                            onRemoveClip={onRemoveClip}
                            onMoveClipTo={onMoveClipTo}
                            onTrimClipEdge={onTrimClipEdge}
                            onSetClipProperties={onSetClipProperties}
                            onOpenContextMenu={setClipMenu}
                          />
                        ))}
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
      {clipMenu ? (
        <TimelineClipContextMenu
          menu={clipMenu}
          onClose={() => setClipMenu(null)}
          onRemoveClip={onRemoveClip}
          onOpenImageEdit={onOpenImageEdit}
          onOpenAudioEdit={onOpenAudioEdit}
          onOpenClipGrade={onOpenClipGrade}
          onSplitClipToLayers={onSplitClipToLayers}
        />
      ) : null}
    </>
  );
}
