// Draft selection action panel: screen-space UI for a closed solid draft.
// It edits draft geometry and commits it to ActiveSelection; it never reads
// pixels or owns Layer Via Copy.
import type { Dispatch, SetStateAction } from "react";
import { useT } from "../../i18n";
import type { SceneFrame } from "./sceneFrame";
import type { SelectionDraft } from "./selection";

export function MarqueeSizePanel({
  draftSelection,
  draft,
  setDraft,
  makeSelection,
  cancelDraft,
  dims,
  frame,
  canvasEl,
}: {
  draftSelection: SelectionDraft;
  draft: { w: number; h: number };
  setDraft: Dispatch<SetStateAction<{ w: number; h: number }>>;
  makeSelection: (w: number, h: number) => void;
  cancelDraft: () => void;
  dims: { w: number; h: number };
  frame: SceneFrame;
  canvasEl: HTMLCanvasElement;
}) {
  const t = useT();
  const rect = canvasEl.getBoundingClientRect();
  const [x0, y0, x1, y1] = draftSelection.region;
  const anchorX = (Math.min(x0, x1) + Math.abs(x1 - x0) / 2 - frame.x) / frame.w;
  const anchorY = (Math.max(y0, y1) - frame.y) / frame.h;
  const midX = rect.left + anchorX * rect.width;
  const belowY = rect.top + anchorY * rect.height + 10;
  const left = Math.max(140, Math.min(midX, window.innerWidth - 140));
  const top = Math.max(10, Math.min(belowY, window.innerHeight - 96));
  const labelW = Math.round(Math.abs(x1 - x0));
  const labelH = Math.round(Math.abs(y1 - y0));
  return (
    <div
      className="mask-marquee-float"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="muted">
        {labelW} x {labelH} px
      </span>
      <span className="mask-marquee-float-row">
        <input
          type="number"
          min={2}
          max={dims.w}
          value={draft.w}
          onChange={(e) => setDraft((d) => ({ ...d, w: Number(e.target.value) || 0 }))}
        />
        x
        <input
          type="number"
          min={2}
          max={dims.h}
          value={draft.h}
          onChange={(e) => setDraft((d) => ({ ...d, h: Number(e.target.value) || 0 }))}
        />
      </span>
      <span className="mask-marquee-float-row">
        <button
          className="primary"
          disabled={draft.w < 2 || draft.h < 2}
          onClick={() => makeSelection(draft.w, draft.h)}
        >
          {t("mask.marqueeApply")}
        </button>
        <button onClick={cancelDraft}>{t("btn.cancel")}</button>
      </span>
    </div>
  );
}
