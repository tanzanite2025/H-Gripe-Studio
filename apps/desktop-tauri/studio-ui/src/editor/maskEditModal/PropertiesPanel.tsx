// Right rail — "Properties" panel (PS's 属性): parameters of the active
// adjustment layer; an empty hint when the active layer has none.

import { useT } from "../../i18n";
import type { LayerAdjustment } from "../../types/production";
import { AdjustmentControls } from "./AdjustmentControls";

interface PropertiesPanelProps {
  adjustment: LayerAdjustment | null;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
}

export function PropertiesPanel({ adjustment, patchAdjustment }: PropertiesPanelProps) {
  const t = useT();
  if (!adjustment) {
    return (
      <div className="mask-panel-body">
        <small className="muted mask-edit-note">{t("mask.propsEmpty")}</small>
      </div>
    );
  }
  return (
    <div className="mask-panel-body">
      <div className="field mask-preview-actions">
        <span>
          {t(
            adjustment.type === "levels"
              ? "mask.adjLevels"
              : adjustment.type === "curve"
                ? "mask.adjCurve"
                : "mask.adjBrightnessContrast",
          )}{" "}
          <span className="muted">· {t("mask.adjustmentBadge")}</span>
        </span>
        <AdjustmentControls adjustment={adjustment} patchAdjustment={patchAdjustment} />
      </div>
    </div>
  );
}
