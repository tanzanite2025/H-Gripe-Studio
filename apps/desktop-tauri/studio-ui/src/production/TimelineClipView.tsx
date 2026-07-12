// One clip rendered inside a timeline track lane: selection, drag-move,
// edge trim handles, razor split (with hover preview), right-click menu
// trigger, remove affordance, and the selected clip's keyframe markers.

import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import type { ClipProperties } from "./clipProps";
import type { TimelineTool } from "./DrawerToolbar";
import { TimelineClipKeyframeMarkers } from "./TimelineClipKeyframeMarkers";
import type { TimelineClipMenuState } from "./TimelineClipContextMenu";
import {
  MIN_CLIP_SECONDS,
  snapTimeToPoints,
  type ClipTrimEdge,
  type TimelineClip,
} from "./timeline";

/** Pointer must travel this far before a press becomes a drag-move. */
const CLIP_DRAG_START_THRESHOLD_PX = 3;
const CLIP_SNAP_THRESHOLD_PX = 8;

interface ActiveClipMoveDrag {
  pointerId: number;
  startClientX: number;
  clipStartSecAtDragStart: number;
  clipDurationSec: number;
  pixelsPerSecond: number;
  moved: boolean;
}

interface ActiveClipTrimDrag {
  pointerId: number;
  edge: ClipTrimEdge;
  startClientX: number;
  edgeSecAtDragStart: number;
  pixelsPerSecond: number;
}

