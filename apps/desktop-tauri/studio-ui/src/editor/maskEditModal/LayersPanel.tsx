// Right rail — "Layers" panel block (M3): the layer stack (top first).
// The active adjustment layer's parameters live in PropertiesPanel.

import { useT } from "../../i18n";
import type { AdjustmentType, LayerBlend, MaskLayer } from "../../types/production";
import type { MaskEditDispatch } from "./actions";

interface LayersPanelProps {
  layers: readonly MaskLayer[];
  active: number;
  dispatch: MaskEditDispatch;
  /** Called before any layer switch/removal to drop an in-flight anchor edit. */
  onBeforeLayerChange: () => void;
}

export function LayersPanel({ layers, active, dispatch, onBeforeLayerChange }: LayersPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
  return (
    <div className="mask-panel-body">
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
    </div>
  );
}
