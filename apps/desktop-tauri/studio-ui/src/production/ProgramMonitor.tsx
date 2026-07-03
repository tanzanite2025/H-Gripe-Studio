import { useEffect, useMemo, useState } from "react";

import { useT } from "../i18n";
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
 */
export function ProgramMonitor({
  timeline,
  assets,
}: {
  timeline: TimelineModel;
  assets: MediaAsset[];
}) {
  const t = useT();
  const [playheadSec, setPlayheadSec] = useState(0);
  const { state, showFrame } = useVideoPreview();

  const duration = Math.max(timelineDuration(timeline), 0);
  const clampedSec = Math.min(playheadSec, duration);
  const target = useMemo(
    () => resolvePreviewFrame(timeline, assets, clampedSec),
    [timeline, assets, clampedSec],
  );

  useEffect(() => {
    showFrame(target);
  }, [target, showFrame]);

  return (
    <div className="production-monitor">
      <div className="production-monitor-frame">
        {state.frame && target ? (
          <img src={state.frame} alt={t("drawer.monitorTitle")} />
        ) : (
          <span className="production-monitor-empty muted">
            {state.error ?? (target && state.pending ? "…" : t("drawer.monitorEmpty"))}
          </span>
        )}
        {state.backend ? (
          <span className="production-monitor-backend">{state.backend.actual}</span>
        ) : null}
      </div>
      <div className="production-monitor-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.05}
          value={clampedSec}
          onChange={(e) => setPlayheadSec(Number(e.target.value))}
          title={t("drawer.monitorScrubTitle")}
          disabled={duration <= 0}
        />
        <span className="production-monitor-time">{clampedSec.toFixed(2)}s</span>
      </div>
    </div>
  );
}
