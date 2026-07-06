import { useEffect, useMemo, useState } from "react";

import { timelineExport } from "../bridge/timelineExport";
import { useT } from "../i18n";
import { getDevicePreference } from "../runtime/devicePreference";
import type { AudioClipEdit } from "./audioEdit";
import type { MediaAsset } from "./mediaBin";
import type { TimelineModel } from "./timeline";
import {
  buildRenderPlan,
  DEFAULT_EXPORT_FPS,
  expandPlanFrames,
  type RenderWarning,
} from "./renderPlan";

// On-demand export dialog (plan step 9): the drawer's export command builds
// the timeline render plan, previews what will (and won't yet) be encoded,
// and hands the expanded frame sequence plus the audio segments (with their
// trim/gain/fade edits) to the backend FFmpeg encode + mixdown/mux. Opens on
// demand and never mounts with the drawer.

interface ExportDialogProps {
  timeline: TimelineModel;
  assets: MediaAsset[];
  /** A clip's stored grade doc (JSON string), applied at encode time. */
  clipGradeDoc?: (clipId: string) => string | null;
  /** A clip's stored audio edit, applied in the mixdown. */
  clipAudioEdit?: (clipId: string) => AudioClipEdit | null;
  onClose: () => void;
}

type ExportState =
  | { phase: "idle" }
  | { phase: "running" }
  | {
      phase: "done";
      videoPath: string;
      durationSec: number;
      gradedFrameCount: number;
      gradeBackend: "cpu" | "gpu" | null;
      encodeDevice: string | null;
      encodeFallbackReason: string | null;
      audioClipCount: number;
      audioSkippedReason: string | null;
    }
  | { phase: "error"; message: string };

