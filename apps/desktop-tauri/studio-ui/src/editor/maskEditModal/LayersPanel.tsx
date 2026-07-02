// Right rail — "Layers" panel block (M3): the layer stack (top first).
// The active adjustment layer's parameters live in PropertiesPanel.

import { useState, type DragEvent } from "react";
import { useT } from "../../i18n";
import type { AdjustmentType, LayerBlend, MaskLayer } from "../../types/production";
import { LAYER_BLENDS } from "../../types/production";
import type { MaskEditDispatch } from "./actions";

const LAYER_MIME = "application/x-hgripe-layer";

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
  // PS double-click rename: the stack index being renamed + the draft text.
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (renaming != null) dispatch({ type: "layer_rename", index: renaming, name: draft });
    setRenaming(null);
  };
  const allowLayerDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(LAYER_MIME)) e.preventDefault();
  };
  const dropOn = (e: DragEvent, to: number) => {
    const from = Number(e.dataTransfer.getData(LAYER_MIME));
    if (!Number.isInteger(from)) return;
    e.preventDefault();
    dispatch({ type: "layer_move", from, to });
  };

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
          {LAYER_BLENDS.map((blend) => (
            <option key={blend} value={blend}>
              {t(`mask.blend.${blend}`)}
            </option>
          ))}
        </select>
        <button
          className={`mask-layer-lock${activeLayer?.locked ? " locked" : ""}`}
          title={activeLayer?.locked ? t("mask.layerUnlock") : t("mask.layerLock")}
          disabled={!activeLayer}
          onClick={() => dispatch({ type: "layer_lock", index: active })}
        >
          🔒
        </button>
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
              draggable={renaming !== i && !layer.locked}
              onDragStart={(e) => {
                e.dataTransfer.setData(LAYER_MIME, String(i));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={allowLayerDrop}
              onDrop={(e) => dropOn(e, i)}
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
              {renaming === i ? (
                <input
                  className="mask-layer-rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="mask-layer-name"
                  title={layer.name}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (layer.locked) return;
                    setDraft(layer.name);
                    setRenaming(i);
                  }}
                >
                  {layer.name}
                </span>
              )}
              {layer.locked ? (
                <span className="mask-layer-locked" title={t("mask.layerLocked")} aria-hidden="true">
                  🔒
                </span>
              ) : null}
              <button
                className="mask-layer-delete"
                title={t("mask.layerDelete")}
                disabled={layers.length <= 1 || layer.locked}
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
      {/* PS bottom action bar: icon buttons on the right edge of the panel. */}
      <div className="mask-layer-actions">
        <select
          className="mask-layer-adjustment-add"
          value=""
          title={t("mask.adjustmentAddTitle")}
          onChange={(e) => {
            const adjType = e.target.value as AdjustmentType | "";
            if (adjType) dispatch({ type: "layer_add_adjustment", adjType });
          }}
        >
          <option value="" disabled>
            ◐
          </option>
          <option value="levels">{t("mask.adjLevels")}</option>
          <option value="curve">{t("mask.adjCurve")}</option>
          <option value="brightness_contrast">{t("mask.adjBrightnessContrast")}</option>
        </select>
        <button
          className="mask-layer-action"
          title={t("mask.layerDuplicate")}
          onClick={() => dispatch({ type: "layer_duplicate" })}
        >
          ⧉
        </button>
        <button className="mask-layer-action" title={t("mask.layerAddTitle")} onClick={() => dispatch({ type: "layer_add" })}>
          ⊞
        </button>
        <button
          className="mask-layer-action"
          title={t("mask.layerDelete")}
          disabled={layers.length <= 1 || activeLayer?.locked}
          onClick={() => {
            onBeforeLayerChange();
            dispatch({ type: "layer_remove", index: active });
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}
