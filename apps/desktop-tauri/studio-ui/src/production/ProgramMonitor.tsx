import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  registerTimeline,
  unregisterTimeline,
  type TimelineClipRef,
  type ViewportOverlayScene,
} from "../bridge/viewport";
import { useT } from "../i18n";
import { describeDeviceReport, deviceReportFromViewportBackend } from "../runtime/deviceReport";
import { useViewControls } from "../viewport/useViewControls";
import { useVideoPreview, type VideoPreviewTarget } from "../viewport/useVideoPreview";
import { useViewportPlacement } from "../viewport/useViewportPlacement";
import type { MediaAsset } from "./mediaBin";
import { paceToFrameGrid, resolvePreviewFrame } from "./previewFrame";
import { timelineDuration, type TimelineModel } from "./timeline";
import { useSourceFps } from "./useSourceFps";

/** Safe-area guides (WGPU plan item 3): action-safe 90% (solid) and
 * title-safe 80% (dashed) rectangles plus a centre cross, stroked host-side
 * over the presented frame at the view window's detail. Normalized document
 * coordinates, so zoom/pan needs no re-send; a stable reference, so the
 * preview skips no-op `set_overlay_scene` commands. */
const GUIDE_STROKE: [number, number, number, number] = [1, 1, 1, 0.65];
export const SAFE_AREA_SCENE: ViewportOverlayScene = {
  items: [
    {
      kind: "polygon",
      points: [
        [0.05, 0.05],
        [0.95, 0.05],
        [0.95, 0.95],
        [0.05, 0.95],
      ],
      stroke: GUIDE_STROKE,
    },
    {
      kind: "polygon",
      points: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
      stroke: GUIDE_STROKE,
      dash: true,
    },
    {
      kind: "polyline",
      points: [
        [0.48, 0.5],
        [0.52, 0.5],
      ],
      stroke: GUIDE_STROKE,
    },
    {
      kind: "polyline",
      points: [
        [0.5, 0.48],
        [0.5, 0.52],
      ],
      stroke: GUIDE_STROKE,
    },
  ],
};

function MonitorIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="production-monitor-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function MarkerIcon() {
  return (
    <MonitorIcon>
      <path d="M7 4h10v10l-5 4-5-4z" />
    </MonitorIcon>
  );
}

function MarkInIcon() {
  return (
    <MonitorIcon>
      <path d="M8 5v14" />
      <path d="M16 7 11 12l5 5" />
    </MonitorIcon>
  );
}

function MarkOutIcon() {
  return (
    <MonitorIcon>
      <path d="M16 5v14" />
      <path d="m8 7 5 5-5 5" />
    </MonitorIcon>
  );
}

function StepBackIcon() {
  return (
    <MonitorIcon>
      <path d="M8 6v12" />
      <path d="m17 7-7 5 7 5z" />
    </MonitorIcon>
  );
}

function StepForwardIcon() {
  return (
    <MonitorIcon>
      <path d="M16 6v12" />
      <path d="m7 7 7 5-7 5z" />
    </MonitorIcon>
  );
}

function RewindIcon() {
  return (
    <MonitorIcon>
      <path d="m11 7-7 5 7 5z" />
      <path d="m20 7-7 5 7 5z" />
    </MonitorIcon>
  );
}

function FastForwardIcon() {
  return (
    <MonitorIcon>
      <path d="m4 7 7 5-7 5z" />
      <path d="m13 7 7 5-7 5z" />
    </MonitorIcon>
  );
}

function PlayIcon() {
  return (
    <MonitorIcon>
      <path d="m8 5 11 7-11 7z" />
    </MonitorIcon>
  );
}

function PauseIcon() {
  return (
    <MonitorIcon>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </MonitorIcon>
  );
}

function SafeAreaIcon() {
  return (
    <MonitorIcon>
      <rect x="5" y="6" width="14" height="12" rx="1.5" />
      <rect x="8" y="8.5" width="8" height="7" rx="1" />
    </MonitorIcon>
  );
}