export function ExportDialog({
  timeline,
  assets,
  clipGradeDoc,
  clipAudioEdit,
  onClose,
}: ExportDialogProps) {
  const t = useT();
  const [fps, setFps] = useState(DEFAULT_EXPORT_FPS);
  // Seeded from the global device preference (GPU plan long-term step 5);
  // the dialog's explicit select still overrides per export.
  const [device, setDevice] = useState<"auto" | "cpu" | "gpu">(() => getDevicePreference());
  const [outputName, setOutputName] = useState("");
  const [state, setState] = useState<ExportState>({ phase: "idle" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const plan = useMemo(
    () => buildRenderPlan(timeline, assets, { fps, clipGradeDoc, clipAudioEdit }),
    [timeline, assets, fps, clipGradeDoc, clipAudioEdit],
  );
  const frames = useMemo(() => expandPlanFrames(plan), [plan]);
  const canExport = plan.video.length > 0 && frames !== null && state.phase !== "running";

  const warningText = (w: RenderWarning): string => {
    switch (w.kind) {
      case "missing_asset":
        return t("export.warnMissingAsset", { id: w.assetId });
      case "gap":
        return t("export.warnGap", { at: w.atSec.toFixed(1), len: w.lengthSec.toFixed(1) });
    }
  };

  const runExport = async () => {
    if (!frames || frames.paths.length === 0) return;
    setState({ phase: "running" });
    try {
      const result = await timelineExport(frames.paths, plan.fps, {
        device: device !== "auto" ? device : undefined,
        outputName: outputName.trim() || undefined,
        gradeDocs: frames.gradeDocs.some((d) => d !== null) ? frames.gradeDocs : undefined,
        frameTimes: frames.hasVideoFrames ? frames.frameTimes : undefined,
        audio:
          plan.audio.length > 0
            ? plan.audio.map((s) => ({
                path: s.path,
                startSec: s.start,
                durationSec: s.duration,
                trimStartSec: s.trimStartSec,
                gainDb: s.gainDb,
                fadeInSec: s.fadeInSec,
                fadeOutSec: s.fadeOutSec,
              }))
            : undefined,
      });
      if (!result) {
        setState({ phase: "error", message: t("export.noBackend") });
        return;
      }
      setState({
        phase: "done",
        videoPath: result.video_path,
        durationSec: result.duration_sec,
        gradedFrameCount: result.graded_frame_count ?? 0,
        gradeBackend: result.grade_backend ?? null,
        encodeDevice: result.encode_device ?? null,
        encodeFallbackReason: result.encode_fallback_reason ?? null,
        audioClipCount: result.audio_clip_count ?? 0,
        audioSkippedReason: result.audio_skipped_reason ?? null,
      });
    } catch (err) {
      setState({ phase: "error", message: String(err) });
    }
  };

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name">{t("export.title")}</span>
          <div className="media-viewer-actions">
            <button className="primary" onClick={runExport} disabled={!canExport} title={t("export.runTitle")}>
              {state.phase === "running" ? t("export.running") : t("export.run")}
            </button>
            <button onClick={onClose} title={t("export.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

        <div className="export-body">
          <p className="export-summary">
            {t("export.summary", {
              clips: plan.video.length,
              len: plan.durationSec.toFixed(1),
              fps: plan.fps,
            })}
          </p>

          <div className="export-fields">
            <label className="field">
              <span>{t("export.fps")}</span>
              <input
                type="number"
                min={1}
                max={120}
                value={fps}
                onChange={(e) => setFps(Math.max(1, Math.min(120, Number(e.target.value) || DEFAULT_EXPORT_FPS)))}
              />
            </label>
            <label className="field">
              <span>{t("export.device")}</span>
              <select
                value={device}
                title={t("export.deviceTitle")}
                onChange={(e) => setDevice(e.target.value as "auto" | "cpu" | "gpu")}
              >
                <option value="auto">auto</option>
                <option value="cpu">cpu</option>
                <option value="gpu">gpu</option>
              </select>
            </label>
            <label className="field">
              <span>{t("export.outputName")}</span>
              <input
                type="text"
                value={outputName}
                placeholder={t("export.outputNamePlaceholder")}
                onChange={(e) => setOutputName(e.target.value)}
              />
            </label>
          </div>

          {plan.audio.length > 0 ? (
            <p className="export-summary">{t("export.audioSummary", { n: plan.audio.length })}</p>
          ) : null}

          {plan.video.length === 0 ? <p className="export-warning">{t("export.emptyPlan")}</p> : null}
          {frames === null ? <p className="export-warning">{t("export.tooManyFrames")}</p> : null}
          {plan.warnings.length > 0 ? (
            <ul className="export-warnings">
              {plan.warnings.map((w, i) => (
                <li key={i} className="export-warning">
                  {warningText(w)}
                </li>
              ))}
            </ul>
          ) : null}

          {state.phase === "done" ? (
            <p className="export-result" title={state.videoPath}>
              {t("export.done", { path: state.videoPath, len: state.durationSec.toFixed(1) })}
              {state.gradedFrameCount > 0 && state.gradeBackend ? (
                <>
                  {" · "}
                  {t("export.gradedNote", {
                    n: state.gradedFrameCount,
                    backend: state.gradeBackend,
                  })}
                </>
              ) : null}
              {state.encodeDevice === "ffmpeg_hw" ? (
                <>
                  {" · "}
                  {t("export.hwEncodeNote")}
                </>
              ) : null}
              {state.audioClipCount > 0 ? (
                <>
                  {" · "}
                  {t("export.audioNote", { n: state.audioClipCount })}
                </>
              ) : null}
            </p>
          ) : null}
          {state.phase === "done" && state.encodeFallbackReason && device === "gpu" ? (
            <p className="export-warning">
              {t("export.encodeFallback", { reason: state.encodeFallbackReason })}
            </p>
          ) : null}
          {state.phase === "done" && state.audioSkippedReason ? (
            <p className="export-warning">
              {t("export.audioSkipped", { reason: state.audioSkippedReason })}
            </p>
          ) : null}
          {state.phase === "error" ? <p className="export-error">{state.message}</p> : null}
        </div>
      </div>
    </div>
  );
}
