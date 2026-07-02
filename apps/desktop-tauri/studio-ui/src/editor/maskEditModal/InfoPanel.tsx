// Right rail — "Mask info" panel block: matting band strokes, SAM 2 point
// prompts, and the edit-paths note.

import { useT } from "../../i18n";
import type { BrushStroke, PointPrompt } from "../../types/production";

interface InfoPanelProps {
  matteStrokes: readonly BrushStroke[];
  points: readonly PointPrompt[];
  count: number;
}

export function InfoPanel({ matteStrokes, points, count }: InfoPanelProps) {
  const t = useT();
  return (
    <section className="mask-panel">
      <header>{t("mask.panelInfo")}</header>
      <div className="field">
        <span>{t("mask.mattingBand", { count: matteStrokes.length })}</span>
        <div className="mask-op-list">
          {matteStrokes.length === 0 ? (
            <small className="muted">{t("mask.matteEmpty")}</small>
          ) : (
            matteStrokes.map((s, i) => (
              <span key={s.id ?? i} className="mask-op-chip">
                {t("mask.bandRadius", { radius: s.radius })}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="field">
        <span>{t("mask.samPoints", { count: points.length })}</span>
        <div className="mask-op-list">
          {points.length === 0 ? (
            <small className="muted">{t("mask.pointsEmpty")}</small>
          ) : (
            points.map((p, i) => (
              <span key={i} className={`mask-op-chip${p.label === 0 ? " negative" : ""}`}>
                {p.label === 0 ? "−" : "+"}#{i + 1} {p.x},{p.y}
              </span>
            ))
          )}
        </div>
      </div>

      <small className="muted mask-edit-note">
        {t("mask.notePrefix", { count })}
        <code>edit_paths</code>
        {t("mask.noteSuffix")}
      </small>
    </section>
  );
}