function clampTime(sec: number, duration: number) {
  return Math.max(0, Math.min(duration, sec));
}

function formatTimecode(sec: number, fps: number) {
  const safeFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(sec * safeFps));
  const frames = totalFrames % safeFps;
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * Register the first video track's clips with the viewport host so playhead
 * frames present as `video_clip` reference targets (resolved Rust-side).
 * Returns the timeline id once registration lands — a re-registration after
 * an edit replaces the host's clip set — or null while pending / after a
 * failure (the monitor falls back to webview-resolved media targets).
 */
function useRegisteredTimeline(timeline: TimelineModel, assets: MediaAsset[]): string | null {
  const [registered, setRegistered] = useState<string | null>(null);
  const clips = useMemo<TimelineClipRef[]>(() => {
    const track = timeline.tracks.find((t) => t.kind === "video");
    return (track?.clips ?? []).flatMap((clip) => {
      if (clip.kind === "audio") return [];
      const asset = assets.find((a) => a.id === clip.assetId);
      if (!asset) return [];
      return [
        {
          clipId: clip.id,
          kind: clip.kind,
          path: asset.path,
          startSec: clip.start,
          durationSec: clip.duration,
        },
      ];
    });
  }, [timeline, assets]);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const key = clips
    .map((c) => `${c.clipId}:${c.kind}:${c.path}:${c.startSec}:${c.durationSec}`)
    .join("|");
  useEffect(() => {
    setRegistered(null);
    let cancelled = false;
    registerTimeline(timeline.id, clipsRef.current)
      .then(() => {
        if (!cancelled) setRegistered(timeline.id);
      })
      .catch(() => {
        // Playhead frames fall back to webview-resolved media targets.
      });
    return () => {
      cancelled = true;
    };
  }, [timeline.id, key]);
  // The monitor is the timeline's presenter: when it closes (or the timeline
  // identity changes) the host-side clip set goes with it — the next mount
  // re-registers.
  useEffect(() => {
    const id = timeline.id;
    return () => {
      unregisterTimeline(id).catch(() => {});
    };
  }, [timeline.id]);
  return registered;
}

/**
 * Program monitor for the Timeline tab: shows the frame under the playhead
 * through a `video_preview` viewport (still clips render their image, video
 * clips decode the clip-local frame; gaps show black). The playhead is a
 * scrub slider; seek bursts are coalesced latest-wins on both sides of the
 * host boundary, so dragging never queues stale decodes.
 *
 * Playback advances the playhead wall-clock via requestAnimationFrame, but
 * frame requests are snapped onto the source's frame grid (`paceToFrameGrid`)
 * so presentation follows the source fps: ticks inside the same source frame
 * are no-ops, and the persistent hardware decode session sees strictly
 * sequential forward steps. Requests still go through the latest-wins queue,
 * so a decoder that cannot keep up drops frames instead of building a backlog.
 */
