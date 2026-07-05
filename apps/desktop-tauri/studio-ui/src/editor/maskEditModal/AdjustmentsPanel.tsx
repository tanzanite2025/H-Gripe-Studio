// Right rail "Adjustments" panel: the list selects a tool to inspect. It does
// not create layers until the user presses the explicit add button.

import { useEffect, useMemo, useState } from "react";
import { useT, type MsgKey } from "../../i18n";
import type { AdjustmentType, LayerAdjustment } from "../../types/production";
import type { MaskEditDispatch } from "./actions";
import { AdjustmentControls } from "./AdjustmentControls";

const ENTRIES: { key: MsgKey; glyph: string; type?: AdjustmentType; name: string }[] = [
  { key: "mask.adjBrightnessContrast", glyph: "BC", type: "brightness_contrast", name: "亮度/对比度" },
  { key: "mask.adjLevels", glyph: "LV", type: "levels", name: "色阶" },
  { key: "mask.adjCurve", glyph: "CV", type: "curve", name: "曲线" },
  { key: "mask.adjExposure", glyph: "EX", name: "曝光度" },
  { key: "mask.adjVibrance", glyph: "VB", name: "自然饱和度" },
  { key: "mask.adjHueSaturation", glyph: "HS", name: "色相/饱和度" },
  { key: "mask.adjColorBalance", glyph: "CB", name: "色彩平衡" },
  { key: "mask.adjBlackWhite", glyph: "BW", name: "黑白" },
  { key: "mask.adjPhotoFilter", glyph: "PF", name: "照片滤镜" },
  { key: "mask.adjChannelMixer", glyph: "CM", name: "通道混和器" },
  { key: "mask.adjColorLookup", glyph: "CL", name: "颜色查找" },
  { key: "mask.adjPosterize", glyph: "PS", name: "色调分离" },
  { key: "mask.adjThreshold", glyph: "TH", name: "阈值" },
  { key: "mask.adjSelectiveColor", glyph: "SC", name: "可选颜色" },
  { key: "mask.adjGradientMap", glyph: "GM", name: "渐变映射" },
];

const defaultAdjustment = (type: AdjustmentType): LayerAdjustment => ({ type });

interface AdjustmentsPanelProps {
  dispatch: MaskEditDispatch;
  /** The active layer's adjustment (edited in the right column), if any. */
  adjustment: LayerAdjustment | null;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
}

export function AdjustmentsPanel({ dispatch, adjustment, patchAdjustment }: AdjustmentsPanelProps) {
  const t = useT();
  const [selectedType, setSelectedType] = useState<AdjustmentType>("brightness_contrast");
  const [drafts, setDrafts] = useState<Record<AdjustmentType, LayerAdjustment>>({
    brightness_contrast: { type: "brightness_contrast" },
    levels: { type: "levels" },
    curve: { type: "curve" },
  });

  useEffect(() => {
    if (adjustment) {
      setSelectedType(adjustment.type);
      setDrafts((prev) => ({ ...prev, [adjustment.type]: adjustment }));
    }
  }, [adjustment]);

  const selectedEntry = useMemo(
    () => ENTRIES.find((entry) => entry.type === selectedType),
    [selectedType],
  );
  const visibleAdjustment = adjustment?.type === selectedType
    ? adjustment
    : drafts[selectedType] ?? defaultAdjustment(selectedType);
  const patchVisibleAdjustment = (patch: Partial<LayerAdjustment>) => {
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
      <div className="mask-adjustments-split">
        <div className="mask-adjustments-list">
          {ENTRIES.map(({ key, glyph, type }) => (
            <button
              key={key}
              className={`mask-adjustment-row${type ? "" : " planned"}${type === selectedType ? " active" : ""}`}
              title={type ? t(key) : t("mask.adjPlanned")}
              aria-disabled={!type || undefined}
              onClick={() => {
                if (type) setSelectedType(type);
              }}
            >
              <span className="glyph" aria-hidden="true">{glyph}</span>
              <span className="label">{t(key)}</span>
            </button>
          ))}
        </div>
        <div className="mask-adjustments-detail">
          {selectedEntry ? (
            <>
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
              <AdjustmentControls adjustment={visibleAdjustment} patchAdjustment={patchVisibleAdjustment} />
            </>
          ) : (
            <small className="muted">{t("mask.adjPickHint")}</small>
          )}
        </div>
      </div>
    </div>
  );
}
