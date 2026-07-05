// Right rail — "Adjustments" panel (PS 调整): a two-column layout — the
// adjustment list on the left, and the clicked adjustment's parameters in
// the right column (one click adds the layer above the active layer; the
// controls then edit it directly). PS's full adjustment list is shown for
// muscle memory; entries without an engine yet are greyed as planned.

import { useT, type MsgKey } from "../../i18n";
import type { AdjustmentType, LayerAdjustment } from "../../types/production";
import type { MaskEditDispatch } from "./actions";
import { AdjustmentControls } from "./AdjustmentControls";

// PS 调整 panel order; ready entries carry the engine's adjustment type.
const ENTRIES: { key: MsgKey; glyph: string; type?: AdjustmentType }[] = [
  { key: "mask.adjBrightnessContrast", glyph: "☀", type: "brightness_contrast" },
  { key: "mask.adjLevels", glyph: "▤", type: "levels" },
  { key: "mask.adjCurve", glyph: "◡", type: "curve" },
  { key: "mask.adjExposure", glyph: "◧" },
  { key: "mask.adjVibrance", glyph: "▽" },
  { key: "mask.adjHueSaturation", glyph: "◫" },
  { key: "mask.adjColorBalance", glyph: "⚖" },
  { key: "mask.adjBlackWhite", glyph: "◑" },
  { key: "mask.adjPhotoFilter", glyph: "◙" },
  { key: "mask.adjChannelMixer", glyph: "◍" },
  { key: "mask.adjColorLookup", glyph: "▦" },
  { key: "mask.adjInvert", glyph: "◐" },
  { key: "mask.adjPosterize", glyph: "▥" },
  { key: "mask.adjThreshold", glyph: "◨" },
  { key: "mask.adjSelectiveColor", glyph: "▧" },
  { key: "mask.adjGradientMap", glyph: "▨" },
];

interface AdjustmentsPanelProps {
  dispatch: MaskEditDispatch;
  /** The active layer's adjustment (edited in the right column), if any. */
  adjustment: LayerAdjustment | null;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
}

export function AdjustmentsPanel({ dispatch, adjustment, patchAdjustment }: AdjustmentsPanelProps) {
  const t = useT();
  return (
    <div className="mask-panel-body">
      <div className="mask-adjustments-split">
        <div className="mask-adjustments-list">
          {ENTRIES.map(({ key, glyph, type }) => (
            <button
              key={key}
              className={`mask-adjustment-row${type ? "" : " planned"}${type && adjustment?.type === type ? " active" : ""}`}
              title={type ? t("mask.adjustmentAddTitle") : t("mask.adjPlanned")}
              aria-disabled={!type || undefined}
              onClick={() => {
                if (type) dispatch({ type: "layer_add_adjustment", adjType: type });
              }}
            >
              <span className="glyph" aria-hidden="true">{glyph}</span>
              <span className="label">{t(key)}</span>
            </button>
          ))}
        </div>
        <div className="mask-adjustments-detail">
          {adjustment ? (
            <AdjustmentControls adjustment={adjustment} patchAdjustment={patchAdjustment} />
          ) : (
            <small className="muted">{t("mask.adjPickHint")}</small>
          )}
        </div>
      </div>
    </div>
  );
}