export function ProgramMonitor({
  timeline,
  assets,
  clipGradeDoc,
  playheadSec: controlledPlayheadSec,
  onPlayheadSecChange,
}: {
  timeline: TimelineModel;
  assets: MediaAsset[];
  /** The clip's stored grade doc (JSON string), applied to its frames. */
  clipGradeDoc?: (clipId: string) => string | null;
  playheadSec?: number;
  onPlayheadSecChange?: (sec: number) => void;
}) {
  const t = useT();
  const [localPlayheadSec, setLocalPlayheadSec] = useState(0);
  const playheadSec = controlledPlayheadSec ?? localPlayheadSec;
  const setPlayheadSec = onPlayheadSecChange ?? setLocalPlayheadSec;
  const [playing, setPlaying] = useState(false);
  const [safeArea, setSafeArea] = useState(false);
  const [, setMarkers] = useState<number[]>([]);
  const [inPointSec, setInPointSec] = useState<number | null>(null);
  const [outPointSec, setOutPointSec] = useState<number | null>(null);
  const playheadRef = useRef(0);
  playheadRef.current = playheadSec;
  const { state, showFrame, host } = useVideoPreview();
  // Monitor zoom/pan is viewport state: the viewport re-crops its cached
  // frame proxy, so a view tick never re-decodes the frame.
  const { view, stageProps } = useViewControls(!!state.frame || state.presented);
  // Keep the native surface window placed under the monitor's frame element
  // (WGPU surface swap): frames present there and skip the PNG transport.
  useViewportPlacement(host, stageProps.ref);

  const duration = Math.max(timelineDuration(timeline), 0);
  const clampedSec = Math.min(playheadSec, duration);
  // Playback pacing (GPU_DEVICE_STRATEGY_PLAN continuous-playback route):
  // while playing, snap the request time onto the source's frame grid so the
  // monitor asks for exactly one frame per source frame — consecutive
  // wall-clock ticks inside the same frame resolve to the same request and
  // skip, and the persistent hardware session sees strictly sequential
  // forward steps. A paused scrub keeps the exact position.
  const playheadTarget = useMemo(
    () => resolvePreviewFrame(timeline, assets, clampedSec),
    [timeline, assets, clampedSec],
  );
  const sourceFps = useSourceFps(playheadTarget?.kind === "video" ? playheadTarget.path : null);
  const displayFps = sourceFps && sourceFps > 0 ? sourceFps : 24;
  const frameStep = 1 / displayFps;
  const requestSec = playing ? paceToFrameGrid(playheadTarget, clampedSec, sourceFps) : clampedSec;
  const target = useMemo(
    () => resolvePreviewFrame(timeline, assets, requestSec),
    [timeline, assets, requestSec],
  );

  const registeredTimelineId = useRegisteredTimeline(timeline, assets);
  const gradeDoc = target ? (clipGradeDoc?.(target.clipId) ?? null) : null;
  useEffect(() => {
    if (!target) {
      showFrame(null);
      return;
    }
    const previewTarget: VideoPreviewTarget =
      registeredTimelineId === timeline.id
        ? {
            kind: "video_clip",
            timelineId: timeline.id,
            clipId: target.clipId,
            timeSec: requestSec,
          }
        : target;
    showFrame({
      target: previewTarget,
      gradeDoc,
      view,
      overlayScene: safeArea ? SAFE_AREA_SCENE : null,
    });
  }, [target, registeredTimelineId, timeline.id, requestSec, gradeDoc, view, safeArea, showFrame]);

  useEffect(() => {
    if (!playing || duration <= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = playheadRef.current + (now - last) / 1000;
      last = now;
      if (next >= duration) {
        setPlayheadSec(duration);
        setPlaying(false);
        return;
      }
      setPlayheadSec(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  // Normalized device transparency for the backend badge (shared vocabulary).
  const backendReport = useMemo(
    () => (state.backend ? deviceReportFromViewportBackend(state.backend) : null),
    [state.backend],
  );

  const togglePlay = () => {
    if (duration <= 0) return;
    // Play from the start when the playhead sits at the end.
    if (!playing && playheadRef.current >= duration) setPlayheadSec(0);
    setPlaying((p) => !p);
  };
  const seekTo = (sec: number) => {
    setPlaying(false);
    setPlayheadSec(clampTime(sec, duration));
  };
  const addMarker = () => {
    if (duration <= 0) return;
    const next = Number(clampedSec.toFixed(3));
    setMarkers((prev) => {
      const deduped = prev.filter((sec) => Math.abs(sec - next) > frameStep / 2);
      return [...deduped, next].sort((a, b) => a - b).slice(-24);
    });
  };
  const setInPoint = () => {
    if (duration <= 0) return;
    setInPointSec(clampedSec);
    if (outPointSec != null && outPointSec < clampedSec) setOutPointSec(null);
  };
  const setOutPoint = () => {
    if (duration <= 0) return;
    setOutPointSec(clampedSec);
    if (inPointSec != null && inPointSec > clampedSec) setInPointSec(null);
  };

  return (
    <div className="production-monitor">
      <div className="production-monitor-stage">
        <div className="production-monitor-controls" aria-label="program monitor controls">
          <button type="button" className="production-monitor-control" onClick={addMarker} disabled={duration <= 0} title="添加标记">
            <MarkerIcon />
          </button>
          <button
            type="button"
            className={`production-monitor-control${inPointSec != null ? " active" : ""}`}
            onClick={setInPoint}
            disabled={duration <= 0}
            title="添加入点"
          >
            <MarkInIcon />
          </button>
          <button
            type="button"
            className={`production-monitor-control${outPointSec != null ? " active" : ""}`}
            onClick={setOutPoint}
            disabled={duration <= 0}
            title="添加出点"
          >
            <MarkOutIcon />
          </button>
          <span className="production-monitor-control-separator" />
          <button type="button" className="production-monitor-control" onClick={() => seekTo(clampedSec - 1)} disabled={duration <= 0} title="快退 1 秒">
            <RewindIcon />
          </button>
          <button type="button" className="production-monitor-control" onClick={() => seekTo(clampedSec - frameStep)} disabled={duration <= 0} title="后退一帧">
            <StepBackIcon />
          </button>
          <button
            type="button"
            className={`production-monitor-control production-monitor-control-play${playing ? " active" : ""}`}
            onClick={togglePlay}
            title={t(playing ? "drawer.monitorPause" : "drawer.monitorPlay")}
            aria-pressed={playing}
            disabled={duration <= 0}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="production-monitor-control" onClick={() => seekTo(clampedSec + frameStep)} disabled={duration <= 0} title="前进一帧">
            <StepForwardIcon />
          </button>
          <button type="button" className="production-monitor-control" onClick={() => seekTo(clampedSec + 1)} disabled={duration <= 0} title="快进 1 秒">
            <FastForwardIcon />
          </button>
          <span className="production-monitor-control-separator" />
          <button
            type="button"
            className={`production-monitor-control production-monitor-safe-area${safeArea ? " active" : ""}`}
            onClick={() => setSafeArea((on) => !on)}
            title={t("drawer.monitorSafeAreaTitle")}
            aria-pressed={safeArea}
          >
            <SafeAreaIcon />
          </button>
        </div>
        <div className="production-monitor-main">
        <div
          className={`production-monitor-frame${state.presented ? " presented" : ""}`}
          {...stageProps}
        >
          {state.presented && target ? null : state.frame && target ? (
            <img src={state.frame} alt={t("drawer.monitorTitle")} />
          ) : (
            <span className="production-monitor-empty muted">
              {state.error ?? (target && state.pending ? "…" : t("drawer.monitorEmpty"))}
            </span>
          )}
          {backendReport ? (
            <span className="production-monitor-backend" title={describeDeviceReport(backendReport)}>
              {backendReport.used}
              {backendReport.fallbackReason ? " ⚠" : null}
              {view.zoom > 1 ? <> · {Math.round(view.zoom * 100)}%</> : null}
            </span>
          ) : null}
        </div>
        <div className="production-monitor-scrub">
          <span className="production-monitor-time production-monitor-time-start">
            {formatTimecode(clampedSec, displayFps)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.001)}
            step={0.05}
            value={clampedSec}
            onChange={(e) => {
              setPlaying(false);
              setPlayheadSec(Number(e.target.value));
            }}
            title={t("drawer.monitorScrubTitle")}
            disabled={duration <= 0}
          />
          <span className="production-monitor-time production-monitor-time-end">
            {formatTimecode(duration, displayFps)}
          </span>
        </div>
        </div>
      </div>
    </div>
  );
}
