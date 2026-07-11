// Image Size dialog (PS Ctrl+Alt+I): pixel W×H inputs with a linked-aspect
// checkbox and a resample-filter picker over the current canvas size; 确定
// records the size on the document as an undoable step (see useDialogDrafts).
import { useT, type MsgKey } from "../../i18n";
import { type ImageResample } from "../../contracts/imageEditorDocument";
import type { ImageSizeDraft } from "./useDialogDrafts";

const RESAMPLE_OPTIONS: readonly ImageResample[] = ["auto", "nearest", "bilinear", "bicubic"];
const RESAMPLE_KEYS = {
  auto: "mask.imageSizeResampleAuto",
  nearest: "mask.imageSizeResampleNearest",
  bilinear: "mask.imageSizeResampleBilinear",
  bicubic: "mask.imageSizeResampleBicubic",
} as const satisfies Record<ImageResample, MsgKey>;

interface ImageSizeDialogProps {
  draft: ImageSizeDraft;
  setDraft: React.Dispatch<React.SetStateAction<ImageSizeDraft | null>>;
  /** The document's current pixel size (the aspect the link preserves). */
  dims: { w: number; h: number };
  apply: () => void;
  close: () => void;
}

export function ImageSizeDialog({ draft, setDraft, dims, apply, close }: ImageSizeDialogProps) {
  const t = useT();
  return (
    <div className="mask-dialog-backdrop" onClick={close}>
      <div className="mask-dialog" role="dialog" aria-label={t("mask.imageSize")} onClick={(e) => e.stopPropagation()}>
        <div className="mask-dialog-title">{t("mask.imageSize")}</div>
        <div className="mask-dialog-body">
          <div className="field">
            <span>{t("mask.imageSizeCurrent")}</span>
            <small className="muted">{dims.w} × {dims.h} px</small>
          </div>
          <label className="field">
            <span>{t("mask.imageSizeWidth")}</span>
            <input
              type="number"
              min={1}
              value={draft.w}
              onChange={(e) => {
                const w = Math.max(1, Math.round(Number(e.target.value) || 0));
                setDraft((d) =>
                  d ? { ...d, w, h: d.linked ? Math.max(1, Math.round((w * dims.h) / dims.w)) : d.h } : d,
                );
              }}
            />
          </label>
          <label className="field">
            <span>{t("mask.imageSizeHeight")}</span>
            <input
              type="number"
              min={1}
              value={draft.h}
              onChange={(e) => {
                const h = Math.max(1, Math.round(Number(e.target.value) || 0));
                setDraft((d) =>
                  d ? { ...d, h, w: d.linked ? Math.max(1, Math.round((h * dims.w) / dims.h)) : d.w } : d,
                );
              }}
            />
          </label>
          <label className="field mask-dialog-check">
            <input
              type="checkbox"
              checked={draft.linked}
              onChange={(e) => setDraft((d) => (d ? { ...d, linked: e.target.checked } : d))}
            />
            <span>{t("mask.imageSizeLink")}</span>
          </label>
          <label className="field">
            <span>{t("mask.imageSizeResample")}</span>
            <select
              value={draft.resample}
              onChange={(e) => setDraft((d) => (d ? { ...d, resample: e.target.value as ImageResample } : d))}
            >
              {RESAMPLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {t(RESAMPLE_KEYS[r])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mask-dialog-actions">
          <button className="primary" onClick={apply}>
            {t("mask.imageSizeApply")}
          </button>
          <button onClick={close}>{t("mask.imageSizeCancel")}</button>
        </div>
      </div>
    </div>
  );
}
