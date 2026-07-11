import {
  DEFAULT_TIMELINE_FPS,
  frameToSeconds,
  secondsToFrame,
  snapTimeToFrame,
  snapTimeToPoints,
  type TimelineMarker,
} from "./timeline";

export function formatTimelineTimecode(sec: number, fps: number): string {
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

export function timelineRulerDuration(durationSec: number, playheadSec: number): number {
  return Math.max(8, Math.ceil(Math.max(durationSec, playheadSec)));
}

/** Snap capture radius around clip edges / markers, in ruler pixels. */
export const RULER_SNAP_THRESHOLD_PX = 8;

/** Ruler major-tick spacing in seconds, chosen by visible duration. */
export function majorTickStepSeconds(rulerDurationSec: number): number {
  return rulerDurationSec > 60 ? 10 : rulerDurationSec > 20 ? 5 : 1;
}

/**
 * Ruler minor-tick spacing in whole frames. Minor ticks live on the frame
 * grid — the same grid wheel / arrow-key playhead steps move on — so a tick
 * is always an exact number of steps away. A plain `majorStepSec / 10`
 * spacing (e.g. 0.1s at 24fps = 2.4 frames) would drift off the grid and
 * ticks would land between playhead stops.
 */
export function minorTickStepFrames(majorStepSec: number, fps: number): number {
  return Math.max(1, Math.round((majorStepSec * fps) / 10));
}

export function rulerClientXToTime(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
  durationSec: number,
  fps: number,
  snap?: { points: number[]; thresholdPx?: number },
): number {
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const raw = Math.min(1, Math.max(0, ratio)) * durationSec;
  if (snap && rect.width > 0) {
    const toleranceSec = ((snap.thresholdPx ?? RULER_SNAP_THRESHOLD_PX) / rect.width) * durationSec;
    const snapped = snapTimeToPoints(raw, snap.points, toleranceSec);
    if (snapped !== raw) return snapped;
  }
  return snapTimeToFrame(raw, fps);
}

/** Frames stepped per arrow key press; Shift multiplies (Premiere-style). */
export const KEY_STEP_FRAMES = 1;
export const KEY_STEP_FRAMES_SHIFT = 5;

/** Playhead time after a navigation key, or null when the key is not one.
 * Arrows step by frames (Shift = 5), Home / End jump to start / end. */
export function playheadTimeForKey(
  key: string,
  shiftKey: boolean,
  playheadSec: number,
  durationSec: number,
  fps: number,
): number | null {
  if (key === "Home") return 0;
  if (key === "End") return snapTimeToFrame(durationSec, fps);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = (shiftKey ? KEY_STEP_FRAMES_SHIFT : KEY_STEP_FRAMES) * (key === "ArrowLeft" ? -1 : 1);
  const frame = Math.max(0, secondsToFrame(playheadSec, fps) + step);
  return frameToSeconds(frame, fps);
}

/** Timeline zoom bounds and step: 1 = fit the whole ruler, each step ×1.5. */
export const TIMELINE_ZOOM_MIN = 1;
export const TIMELINE_ZOOM_MAX = 8;
export const TIMELINE_ZOOM_STEP = 1.5;

/** Next zoom level: direction > 0 zooms in, < 0 zooms out, clamped. */
export function timelineZoomStep(zoom: number, direction: number): number {
  const next = direction > 0 ? zoom * TIMELINE_ZOOM_STEP : direction < 0 ? zoom / TIMELINE_ZOOM_STEP : zoom;
  return Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, next));
}

/** Playhead time after a wheel notch: down / right advances one frame
 * (Shift = 5), up / left steps back. */
export function playheadTimeForWheel(
  delta: number,
  shiftKey: boolean,
  playheadSec: number,
  fps: number,
): number {
  const direction = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const step = (shiftKey ? KEY_STEP_FRAMES_SHIFT : KEY_STEP_FRAMES) * direction;
  const frame = Math.max(0, secondsToFrame(playheadSec, fps) + step);
  return frameToSeconds(frame, fps);
}

