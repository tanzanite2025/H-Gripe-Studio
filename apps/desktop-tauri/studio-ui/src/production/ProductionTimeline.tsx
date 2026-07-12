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
  replaceTimelineClipSelection,
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
import { clipIdsIntersectingMarqueeSelection } from "./timelineMarqueeSelection";
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

/** Marquee drags shorter than this (either axis) are treated as plain
 * background clicks and do not change the selection. */
const MARQUEE_MIN_DRAG_PX = 4;

interface ActiveMarqueeDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
}

/** Marquee overlay rectangle in `.production-timeline-tracks` local pixels. */
interface MarqueeOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
  const marqueeDrag = useRef<ActiveMarqueeDrag | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeOverlayRect | null>(null);
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

  const marqueeOverlayRectFromClientPoints = (
    container: HTMLElement,
    drag: ActiveMarqueeDrag,
    clientX: number,
    clientY: number,
  ): MarqueeOverlayRect => {
    const rect = container.getBoundingClientRect();
    const x1 = drag.startClientX - rect.left + container.scrollLeft;
    const y1 = drag.startClientY - rect.top + container.scrollTop;
    const x2 = clientX - rect.left + container.scrollLeft;
    const y2 = clientY - rect.top + container.scrollTop;
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  const commitMarqueeSelection = (drag: ActiveMarqueeDrag, clientX: number, clientY: number) => {
    const minClientX = Math.min(drag.startClientX, clientX);
    const maxClientX = Math.max(drag.startClientX, clientX);
    const minClientY = Math.min(drag.startClientY, clientY);
    const maxClientY = Math.max(drag.startClientY, clientY);
    const referenceLane = tracksScrollRef.current?.querySelector(".production-track-lane");
    const laneRect = referenceLane?.getBoundingClientRect();
    if (!laneRect || laneRect.width <= 0) return;
    const clientXToSec = (x: number) =>
      Math.min(1, Math.max(0, (x - laneRect.left) / laneRect.width)) * rulerDuration;
    const crossedTrackIds = Object.entries(trackRefs.current)
      .filter(([, element]) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.top <= maxClientY && rect.bottom >= minClientY;
      })
      .map(([trackId]) => trackId);
    replaceTimelineClipSelection(
      store,
      clipIdsIntersectingMarqueeSelection(timeline, crossedTrackIds, {
        startSec: clientXToSec(minClientX),
        endSec: clientXToSec(maxClientX),
      }),
    );
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
                playbackInPointSec={timeline.playbackRange?.inPointSec ?? null}
                playbackOutPointSec={timeline.playbackRange?.outPointSec ?? null}
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
              <div
                className="production-timeline-tracks"
                ref={tracksScrollRef}
                onPointerDown={(event) => {
                  if (timelineTool !== "select" || event.button !== 0) return;
                  const target = event.target as HTMLElement;
                  if (target.closest(".production-clip, .production-track-head, button")) return;
                  marqueeDrag.current = {
                    pointerId: event.pointerId,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = marqueeDrag.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  setMarqueeRect(
                    marqueeOverlayRectFromClientPoints(
                      event.currentTarget,
                      drag,
                      event.clientX,
                      event.clientY,
                    ),
                  );
                }}
                onPointerUp={(event) => {
                  const drag = marqueeDrag.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  marqueeDrag.current = null;
                  setMarqueeRect(null);
                  if (
                    Math.abs(event.clientX - drag.startClientX) < MARQUEE_MIN_DRAG_PX &&
                    Math.abs(event.clientY - drag.startClientY) < MARQUEE_MIN_DRAG_PX
                  ) {
                    return;
                  }
                  commitMarqueeSelection(drag, event.clientX, event.clientY);
                }}
                onPointerCancel={(event) => {
                  if (marqueeDrag.current?.pointerId === event.pointerId) {
                    marqueeDrag.current = null;
                    setMarqueeRect(null);
                  }
                }}
              >
                {marqueeRect ? (
                  <span
                    className="production-timeline-marquee"
                    style={{
                      left: `${marqueeRect.left}px`,
                      top: `${marqueeRect.top}px`,
                      width: `${marqueeRect.width}px`,
                      height: `${marqueeRect.height}px`,
                    }}
                    aria-hidden="true"
                  />
                ) : null}
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
