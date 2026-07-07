// Floating crop panel: below the pending crop box — pixel W×H inputs, aspect
// presets / saved size templates, and the ratio lock. Manual pixel sizing
// clears a picked preset.
import { useT } from "../../i18n";
import { CROP_ASPECTS, type CropTool } from "./useCropTool";

export function CropPanel({
  crop,
  cropDraft,
  dims,
  canvasEl,
}: {
  crop: CropTool;
  cropDraft: [number, number, number, number];
  dims: { w: number; h: number };
  canvasEl: HTMLCanvasElement;
}) {
  const t = useT();
  const rect = canvasEl.getBoundingClientRect();
  const [cx0, , cx1, cy1] = cropDraft;
  const midX = rect.left + (((cx0 + cx1) / 2) / dims.w) * rect.width;
  const belowY = rect.top + (cy1 / dims.h) * rect.height + 10;
  const left = Math.max(210, Math.min(midX, window.innerWidth - 210));
  const top = Math.max(10, Math.min(belowY, window.innerHeight - 110));
  return (
    <div
      className="mask-marquee-float"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="mask-marquee-float-row">
        <select
          aria-label={t("crop.aspect")}
          value={crop.cropAspect}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("tpl:")) {
              const tpl = crop.cropTemplates[Number(v.slice(4))];
              crop.setCropAspect(v);
              if (tpl) {
                crop.cropLockRatio.current = tpl.w / tpl.h;
                crop.applyCropSize(tpl.w, tpl.h);
              }
            } else {
              crop.applyCropAspect(v);
            }
          }}
        >
          <option value="">{t("crop.aspectFree")}</option>
          {CROP_ASPECTS.map(([label]) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
          {crop.cropTemplates.map((tpl, i) => (
            <option key={`tpl-${tpl.w}x${tpl.h}`} value={`tpl:${i}`}>
              {tpl.w}×{tpl.h}px
            </option>
          ))}
        </select>
        <label className="mask-crop-lock" title={t("crop.lockRatioTitle")}>
          <input
            type="checkbox"
            checked={crop.cropLock}
            onChange={(e) => crop.setCropLock(e.target.checked)}
          />
          {t("crop.lockRatio")}
        </label>
      </span>
      <span className="mask-marquee-float-row">
        <input
          type="number"
          min={2}
          max={dims.w}
          value={crop.cropSizeDraft.w}
          onChange={(e) => crop.onCropSizeInput("w", Number(e.target.value) || 0)}
        />
        ×
        <input
          type="number"
          min={2}
          max={dims.h}
          value={crop.cropSizeDraft.h}
          onChange={(e) => crop.onCropSizeInput("h", Number(e.target.value) || 0)}
        />
        <span className="muted">px</span>
        <button title={t("crop.saveTemplateTitle")} onClick={crop.saveCropTemplate}>
          {t("crop.saveTemplate")}
        </button>
        <button
          className="primary"
          title={t("crop.applyTitle2")}
          onClick={() => crop.confirmCropDraft(cropDraft)}
        >
          {t("crop.apply")}
        </button>
        <button title={t("crop.cancel")} onClick={() => crop.setCropDraft(null)}>
          ✕
        </button>
      </span>
    </div>
  );
}
