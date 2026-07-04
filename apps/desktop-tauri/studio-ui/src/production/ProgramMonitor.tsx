import { useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import { useViewControls } from "../viewport/useViewControls";
import { useVideoPreview } from "../viewport/useVideoPreview";
import type { MediaAsset } from "./mediaBin";
import { resolvePreviewFrame } from "./previewFrame";
import { timelineDuration, type TimelineModel } from "./timeline";

/**
 * Program monitor for the Timeline tab: shows the frame under the playhead
 * through a `video_preview` viewport (still clips render their image, video
 * clips decode the clip-local frame; gaps show black). The playhead is a
 * scrub slider; seek bursts are coalesced latest-wins on both sides of the
 * host boundary, so dragging never queues stale decodes.
 *
 * Playback advances the playhead wall-clock via requestAnimationFrame; frame
 * requests go through the same latest-wins queue, so the monitor shows the
 * newest frame the decoder can keep up with and never builds a backlog.
 */
export function ProgramMonitor({
  timeline,
  assets,
  clipGradeDoc,
}: {
  timeline: TimelineModel;
  assets: MediaAsset[];
  /** The clip's stored grade doc (JSON string), applied to its frames. */
  clipGradeDoc?: (clipId: string) => string | null;
}) {
  const t = useT();
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playheadRef = useRef(0);
  playheadRef.current = playheadSec;
  const { state, showFrame } = useVideoPreview();
  // Monitor zoom/pan is viewport state: the viewport re-crops its cached
  // frame proxy, so a view tick never re-decodes the frame.
  const { view, stageProps } = useViewControls(!!state.frame);

  const duration = Math.max(timelineDuration(timeline), 0);
  const clampedSec = Math.min(playheadSec, duration);
  const target = useMemo(
    () => resolvePreviewFrame(timeline, assets, clampedSec),
    [timeline, assets, clampedSec],
  );

  const gradeDoc = target ? (clipGradeDoc?.(target.clipId) ?? null) : null;
  useEffect(() => {
    showFrame(target ? { target, gradeDoc, view } : null);
  }, [target, gradeDoc, view, showFrame]);

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

  const togglePlay = () => {
    if (duration <= 0) return;
    // Play from the start when the playhead sits at the end.
    if (!playing && playheadRef.current >= duration) setPlayheadSec(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="production-monitor">
      <div className="production-monitor-frame" {...stageProps}>
        {state.frame && target ? (
          <img src={state.frame} alt={t("drawer.monitorTitle")} />
        ) : (
          <span className="production-monitor-empty muted">
            {state.error ?? (target && state.pending ? "…" : t("drawer.monitorEmpty"))}
          </span>
        )}
        {state.backend ? (
          <span className="production-monitor-backend">
            {state.backend.actual}
            {view.zoom > 1 ? <> · {Math.round(view.zoom * 100)}%</> : null}
          </span>
        ) : null}
      </div>
      <div className="production-monitor-scrub">
        <button
          type="button"
          className="production-monitor-play"
          onClick={togglePlay}
          title={t(playing ? "drawer.monitorPause" : "drawer.monitorPlay")}
          aria-pressed={playing}
          disabled={duration <= 0}
        >
          {playing ? "⏸" : "▶"}
        </button>
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
        <span className="production-monitor-time">{clampedSec.toFixed(2)}s</span>
      </div>
    </div>
  );
}
