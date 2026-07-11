// Keyframe diamonds rendered on the selected timeline clip: grouped markers
// with double-click / Delete removal and pointer dragging (Shift snaps to
// timeline snap points and sibling keyframes).

import { useRef } from "react";

import { useT } from "../i18n";
import type { ClipProperties } from "./clipProps";
import type { TimelineTool } from "./DrawerToolbar";
import {
  moveKeyframesAtTime,
  removeKeyframesAtTime,
  timelineKeyframeGroups,
} from "./keyframes";
import { snapTimeToPoints, type TimelineClip } from "./timeline";

/** Shift-drag snap capture radius around snap candidates, in clip pixels. */
const KEYFRAME_SNAP_THRESHOLD_PX = 8;

interface ActiveKeyframeDrag {
  pointerId: number;
  clipId: string;
  fromT: number;
  clipStart: number;
  clipDuration: number;
  clipLeft: number;
  clipWidth: number;
  props: ClipProperties;
}

export function TimelineClipKeyframeMarkers({
  clip,
  clipProperties,
  timelineFps,
  timelineTool,
  trackLocked,
  snapPoints,
  onSetClipProperties,
}: {
  clip: TimelineClip;
  clipProperties: ClipProperties;
  timelineFps: number;
  timelineTool: TimelineTool;
  trackLocked: boolean;
  snapPoints: number[];
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
}) {
  const t = useT();
  const keyframeDrag = useRef<ActiveKeyframeDrag | null>(null);
  const keyframeEps = 0.5 / timelineFps;
  const keyframes = timelineKeyframeGroups(clipProperties, keyframeEps).filter(
    (group) => group.t >= 0 && group.t <= clip.duration,
  );

  return (
    <>
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
            if (!onSetClipProperties || trackLocked) return;
            onSetClipProperties(
              clip.id,
              removeKeyframesAtTime(clipProperties, group.t, keyframeEps),
            );
          }}
          onKeyDown={(event) => {
            if (
              (event.key !== "Delete" && event.key !== "Backspace") ||
              !onSetClipProperties ||
              trackLocked
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
              !onSetClipProperties ||
              trackLocked
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
                ((event.clientX - drag.clipLeft) / drag.clipWidth) * drag.clipDuration,
              ),
            );
            if (event.shiftKey) {
              const absoluteCandidates = [
                ...snapPoints,
                ...keyframes
                  .filter((candidate) => candidate.t !== drag.fromT)
                  .map((candidate) => drag.clipStart + candidate.t),
              ];
              const toleranceSec =
                (KEYFRAME_SNAP_THRESHOLD_PX / drag.clipWidth) * drag.clipDuration;
              localTime =
                snapTimeToPoints(
                  drag.clipStart + localTime,
                  absoluteCandidates,
                  toleranceSec,
                ) - drag.clipStart;
              localTime = Math.min(drag.clipDuration, Math.max(0, localTime));
            }
            onSetClipProperties(
              clip.id,
              moveKeyframesAtTime(drag.props, drag.fromT, localTime, keyframeEps),
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
    </>
  );
}
