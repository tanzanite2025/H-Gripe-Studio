// Right rail — "Layers" panel block (M3): the layer stack (top first) plus
// the active adjustment layer's properties.

import { useT } from "../../i18n";
import type { AdjustmentType, LayerAdjustment, LayerBlend, MaskLayer } from "../../types/production";
import type { MaskEditDispatch } from "./actions";

interface LayersPanelProps {
  layers: readonly MaskLayer[];
  active: number;
  dispatch: MaskEditDispatch;
  /** Called before any layer switch/removal to drop an in-flight anchor edit. */
  onBeforeLayerChange: () => void;
  activeAdjustment: LayerAdjustment | null;
  patchAdjustment: (patch: Partial<LayerAdjustment>) => void;
  curveY: (slot: 0 | 1 | 2) => number;
  setCurveY: (slot: 0 | 1 | 2, y: number) => void;
}

export function LayersPanel({
  layers,
  active,
  dispatch,
  onBeforeLayerChange,
  activeAdjustment,
  patchAdjustment,
  curveY,
  setCurveY,
}: LayersPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
  return (
    <section className="mask-panel">
      <header>{t("mask.layers", { count: layers.length })}</header>
      {/* PS-style panel head: blend mode + opacity act on the active layer. */}
      <div className="mask-layer-head">
        <select
          className="mask-layer-blend"
          value={activeLayer?.kind === "adjustment" ? "normal" : (activeLayer?.blend ?? "normal")}
          disabled={!activeLayer || activeLayer.kind === "adjustment"}
          title={t("mask.layerBlend")}
          onChange={(e) => dispatch({ type: "layer_blend", index: active, blend: e.target.value as LayerBlend })}
        >
          <option value="normal">{t("mask.blendNormal")}</option>
          <option value="multiply">{t("mask.blendMultiply")}</option>
          <option value="screen">{t("mask.blendScreen")}</option>
        </select>
        <label className="mask-layer-opacity-label">
          <span className="muted">{t("mask.layerOpacity")}</span>
          <input
            className="mask-layer-opacity"
            type="number"
            min={0}
            max={100}
            value={activeLayer ? Math.round(activeLayer.opacity * 100) : 100}
            disabled={!activeLayer}
            title={t("mask.layerOpacity")}
            onChange={(e) => dispatch({ type: "layer_opacity", index: active, opacity: Number(e.target.value) / 100 })}
          />
        </label>
      </div>
      <div className="mask-layer-list">
        {[...layers].map((_, ri) => layers.length - 1 - ri).map((i) => {
          const layer = layers[i];
          return (
            <div
              key={layer.id}
              className={`mask-layer-row${i === active ? " active" : ""}${layer.visible ? "" : " hidden"}`}
              onClick={() => {
                onBeforeLayerChange();
                dispatch({ type: "layer_active", index: i });
              }}
            >
              <button
                className="mask-layer-visible"
                title={layer.visible ? t("mask.layerHide") : t("mask.layerShow")}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "layer_visible", index: i });
                }}
              >
                {layer.visible ? "👁" : ""}
              </button>
              <span className="mask-layer-thumb" aria-hidden="true">
                {layer.kind === "adjustment" ? "◐" : ""}
              </span>
              <span className="mask-layer-name" title={layer.name}>
                {layer.name}
              </span>
              <button
                className="mask-layer-delete"
                title={t("mask.layerDelete")}
                disabled={layers.length <= 1}
                onClick={(e) => {
                  e.stopPropagation();
                  onBeforeLayerChange();
                  dispatch({ type: "layer_remove", index: i });
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="mask-layer-actions">
        <button onClick={() => dispatch({ type: "layer_add" })} title={t("mask.layerAddTitle")}>
          + {t("mask.layerAdd")}
        </button>
        <select
          className="mask-layer-blend"
          value=""
          title={t("mask.adjustmentAddTitle")}
          onChange={(e) => {
            const adjType = e.target.value as AdjustmentType | "";
            if (adjType) dispatch({ type: "layer_add_adjustment", adjType });
          }}
        >
          <option value="" disabled>
            ◐ {t("mask.adjustmentAdd")}
          </option>
          <option value="levels">{t("mask.adjLevels")}</option>
          <option value="curve">{t("mask.adjCurve")}</option>
          <option value="brightness_contrast">{t("mask.adjBrightnessContrast")}</option>
        </select>
      </div>

      {activeAdjustment ? (
        <div className="field mask-preview-actions">
          <span>
            {t(
              activeAdjustment.type === "levels"
                ? "mask.adjLevels"
                : activeAdjustment.type === "curve"
                  ? "mask.adjCurve"
                  : "mask.adjBrightnessContrast",
            )}{" "}
            <span className="muted">· {t("mask.adjustmentBadge")}</span>
          </span>
          {activeAdjustment.type === "levels" ? (
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
                  value={activeAdjustment[key] ?? dflt}
                  onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
                />
                <output>{activeAdjustment[key] ?? dflt}</output>
              </label>
            ))
          ) : activeAdjustment.type === "curve" ? (
            (
              [
                [0, "mask.adjShadows"],
                [1, "mask.adjMidtones"],
                [2, "mask.adjHighlights"],
              ] as const
            ).map(([slot, label]) => (
              <label key={slot} className="slider-row">
                <span>{t(label)}</span>
                <input
                  type="range"
                  min={0}
                  max={255}
                  value={curveY(slot)}
                  onChange={(e) => setCurveY(slot, Number(e.target.value))}
                />
                <output>{curveY(slot)}</output>
              </label>
            ))
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
                  value={activeAdjustment[key] ?? 0}
                  onChange={(e) => patchAdjustment({ [key]: Number(e.target.value) })}
                />
                <output>{activeAdjustment[key] ?? 0}</output>
              </label>
            ))
          )}
          <small className="muted">{t("mask.adjustmentHint")}</small>
        </div>
      ) : null}
    </section>
  );
}
