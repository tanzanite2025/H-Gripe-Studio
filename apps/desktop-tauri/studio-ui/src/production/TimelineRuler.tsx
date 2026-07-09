import { DEFAULT_TIMELINE_FPS, snapTimeToFrame } from "./timeline";

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

export function rulerClientXToTime(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
  durationSec: number,
  fps: number,
): number {
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  return snapTimeToFrame(Math.min(1, Math.max(0, ratio)) * durationSec, fps);
}

export interface TimelineRulerProps {
  fps?: number;
  durationSec: number;
  playheadSec: number;
  onPlayheadSecChange: (sec: number) => void;
}

export function TimelineRuler({
  fps = DEFAULT_TIMELINE_FPS,
  durationSec,
  playheadSec,
  onPlayheadSecChange,
}: TimelineRulerProps) {
  const timelineFps = fps || DEFAULT_TIMELINE_FPS;
  const rulerDuration = timelineRulerDuration(durationSec, playheadSec);
  const majorStepSec = rulerDuration > 60 ? 10 : rulerDuration > 20 ? 5 : 1;
  const minorStepSec = majorStepSec / 10;
  const majorTicks = Array.from({ length: Math.floor(rulerDuration / majorStepSec) + 1 }, (_, i) => i * majorStepSec);
  const minorTicks = Array.from({ length: Math.floor(rulerDuration / minorStepSec) + 1 }, (_, i) => i * minorStepSec);
  const playheadRatio = rulerDuration > 0 ? Math.min(1, Math.max(0, playheadSec / rulerDuration)) : 0;

  const scrub = (clientX: number, ruler: HTMLElement) => {
    const rect = ruler.getBoundingClientRect();
    const next = rulerClientXToTime(clientX, rect, rulerDuration, timelineFps);
    onPlayheadSecChange(next);
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
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        scrub(e.clientX, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        scrub(e.clientX, e.currentTarget);
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
      <span className="production-timeline-playhead" style={{ left: `${playheadRatio * 100}%` }} />
    </div>
  );
}
