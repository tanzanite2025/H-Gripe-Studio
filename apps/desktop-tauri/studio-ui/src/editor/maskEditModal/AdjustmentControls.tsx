// The parameter controls of one adjustment layer (sliders / curve editor),
// shared by the Properties panel and the Adjustments panel's detail column.

import { useT } from "../../i18n";
import type { LayerAdjustment } from "../../types/production";
import { CurveEditor } from "./CurveEditor";

interface AdjustmentControlsProps {
  adjustment: LayerAdjustment;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
}

export function AdjustmentControls({ adjustment, patchAdjustment }: AdjustmentControlsProps) {
  const t = useT();
  return (
    <>
      {adjustment.type === "levels" ? (
        (
          [
            ["in_black", "mask.adjInBlack", 0, 255, 1, 0],
            ["in_white", "mask.adjInWhite", 0, 255, 1, 255],
            ["gamma", "mask.adjGamma", 0.1, 3, 0.05, 1],
            ["out_black", "mask.adjOutBlack", 0, 255, 1, 0],
            ["out_white", "mask.adjOutWhite", 0, 255, 1, 255],
          ] as const
        ).map(([key, label, min, max, step, dflt]) => (
          <label key={key} className="slider-row">
            <span>{t(label)}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={adjustment[key] ?? dflt}
              onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
            />
            <output>{adjustment[key] ?? dflt}</output>
          </label>
        ))
      ) : adjustment.type === "curve" ? (
        <>
          <CurveEditor points={adjustment.points} onChange={(points) => patchAdjustment({ points })} />
          <small className="muted">{t("mask.curveHint")}</small>
        </>
      ) : (
        (
          [
            ["brightness", "mask.adjBrightness"],
            ["contrast", "mask.adjContrast"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="slider-row">
            <span>{t(label)}</span>
            <input
              type="range"
              min={-100}
              max={100}
              value={adjustment[key] ?? 0}
              onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
            />
            <output>{adjustment[key] ?? 0}</output>
          </label>
        ))
      )}
      <small className="muted">{t("mask.adjustmentHint")}</small>
    </>
  );
}
