// Floating selection-size panel: centred below the marquee's bottom edge,
// clamped to the window. Screen-space so the view transform never scales it.
import { useT } from "../../i18n";

export function MarqueeSizePanel({
  region,
  draft,
  setDraft,
  makeSelection,
  dims,
  canvasEl,
}: {
  region: [number, number, number, number];
  draft: { w: number; h: number };
  setDraft: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>;
  makeSelection: (w: number, h: number) => void;
  dims: { w: number; h: number };
  canvasEl: HTMLCanvasElement;
}) {
  const t = useT();
  const rect = canvasEl.getBoundingClientRect();
  const [x0, y0, x1, y1] = region;
  const midX = rect.left + (((x0 + x1) / 2) / dims.w) * rect.width;
  const belowY = rect.top + (y1 / dims.h) * rect.height + 10;
  const left = Math.max(130, Math.min(midX, window.innerWidth - 130));
  const top = Math.max(10, Math.min(belowY, window.innerHeight - 90));
  return (
    <div
      className="mask-marquee-float"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="muted">
        {Math.round(x1 - x0)} × {Math.round(y1 - y0)} px
      </span>
      <span className="mask-marquee-float-row">
        <input
          type="number"
          min={2}
          max={dims.w}
          value={draft.w}
          onChange={(e) => setDraft((d) => ({ ...d, w: Number(e.target.value) || 0 }))}
        />
        ×
        <input
          type="number"
          min={2}
          max={dims.h}
          value={draft.h}
          onChange={(e) => setDraft((d) => ({ ...d, h: Number(e.target.value) || 0 }))}
        />
        <button
          className="primary"
          disabled={draft.w < 2 || draft.h < 2}
          onClick={() => makeSelection(draft.w, draft.h)}
        >
          {t("mask.marqueeApply")}
        </button>
      </span>
    </div>
  );
}
