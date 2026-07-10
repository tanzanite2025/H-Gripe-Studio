// The parameter controls of one adjustment layer (sliders / curve editor),
// shared by the Properties panel and the Adjustments panel's detail column.

import { useState } from "react";
import { useT, type MsgKey } from "../../i18n";
import { type AdjustmentColorRange, type LayerAdjustment } from "../../contracts/maskDocument";
import { CurveEditor } from "./CurveEditor";

const COLOR_RANGES: { range: AdjustmentColorRange; label: MsgKey }[] = [
  { range: "reds", label: "grade.range_reds" },
  { range: "yellows", label: "grade.range_yellows" },
  { range: "greens", label: "grade.range_greens" },
  { range: "cyans", label: "grade.range_cyans" },
  { range: "blues", label: "grade.range_blues" },
  { range: "magentas", label: "grade.range_magentas" },
  { range: "whites", label: "grade.range_whites" },
  { range: "neutrals", label: "grade.range_neutrals" },
  { range: "blacks", label: "grade.range_blacks" },
];

const MIXER_ROWS = [
  { key: "red", label: "mask.channelRed", dflt: [100, 0, 0] },
  { key: "green", label: "mask.channelGreen", dflt: [0, 100, 0] },
  { key: "blue", label: "mask.channelBlue", dflt: [0, 0, 100] },
] as const;
const MIXER_SOURCES: MsgKey[] = ["mask.channelRed", "mask.channelGreen", "mask.channelBlue"];

// RGB + HSL readout values of a `#rrggbb` colour, for the swatch labels.
function colorReadout(hex: string | undefined): string | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    h = (h + 360) % 360;
  }
  return `RGB ${r},${g},${b} · HSL ${Math.round(h)}°,${Math.round(s * 100)}%,${Math.round(l * 100)}%`;
}

interface AdjustmentControlsProps {
  adjustment: LayerAdjustment;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
  /** Arms a one-shot canvas eyedropper; the next canvas click samples into `cb`. */
  requestColorPick?: (cb: (hex: string) => void) => void;
}

export function AdjustmentControls({ adjustment, patchAdjustment, requestColorPick }: AdjustmentControlsProps) {
  const t = useT();
  const [activeRange, setActiveRange] = useState<AdjustmentColorRange>("reds");
  const [picking, setPicking] = useState<"from_color" | "to_color" | null>(null);
  const pickFromImage = (slot: "from_color" | "to_color") => {
    if (!requestColorPick) return;
    setPicking(slot);
    requestColorPick((hex) => {
      setPicking(null);
      patchAdjustment({ [slot]: hex });
    });
  };
  const rangeValues = adjustment.ranges?.find((r) => r.range === activeRange);
  const patchRange = (patch: { hue?: number; saturation?: number; lightness?: number }) => {
    const others = (adjustment.ranges ?? []).filter((r) => r.range !== activeRange);
    patchAdjustment({ ranges: [...others, { range: activeRange, ...rangeValues, ...patch }] });
  };
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
      ) : adjustment.type === "color_ranges" ? (
        <>
          <label className="slider-row">
            <span>{t("mask.adjColorRange")}</span>
            <select
              value={activeRange}
              onChange={(e) => setActiveRange(e.target.value as AdjustmentColorRange)}
            >
              {COLOR_RANGES.map(({ range, label }) => (
                <option key={range} value={range}>{t(label)}</option>
              ))}
            </select>
          </label>
          {(
            [
              ["hue", "grade.range_hue", -180, 180],
              ["saturation", "grade.range_saturation", -100, 100],
              ["lightness", "grade.range_lightness", -100, 100],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key} className="slider-row">
              <span>{t(label)}</span>
              <input
                type="range"
                min={min}
                max={max}
                value={rangeValues?.[key] ?? 0}
                onChange={(e) => patchRange({ [key]: Number(e.target.value) })}
              />
              <output>{rangeValues?.[key] ?? 0}</output>
            </label>
          ))}
          <label className="slider-row">
            <span>{t("grade.monochrome")}</span>
            <input
              type="checkbox"
              checked={adjustment.monochrome ?? false}
              onChange={(e) => patchAdjustment({ monochrome: e.target.checked })}
            />
          </label>
        </>
      ) : adjustment.type === "replace_color" ? (
        <>
          {(
            [
              ["from_color", "mask.adjFromColor", "from"],
              ["to_color", "mask.adjToColor", "to"],
            ] as const
          ).map(([slot, label, kind]) => (
            <div key={slot} className={`replace-color-slot ${kind}`}>
              <div className="replace-color-slot-head">
                <span>{t(label)}</span>
                <button
                  type="button"
                  className={`replace-color-pick${picking === slot ? " picking" : ""}`}
                  title={t("mask.adjPickFromImage")}
                  disabled={!requestColorPick}
                  onClick={() => pickFromImage(slot)}
                >
                  {picking === slot ? t("mask.adjPicking") : t("mask.adjEyedropper")}
                </button>
              </div>
              <div className="replace-color-slot-body">
                <input
                  type="color"
                  className="replace-color-swatch"
                  value={adjustment[slot] ?? "#808080"}
                  onChange={(e) => patchAdjustment({ [slot]: e.target.value })}
                />
                <small className="muted">{colorReadout(adjustment[slot]) ?? "\u2014"}</small>
              </div>
            </div>
          ))}
          {(
            [
              ["fuzziness", "mask.adjFuzziness", 40],
              ["strength", "mask.adjStrength", 100],
            ] as const
          ).map(([key, label, dflt]) => (
            <label key={key} className="slider-row">
              <span>{t(label)}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={adjustment[key] ?? dflt}
                onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
              />
              <output>{adjustment[key] ?? dflt}%</output>
            </label>
          ))}
          <small className="muted">{t("mask.replaceColorHint")}</small>
        </>
      ) : adjustment.type === "channel_mixer" ? (
        <>
          {MIXER_ROWS.map(({ key, label, dflt }) => (
            <div key={key}>
              <small className="muted">{t(label)}</small>
              {MIXER_SOURCES.map((src, i) => (
                <label key={src} className="slider-row">
                  <span>{t(src)}</span>
                  <input
                    type="range"
                    min={-200}
                    max={200}
                    value={adjustment[key]?.[i] ?? dflt[i]}
                    onChange={(e) => {
                      const row = [...(adjustment[key] ?? dflt)] as [number, number, number];
                      row[i] = Number(e.target.value);
                      patchAdjustment({ [key]: row });
                    }}
                  />
                  <output>{adjustment[key]?.[i] ?? dflt[i]}%</output>
                </label>
              ))}
            </div>
          ))}
          <label className="slider-row">
            <span>{t("grade.monochrome")}</span>
            <input
              type="checkbox"
              checked={adjustment.monochrome ?? false}
              onChange={(e) => patchAdjustment({ monochrome: e.target.checked })}
            />
          </label>
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
