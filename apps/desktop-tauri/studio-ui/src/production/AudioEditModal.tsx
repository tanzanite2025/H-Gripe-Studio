import { useEffect, useState } from "react";

import { useT } from "../i18n";
import {
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  clampAudioEdit,
  editedDuration,
  gainScalar,
  type AudioClipEdit,
} from "./audioEdit";
import {
  sliceWaveformPeaksToTrimmedSourceWindow,
  waveformPolygonPointsFromPeaks,
} from "./audioWaveformDisplay";
import { useAudioWaveformPeaks } from "./useAudioWaveformPeaks";

// On-demand minimal audio editor (plan step 8): source trim + gain + fades
// for one timeline audio clip, opened by right-clicking the clip in the
// drawer. The stage draws the source's decoded sample waveform (backend
// `audio_waveform_peaks`, native FFmpeg) under a gain/fade envelope of the
// trimmed clip; outside the desktop app the envelope stands alone. Edits
// are non-destructive documents the export render plan applies via FFmpeg.

interface AudioEditModalProps {
  title: string;
  /** Absolute media path of the clip's source file; `null` when unknown
   * (browser preview assets), which skips the sample waveform. */
  sourceMediaPath: string | null;
  /** Length of the source media, seconds (assumed until audio probing lands). */
  sourceDurationSec: number;
  initialEdit: AudioClipEdit;
  onCommit: (edit: AudioClipEdit) => void;
  onClose: () => void;
}

export function AudioEditModal({
  title,
  sourceMediaPath,
  sourceDurationSec,
  initialEdit,
  onCommit,
  onClose,
}: AudioEditModalProps) {
  const t = useT();
  const [edit, setEdit] = useState<AudioClipEdit>(() => clampAudioEdit(initialEdit, sourceDurationSec));
  const waveform = useAudioWaveformPeaks(sourceMediaPath);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (p: Partial<AudioClipEdit>) =>
    setEdit((prev) => clampAudioEdit({ ...prev, ...p }, sourceDurationSec));

  const length = editedDuration(edit, sourceDurationSec);
  const trimEnd = edit.trimEndSec ?? sourceDurationSec;
  // Schematic envelope polygon: silence → fade-in → plateau at the gain level
  // → fade-out → silence, over the trimmed length.
  const h = 60;
  const level = Math.min(1, gainScalar(edit.gainDb)) * (h - 4);
  const x = (tSec: number) => (tSec / length) * 100;
  const points = [
    `0,${h}`,
    `${x(edit.fadeInSec)},${h - level}`,
    `${x(length - edit.fadeOutSec)},${h - level}`,
    `100,${h}`,
  ].join(" ");
  const trimmedWindowWaveformPoints = waveform
    ? waveformPolygonPointsFromPeaks(
        sliceWaveformPeaksToTrimmedSourceWindow(
          waveform.peaks,
          edit.trimStartSec,
          trimEnd,
          waveform.duration_sec,
        ),
        100,
        h,
      )
    : "";

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ) => (
    <label className="field">
      <span>{label}</span>
      <span className="slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output>{value.toFixed(step < 1 ? 1 : 0)}</output>
      </span>
    </label>
  );

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer audio-edit" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={title}>
            {title} <span className="muted">· {t("audioEdit.title")}</span>
          </span>
          <div className="media-viewer-actions">
            <button className="primary" onClick={() => onCommit(edit)} title={t("audioEdit.applyTitle")}>
              {t("audioEdit.apply")}
            </button>
            <button onClick={onClose} title={t("audioEdit.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

        <div className="audio-edit-body">
          <div className="audio-edit-stage">
            <svg
              className="audio-edit-envelope"
              viewBox={`0 0 100 ${h}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={t("audioEdit.envelopeLabel")}
            >
              {trimmedWindowWaveformPoints && (
                <polygon className="audio-edit-waveform" points={trimmedWindowWaveformPoints} />
              )}
              <polygon points={points} />
            </svg>
            <small className="muted">
              {t("audioEdit.lengthInfo", {
                len: length.toFixed(1),
                start: edit.trimStartSec.toFixed(1),
                end: trimEnd.toFixed(1),
              })}
            </small>
          </div>

          <div className="audio-edit-controls">
            {slider(
              t("audioEdit.trimStart"),
              edit.trimStartSec,
              0,
              sourceDurationSec,
              0.1,
              (trimStartSec) => patch({ trimStartSec }),
            )}
            {slider(t("audioEdit.trimEnd"), trimEnd, 0, sourceDurationSec, 0.1, (v) =>
              patch({ trimEndSec: v }),
            )}
            {slider(t("audioEdit.gain"), edit.gainDb, MIN_GAIN_DB, MAX_GAIN_DB, 0.5, (gainDb) =>
              patch({ gainDb }),
            )}
            {slider(t("audioEdit.fadeIn"), edit.fadeInSec, 0, sourceDurationSec, 0.1, (fadeInSec) =>
              patch({ fadeInSec }),
            )}
            {slider(t("audioEdit.fadeOut"), edit.fadeOutSec, 0, sourceDurationSec, 0.1, (fadeOutSec) =>
              patch({ fadeOutSec }),
            )}
            {!trimmedWindowWaveformPoints && (
              <small className="muted">{t("audioEdit.waveformHint")}</small>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
