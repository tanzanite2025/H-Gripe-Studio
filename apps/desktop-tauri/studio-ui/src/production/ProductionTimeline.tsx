import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import type { TimelineTool } from "./DrawerToolbar";
import {
  moveKeyframesAtTime,
  removeKeyframesAtTime,
  timelineKeyframeGroups,
} from "./keyframes";
import type { ClipProperties } from "./clipProps";
import type { MediaAsset } from "./mediaBin";
import { TimelineRuler, timelineRulerDuration } from "./TimelineRuler";
import {
  clipKindForAsset,
  DEFAULT_TIMELINE_FPS,
  MIN_CLIP_SECONDS,
  snapTimeToPoints,
  timelineDuration,
  timelineSnapPoints,
  trackKindForClip,
  type ClipKind,
  type TimelineModel,
  type TrackKind,
} from "./timeline";

interface ProductionTimelineProps {
  timeline: TimelineModel;
  assets: MediaAsset[];
  activeAsset: MediaAsset | null;
  selectedClipId: string | null;
  clipProperties?: ClipProperties;
  timelineTool: TimelineTool;
  dragAssetId: string | null;
  playheadSec: number;
  onPlayheadSecChange: (sec: number) => void;
  onDragAssetChange: (assetId: string | null) => void;
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
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
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
  timeline,
  assets,
  activeAsset,
  selectedClipId,
  clipProperties,
  timelineTool,
  dragAssetId,
  playheadSec,
  onPlayheadSecChange,
  onDragAssetChange,
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
  onSetClipProperties,
  onOpenImageEdit,
  onOpenAudioEdit,
  onOpenClipGrade,
  onSplitClipToLayers,
}: ProductionTimelineProps) {
  const t = useT();
  const [clipMenu, setClipMenu] = useState<{
    x: number;
    y: number;
    clipId: string;
    assetId: string;
    kind: ClipKind;
  } | null>(null);
  const [razorPreview, setRazorPreview] = useState<{
    clipId: string;
    ratio: number;
    valid: boolean;
  } | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
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

  useEffect(() => {
    if (timelineTool !== "razor") setRazorPreview(null);
  }, [timelineTool]);

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
                />
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
                          onAddActiveToTrack(track.id);
                          onDragAssetChange(null);
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
                                left: `${(clip.start / rulerDuration) * 100}%`,
                                width: `${(clip.duration / rulerDuration) * 100}%`,
                              }}
                              onClick={(event) => {
                                if (track.locked) return;
                                if (timelineTool === "razor") {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
                                  const clampedRatio = Math.min(1, Math.max(0, ratio));
                                  const offset = clip.duration * clampedRatio;
                                  if (
                                    offset >= MIN_CLIP_SECONDS &&
                                    clip.duration - offset >= MIN_CLIP_SECONDS
                                  ) {
                                    onSplitClipAt(clip.id, clip.start + offset);
                                  }
                                  return;
                                }
                                onSelectClip(selected ? null : clip.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                if (track.locked || timelineTool !== "select") return;
                                event.preventDefault();
                                onSelectClip(selected ? null : clip.id);
                              }}
                              onMouseMove={(event) => {
                                if (timelineTool !== "razor") return;
                                const rect = event.currentTarget.getBoundingClientRect();
                                const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
                                const clampedRatio = Math.min(1, Math.max(0, ratio));
                                const offset = clip.duration * clampedRatio;
                                setRazorPreview({
                                  clipId: clip.id,
                                  ratio: clampedRatio,
                                  valid:
                                    offset >= MIN_CLIP_SECONDS &&
                                    clip.duration - offset >= MIN_CLIP_SECONDS,
                                });
                              }}
                              onMouseLeave={() => {
                                if (timelineTool === "razor") setRazorPreview(null);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                onSelectClip(clip.id);
                                setClipMenu({
                                  x: event.clientX,
                                  y: event.clientY,
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
                                  onClick={(event) => event.stopPropagation()}
                                  onDoubleClick={(event) => {
                                    event.stopPropagation();
                                    if (!clipProperties || !onSetClipProperties || track.locked) return;
                                    onSetClipProperties(
                                      clip.id,
                                      removeKeyframesAtTime(clipProperties, group.t, keyframeEps),
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (
                                      (event.key !== "Delete" && event.key !== "Backspace") ||
                                      !clipProperties ||
                                      !onSetClipProperties ||
                                      track.locked
                                    ) {
                                      return;
                                    }
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onSetClipProperties(
                                      clip.id,
                                      removeKeyframesAtTime(clipProperties, group.t, keyframeEps),
                                    );
                                  }}
                                  onPointerDown={(event) => {
                                    if (
                                      event.button > 0 ||
                                      timelineTool !== "select" ||
                                      !clipProperties ||
                                      !onSetClipProperties ||
                                      track.locked
                                    ) {
                                      return;
                                    }
                                    const clipRect = event.currentTarget.parentElement?.getBoundingClientRect();
                                    if (!clipRect || clipRect.width <= 0) return;
                                    keyframeDrag.current = {
                                      pointerId: event.pointerId,
                                      clipId: clip.id,
                                      fromT: group.t,
                                      clipStart: clip.start,
                                      clipDuration: clip.duration,
                                      clipLeft: clipRect.left,
                                      clipWidth: clipRect.width,
                                      props: clipProperties,
                                    };
                                    event.currentTarget.setPointerCapture?.(event.pointerId);
                                    event.stopPropagation();
                                    event.preventDefault();
                                  }}
                                  onPointerMove={(event) => {
                                    const drag = keyframeDrag.current;
                                    if (
                                      !drag ||
                                      drag.pointerId !== event.pointerId ||
                                      drag.clipId !== clip.id ||
                                      !onSetClipProperties
                                    ) {
                                      return;
                                    }
                                    let localTime = Math.min(
                                      drag.clipDuration,
                                      Math.max(
                                        0,
                                        ((event.clientX - drag.clipLeft) / drag.clipWidth) *
                                          drag.clipDuration,
                                      ),
                                    );
                                    if (event.shiftKey) {
                                      const absoluteCandidates = [
                                        ...snapPoints,
                                        ...keyframes
                                          .filter((candidate) => candidate.t !== drag.fromT)
                                          .map((candidate) => drag.clipStart + candidate.t),
                                      ];
                                      const toleranceSec = (8 / drag.clipWidth) * drag.clipDuration;
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
                                  onPointerUp={(event) => {
                                    if (keyframeDrag.current?.pointerId === event.pointerId) {
                                      keyframeDrag.current = null;
                                    }
                                    event.stopPropagation();
                                  }}
                                  onPointerCancel={(event) => {
                                    if (keyframeDrag.current?.pointerId === event.pointerId) {
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
                                  onClick={(event) => {
                                    event.stopPropagation();
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
      {clipMenu ? (
        <div
          className="production-clip-menu-backdrop"
          onClick={() => setClipMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setClipMenu(null);
          }}
        >
          <div
            className="production-clip-menu"
            style={{ left: clipMenu.x, top: clipMenu.y }}
            onClick={(event) => event.stopPropagation()}
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
    </>
  );
}