export interface TimelineRulerProps {
  fps?: number;
  durationSec: number;
  playheadSec: number;
  onPlayheadSecChange: (sec: number) => void;
  /** Shift-drag snap targets (clip edges, markers), in seconds. */
  snapPoints?: number[];
  /** Sequence markers rendered on the ruler. */
  markers?: TimelineMarker[];
  /** M key: add / clear a marker at the playhead. */
  onToggleMarker?: () => void;
  /** Right-click a marker to remove it. */
  onRemoveMarker?: (markerId: string) => void;
  /** Horizontal zoom factor (1 = fit). Enables Ctrl+wheel and =/-/\ keys. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}

export function TimelineRuler({
  fps = DEFAULT_TIMELINE_FPS,
  durationSec,
  playheadSec,
  onPlayheadSecChange,
  snapPoints,
  markers,
  onToggleMarker,
  onRemoveMarker,
  zoom,
  onZoomChange,
}: TimelineRulerProps) {
  const timelineFps = fps || DEFAULT_TIMELINE_FPS;
  const rulerDuration = timelineRulerDuration(durationSec, playheadSec);
  const majorStepSec = majorTickStepSeconds(rulerDuration);
  const minorStepFrames = minorTickStepFrames(majorStepSec, timelineFps);
  const majorTicks = Array.from({ length: Math.floor(rulerDuration / majorStepSec) + 1 }, (_, i) => i * majorStepSec);
  const minorTicks = Array.from(
    { length: Math.floor((rulerDuration * timelineFps) / minorStepFrames) + 1 },
    (_, i) => frameToSeconds(i * minorStepFrames, timelineFps),
  );

  const scrub = (clientX: number, ruler: HTMLElement, shiftKey: boolean) => {
    const rect = ruler.getBoundingClientRect();
    const snap = shiftKey && snapPoints && snapPoints.length > 0 ? { points: snapPoints } : undefined;
    onPlayheadSecChange(rulerClientXToTime(clientX, rect, rulerDuration, timelineFps, snap));
  };

  return (
    <div
      className="production-timeline-ruler"
      role="slider"
      aria-label="Timeline ruler"
      aria-valuemin={0}
      aria-valuemax={rulerDuration}
      aria-valuenow={playheadSec}
      title={formatTimelineTimecode(playheadSec, timelineFps)}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "m" || e.key === "M") && onToggleMarker) {
          e.preventDefault();
          onToggleMarker();
          return;
        }
        if (onZoomChange) {
          if (e.key === "=" || e.key === "+") {
            e.preventDefault();
            onZoomChange(timelineZoomStep(zoom ?? 1, 1));
            return;
          }
          if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            onZoomChange(timelineZoomStep(zoom ?? 1, -1));
            return;
          }
          if (e.key === "\\") {
            e.preventDefault();
            onZoomChange(TIMELINE_ZOOM_MIN);
            return;
          }
        }
        const next = playheadTimeForKey(e.key, e.shiftKey, playheadSec, durationSec, timelineFps);
        if (next === null) return;
        e.preventDefault();
        onPlayheadSecChange(next);
      }}
      onWheel={(e) => {
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        if (e.ctrlKey || e.metaKey) {
          onZoomChange?.(timelineZoomStep(zoom ?? 1, delta < 0 ? 1 : -1));
          return;
        }
        onPlayheadSecChange(playheadTimeForWheel(delta, e.shiftKey, playheadSec, timelineFps));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        scrub(e.clientX, e.currentTarget, e.shiftKey);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        scrub(e.clientX, e.currentTarget, e.shiftKey);
      }}
    >
      {minorTicks.map((sec) => (
        <span
          key={`minor-${sec.toFixed(3)}`}
          className="production-timeline-ruler-tick minor"
          style={{ left: `${(sec / rulerDuration) * 100}%` }}
        />
      ))}
      {majorTicks.map((sec) => (
        <span
          key={`major-${sec.toFixed(3)}`}
          className="production-timeline-ruler-tick major"
          style={{ left: `${(sec / rulerDuration) * 100}%` }}
        >
          <span>{formatTimelineTimecode(sec, timelineFps)}</span>
        </span>
      ))}
      {(markers ?? []).map((marker) => (
        <span
          key={marker.id}
          className="production-timeline-marker"
          style={{ left: `${(marker.sec / rulerDuration) * 100}%` }}
          title={formatTimelineTimecode(marker.sec, timelineFps)}
          onContextMenu={(e) => {
            if (!onRemoveMarker) return;
            e.preventDefault();
            e.stopPropagation();
            onRemoveMarker(marker.id);
          }}
        />
      ))}
    </div>
  );
}
