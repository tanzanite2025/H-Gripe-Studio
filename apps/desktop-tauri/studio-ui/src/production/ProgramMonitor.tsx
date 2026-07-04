import { useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import { useVideoPreview } from "../viewport/useVideoPreview";
import {
  IDENTITY_VIEW,
  panView,
  zoomView,
  type ViewportViewState,
} from "../viewport/view";
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
  clipGradeDoc,
}: {
  timeline: TimelineModel;
  assets: MediaAsset[];
  /** The clip's stored grade doc (JSON string), applied to its frames. */
  clipGradeDoc?: (clipId: string) => string | null;
}) {
  const t = useT();
  const [playheadSec, setPlayheadSec] = useState(0);
  // Monitor zoom/pan is viewport state: wheel zooms (up to 8x), dragging
  // pans when zoomed, double-click resets. The viewport re-crops its cached
  // frame proxy, so a view tick never re-decodes the frame.
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { state, showFrame } = useVideoPreview();

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

  const handleWheel = (e: React.WheelEvent) => {
    if (!state.frame) return;
    setView((v) => zoomView(v, e.deltaY < 0 ? 1.25 : 0.8));
  };
  const handlePointerDown = (e: React.PointerEvent) => {
    if (view.zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const from = dragRef.current;
    const frame = frameRef.current;
    if (!from || !frame) return;
    const rect = frame.getBoundingClientRect();
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => panView(v, dx, dy, rect.width, rect.height));
  };
  const handlePointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="production-monitor">
      <div
        className="production-monitor-frame"
        ref={frameRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => setView(IDENTITY_VIEW)}
        style={view.zoom > 1 ? { cursor: dragRef.current ? "grabbing" : "grab" } : undefined}
      >
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