export function TimelineClipView({
  clip,
  clipDisplayName,
  selected,
  trackLocked,
  rulerDurationSec,
  timelineFps,
  timelineTool,
  snapPoints,
  clipProperties,
  onSelectClip,
  onSplitClipAt,
  onRemoveClip,
  onMoveClipTo,
  onTrimClipEdge,
  onSetClipProperties,
  onOpenContextMenu,
}: {
  clip: TimelineClip;
  clipDisplayName: string;
  selected: boolean;
  trackLocked: boolean;
  rulerDurationSec: number;
  timelineFps: number;
  timelineTool: TimelineTool;
  snapPoints: number[];
  /** The selected clip's property document (keyframe markers source). */
  clipProperties?: ClipProperties;
  onSelectClip: (clipId: string | null) => void;
  onSplitClipAt: (clipId: string, atSec: number) => void;
  onRemoveClip: (clipId: string) => void;
  onMoveClipTo: (clipId: string, toStartSec: number) => void;
  onTrimClipEdge: (clipId: string, edge: ClipTrimEdge, toSec: number) => void;
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
  onOpenContextMenu: (menu: TimelineClipMenuState) => void;
}) {
  const t = useT();
  const [razorPreview, setRazorPreview] = useState<{ ratio: number; valid: boolean } | null>(
    null,
  );
  const moveDrag = useRef<ActiveClipMoveDrag | null>(null);
  const trimDrag = useRef<ActiveClipTrimDrag | null>(null);
  const suppressClickAfterDrag = useRef(false);

  const editableWithSelectTool = !trackLocked && timelineTool === "select";

  const beginTrimDrag = (event: React.PointerEvent<HTMLElement>, edge: ClipTrimEdge) => {
    if (!editableWithSelectTool || event.button !== 0) return;
    event.stopPropagation();
    const clipElement = event.currentTarget.parentElement;
    const width = clipElement?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || clip.duration <= 0) return;
    trimDrag.current = {
      pointerId: event.pointerId,
      edge,
      startClientX: event.clientX,
      edgeSecAtDragStart: edge === "start" ? clip.start : clip.start + clip.duration,
      pixelsPerSecond: width / clip.duration,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateTrimDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = trimDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    let desiredSec =
      drag.edgeSecAtDragStart + (event.clientX - drag.startClientX) / drag.pixelsPerSecond;
    if (event.shiftKey) {
      desiredSec = snapTimeToPoints(
        desiredSec,
        snapPoints,
        CLIP_SNAP_THRESHOLD_PX / drag.pixelsPerSecond,
      );
    }
    onTrimClipEdge(clip.id, drag.edge, desiredSec);
  };

  const endTrimDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (trimDrag.current?.pointerId === event.pointerId) trimDrag.current = null;
  };

  useEffect(() => {
    if (timelineTool !== "razor") setRazorPreview(null);
  }, [timelineTool]);

  const razorOffsetAt = (target: HTMLElement, clientX: number) => {
    const rect = target.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const clampedRatio = Math.min(1, Math.max(0, ratio));
    const offset = clip.duration * clampedRatio;
    return {
      ratio: clampedRatio,
      offset,
      valid: offset >= MIN_CLIP_SECONDS && clip.duration - offset >= MIN_CLIP_SECONDS,
    };
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`production-clip clip-${clip.kind}${selected ? " active" : ""}${timelineTool === "razor" ? " razor-ready" : ""}`}
      style={{
        left: `${(clip.start / rulerDurationSec) * 100}%`,
        width: `${(clip.duration / rulerDurationSec) * 100}%`,
      }}
      onClick={(event) => {
        if (suppressClickAfterDrag.current) {
          suppressClickAfterDrag.current = false;
          return;
        }
        if (trackLocked) return;
        if (timelineTool === "razor") {
          const { offset, valid } = razorOffsetAt(event.currentTarget, event.clientX);
          if (valid) onSplitClipAt(clip.id, clip.start + offset);
          return;
        }
        onSelectClip(selected ? null : clip.id);
      }}
      onPointerDown={(event) => {
        if (!editableWithSelectTool || event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (
          target.closest(
            ".production-clip-keyframe, .production-clip-remove, .production-clip-trim-handle",
          )
        )
          return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || clip.duration <= 0) return;
        moveDrag.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          clipStartSecAtDragStart: clip.start,
          clipDurationSec: clip.duration,
          pixelsPerSecond: rect.width / clip.duration,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = moveDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const deltaPx = event.clientX - drag.startClientX;
        if (!drag.moved && Math.abs(deltaPx) < CLIP_DRAG_START_THRESHOLD_PX) return;
        drag.moved = true;
        suppressClickAfterDrag.current = true;
        let desiredStartSec = drag.clipStartSecAtDragStart + deltaPx / drag.pixelsPerSecond;
        if (event.shiftKey) {
          const toleranceSec = CLIP_SNAP_THRESHOLD_PX / drag.pixelsPerSecond;
          const snappedByStart = snapTimeToPoints(desiredStartSec, snapPoints, toleranceSec);
          const snappedByEnd =
            snapTimeToPoints(desiredStartSec + drag.clipDurationSec, snapPoints, toleranceSec) -
            drag.clipDurationSec;
          desiredStartSec =
            Math.abs(snappedByEnd - desiredStartSec) < Math.abs(snappedByStart - desiredStartSec)
              ? snappedByEnd
              : snappedByStart;
        }
        onMoveClipTo(clip.id, desiredStartSec);
      }}
      onPointerUp={(event) => {
        if (moveDrag.current?.pointerId === event.pointerId) moveDrag.current = null;
      }}
      onPointerCancel={(event) => {
        if (moveDrag.current?.pointerId === event.pointerId) moveDrag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (trackLocked || timelineTool !== "select") return;
        event.preventDefault();
        onSelectClip(selected ? null : clip.id);
      }}
      onMouseMove={(event) => {
        if (timelineTool !== "razor") return;
        const { ratio, valid } = razorOffsetAt(event.currentTarget, event.clientX);
        setRazorPreview({ ratio, valid });
      }}
      onMouseLeave={() => {
        if (timelineTool === "razor") setRazorPreview(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelectClip(clip.id);
        onOpenContextMenu({
          x: event.clientX,
          y: event.clientY,
          clipId: clip.id,
          assetId: clip.assetId,
          kind: clip.kind,
        });
      }}
      title={`${clipDisplayName} · ${clip.start.toFixed(1)}s → ${(clip.start + clip.duration).toFixed(1)}s · ${t("drawer.clipMenuHint")}`}
    >
      {razorPreview ? (
        <span
          className={`production-clip-razor-preview${razorPreview.valid ? "" : " invalid"}`}
          style={{ left: `${razorPreview.ratio * 100}%` }}
        />
      ) : null}
      <span className="production-clip-name">{clipDisplayName}</span>
      {editableWithSelectTool ? (
        <>
          <span
            className="production-clip-trim-handle trim-start"
            role="slider"
            aria-label={t("drawer.trimClipStartHandle")}
            title={t("drawer.trimClipStartHandle")}
            onPointerDown={(event) => beginTrimDrag(event, "start")}
            onPointerMove={updateTrimDrag}
            onPointerUp={endTrimDrag}
            onPointerCancel={endTrimDrag}
            onClick={(event) => event.stopPropagation()}
          />
          <span
            className="production-clip-trim-handle trim-end"
            role="slider"
            aria-label={t("drawer.trimClipEndHandle")}
            title={t("drawer.trimClipEndHandle")}
            onPointerDown={(event) => beginTrimDrag(event, "end")}
            onPointerMove={updateTrimDrag}
            onPointerUp={endTrimDrag}
            onPointerCancel={endTrimDrag}
            onClick={(event) => event.stopPropagation()}
          />
        </>
      ) : null}
      {selected && clipProperties ? (
        <TimelineClipKeyframeMarkers
          clip={clip}
          clipProperties={clipProperties}
          timelineFps={timelineFps}
          timelineTool={timelineTool}
          trackLocked={trackLocked}
          snapPoints={snapPoints}
          onSetClipProperties={onSetClipProperties}
        />
      ) : null}
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
}
