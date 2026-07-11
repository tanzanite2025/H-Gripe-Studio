// One clip rendered inside a timeline track lane: selection, razor split
// (with hover preview), right-click menu trigger, remove affordance, and the
// selected clip's keyframe markers.

import { useEffect, useState } from "react";

import { useT } from "../i18n";
import type { ClipProperties } from "./clipProps";
import type { TimelineTool } from "./DrawerToolbar";
import { TimelineClipKeyframeMarkers } from "./TimelineClipKeyframeMarkers";
import type { TimelineClipMenuState } from "./TimelineClipContextMenu";
import { MIN_CLIP_SECONDS, type TimelineClip } from "./timeline";

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
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
  onOpenContextMenu: (menu: TimelineClipMenuState) => void;
}) {
  const t = useT();
  const [razorPreview, setRazorPreview] = useState<{ ratio: number; valid: boolean } | null>(
    null,
  );

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
        if (trackLocked) return;
        if (timelineTool === "razor") {
          const { offset, valid } = razorOffsetAt(event.currentTarget, event.clientX);
          if (valid) onSplitClipAt(clip.id, clip.start + offset);
          return;
        }
        onSelectClip(selected ? null : clip.id);
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
