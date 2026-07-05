// Right rail "Adjustments" panel: the list selects a tool to inspect. It does
// not create layers until the user presses the explicit add button.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT, type MsgKey } from "../../i18n";
import type { AdjustmentType, LayerAdjustment } from "../../types/production";
import type { MaskEditDispatch } from "./actions";
import { AdjustmentControls } from "./AdjustmentControls";

const ENTRIES: { key: MsgKey; glyph: string; type?: AdjustmentType; image_only?: boolean; name: string }[] = [
  { key: "mask.adjBrightnessContrast", glyph: "BC", type: "brightness_contrast", name: "亮度/对比度" },
  { key: "mask.adjLevels", glyph: "LV", type: "levels", name: "色阶" },
  { key: "mask.adjCurve", glyph: "CV", type: "curve", name: "曲线" },
  { key: "mask.adjExposure", glyph: "EX", name: "曝光度" },
  { key: "mask.adjVibrance", glyph: "VB", name: "自然饱和度" },
  { key: "mask.adjColorBalance", glyph: "CB", name: "色彩平衡" },
  { key: "mask.adjPhotoFilter", glyph: "PF", name: "照片滤镜" },
  { key: "mask.adjChannelMixer", glyph: "CM", type: "channel_mixer", image_only: true, name: "通道混和器" },
  { key: "mask.adjColorLookup", glyph: "CL", name: "颜色查找" },
  { key: "mask.adjPosterize", glyph: "PS", name: "色调分离" },
  { key: "mask.adjThreshold", glyph: "TH", name: "阈值" },
  { key: "mask.adjColorRanges", glyph: "CR", type: "color_ranges", image_only: true, name: "颜色范围" },
  { key: "mask.adjGradientMap", glyph: "GM", name: "渐变映射" },
  { key: "mask.adjReplaceColor", glyph: "RC", type: "replace_color", image_only: true, name: "替换颜色" },
];

const defaultAdjustment = (type: AdjustmentType): LayerAdjustment => ({ type });

interface AdjustmentsPanelProps {
  dispatch: MaskEditDispatch;
  /** The active layer's adjustment (edited in the right column), if any. */
  adjustment: LayerAdjustment | null;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
  /** Colour adjustments only exist in the image workspace (grade kernel). */
  workspace: "mask" | "image";
  /** Arms a one-shot canvas eyedropper (replace-color swatches). */
  requestColorPick?: (cb: (hex: string) => void) => void;
}

export function AdjustmentsPanel({ dispatch, adjustment, patchAdjustment, workspace, requestColorPick }: AdjustmentsPanelProps) {
  const t = useT();
  const [selectedType, setSelectedType] = useState<AdjustmentType | null>(null);
  const [drafts, setDrafts] = useState<Record<AdjustmentType, LayerAdjustment>>({
    brightness_contrast: { type: "brightness_contrast" },
    levels: { type: "levels" },
    curve: { type: "curve" },
    color_ranges: { type: "color_ranges" },
    channel_mixer: { type: "channel_mixer" },
    replace_color: { type: "replace_color" },
  });

  useEffect(() => {
    if (adjustment) {
      setSelectedType(adjustment.type);
      setDrafts((prev) => ({ ...prev, [adjustment.type]: adjustment }));
    }
  }, [adjustment]);

  const selectedEntry = useMemo(
    () => (selectedType ? ENTRIES.find((entry) => entry.type === selectedType) : undefined),
    [selectedType],
  );
  const visibleAdjustment = selectedType
    ? adjustment?.type === selectedType
      ? adjustment
      : drafts[selectedType] ?? defaultAdjustment(selectedType)
    : null;
  const patchVisibleAdjustment = (patch: Partial<LayerAdjustment>) => {
    if (!selectedType) return;
    if (adjustment?.type === selectedType) {
      patchAdjustment(patch);
      return;
    }
    setDrafts((prev) => ({
      ...prev,
      [selectedType]: { ...(prev[selectedType] ?? defaultAdjustment(selectedType)), ...patch },
    }));
  };

  return (
    <div className="mask-panel-body">
      <div className="mask-adjustments-list">
        {ENTRIES.map(({ key, glyph, type: entryType, image_only }) => {
          const type = image_only && workspace !== "image" ? undefined : entryType;
          return (
          <button
            key={key}
            className={`mask-adjustment-row${type ? "" : " planned"}${type != null && type === selectedType ? " active" : ""}`}
            title={type ? t(key) : t("mask.adjPlanned")}
            aria-disabled={!type || undefined}
            onClick={() => {
              if (type) setSelectedType(type === selectedType ? null : type);
            }}
          >
            <span className="glyph" aria-hidden="true">{glyph}</span>
            <span className="label">{t(key)}</span>
          </button>
          );
        })}
      </div>
      <small className="muted">{t("mask.adjPickHint")}</small>
      {selectedType && selectedEntry && visibleAdjustment
        ? // A floating popover, deliberately without a backdrop: the live
          // canvas stays visible (and clickable, for the eyedropper) while
          // the tool is open.
          createPortal(
            <div className="adjustment-popup" role="dialog" aria-label={t(selectedEntry.key)}>
              <div className="adjustment-popup-head">
                <span>{t(selectedEntry.key)}</span>
                <button
                  type="button"
                  className="adjustment-popup-close"
                  aria-label="close"
                  onClick={() => setSelectedType(null)}
                >
                  ×
                </button>
              </div>
              <button
                className="mask-adjustment-add-btn"
                onClick={() => dispatch({
                  type: "layer_add_adjustment",
                  adjType: selectedType,
                  name: selectedEntry.name,
                })}
              >
                添加{selectedEntry.name}
              </button>
              <AdjustmentControls
                adjustment={visibleAdjustment}
                patchAdjustment={patchVisibleAdjustment}
                requestColorPick={requestColorPick}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
