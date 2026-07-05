// Right rail "Layers" panel block: the layer stack (top first).
// The active adjustment layer's parameters live in PropertiesPanel.

import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { generateThumbnail } from "../../bridge/tauri";
import { useT } from "../../i18n";
import type { LayerBlend, MaskLayer } from "../../types/production";
import { LAYER_BLENDS } from "../../types/production";
import { buildLayerThumb } from "../maskMorphology";
import type { MaskEditDispatch } from "./actions";

const LAYER_MIME = "application/x-hgripe-layer";

interface LayersPanelProps {
  layers: readonly MaskLayer[];
  active: number;
  /** Image size (px); the thumbnail replay space. */
  dims: { w: number; h: number };
  /** Backing source image for the base image layer thumbnail. */
  imagePath?: string | null;
  /** Product surface: the image workspace's bottom layer is the image itself,
   * so it keeps the file's name and thumbnail even once it records edits. */
  workspace?: "image" | "mask";
  dispatch: MaskEditDispatch;
  /** Called before any layer switch/removal to drop an in-flight anchor edit. */
  onBeforeLayerChange: () => void;
}

// A real mask thumbnail: the layer's own ops replayed into a tiny grayscale
// surface. It is used for actual edit/mask layers, not for the base image.
function LayerThumb({ layer, dims }: { layer: MaskLayer; dims: { w: number; h: number } }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumb = useMemo(() => buildLayerThumb(layer, dims), [layer.ops, dims]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = thumb.w;
    canvas.height = thumb.h;
    const img = ctx.createImageData(thumb.w, thumb.h);
    for (let i = 0; i < thumb.data.length; i++) {
      const v = thumb.data[i];
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [thumb]);

  return <canvas ref={canvasRef} className="mask-layer-thumb-canvas" aria-hidden="true" />;
}

function BaseImageThumb({ imagePath }: { imagePath: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    generateThumbnail({ path: imagePath, size: 96 })
      .then((thumb) => {
        if (alive) setSrc(thumb.data_url || null);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [imagePath]);

  return src ? (
    <img className="mask-layer-thumb-img" src={src} alt="" draggable={false} />
  ) : (
    <span className="mask-layer-thumb-fallback">IMG</span>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function LayersPanel({ layers, active, dims, imagePath, workspace = "mask", dispatch, onBeforeLayerChange }: LayersPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // PS multi-select: extra selected layers (by id, so reorders keep them)
  // beyond the active one; Ctrl/Alt+click toggles, Shift+click ranges.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const selectedIndices = useMemo(() => {
    const set = new Set<number>();
    layers.forEach((l, i) => {
      if (i === active || selectedIds.has(l.id)) set.add(i);
    });
    return [...set].sort((a, b) => a - b);
  }, [layers, active, selectedIds]);

  const selectRow = (e: MouseEvent, i: number) => {
    const layer = layers[i];
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const next = new Set(selectedIds);
      const activeId = layers[active]?.id;
      if (activeId) next.add(activeId);
      if (next.has(layer.id) && i !== active) {
        next.delete(layer.id);
      } else {
        next.add(layer.id);
        onBeforeLayerChange();
        dispatch({ type: "layer_active", index: i });
      }
      setSelectedIds(next);
      return;
    }
    if (e.shiftKey) {
      const lo = Math.min(active, i);
      const hi = Math.max(active, i);
      setSelectedIds(new Set(layers.slice(lo, hi + 1).map((l) => l.id)));
      return;
    }
    setSelectedIds(new Set());
    onBeforeLayerChange();
    dispatch({ type: "layer_active", index: i });
  };

  const openMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    if (!selectedIndices.includes(i)) {
      setSelectedIds(new Set());
      onBeforeLayerChange();
      dispatch({ type: "layer_active", index: i });
    }
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const mergeable = (indices: number[]) =>
    indices.length >= 2 && indices.every((i) => layers[i]?.kind === "mask" && !layers[i]?.locked);
  const mergeDownIndices = active > 0 ? [active - 1, active] : [];
  const merge = (indices: number[]) => {
    onBeforeLayerChange();
    dispatch({ type: "layer_merge", indices });
    setSelectedIds(new Set());
    setMenu(null);
  };

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
    <div className="mask-panel-body mask-layers-body">
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
          L
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
          const showBaseImage = Boolean(
            imagePath &&
              i === 0 &&
              layer.kind !== "adjustment" &&
              (workspace === "image" || layer.ops.length === 0),
          );
          const displayName =
            showBaseImage && imagePath && layer.name === "Background" ? basename(imagePath) : layer.name;
          return (
            <div
              key={layer.id}
              className={`mask-layer-row${i === active ? " active" : selectedIndices.includes(i) ? " selected" : ""}${layer.visible ? "" : " hidden"}`}
              draggable={renaming !== i && !layer.locked}
              onDragStart={(e) => {
                e.dataTransfer.setData(LAYER_MIME, String(i));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={allowLayerDrop}
              onDrop={(e) => dropOn(e, i)}
              onClick={(e) => selectRow(e, i)}
              onContextMenu={(e) => openMenu(e, i)}
            >
              <button
                className="mask-layer-visible"
                title={layer.visible ? t("mask.layerHide") : t("mask.layerShow")}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "layer_visible", index: i });
                }}
              >
                {layer.visible ? "V" : ""}
              </button>
              <span className="mask-layer-thumb" aria-hidden="true">
                {showBaseImage && imagePath ? (
                  <BaseImageThumb imagePath={imagePath} />
                ) : layer.kind === "adjustment" ? (
                  "ADJ"
                ) : (
                  <LayerThumb layer={layer} dims={dims} />
                )}
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
                  title={showBaseImage && imagePath ? imagePath : layer.name}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (layer.locked) return;
                    setDraft(layer.name);
                    setRenaming(i);
                  }}
                >
                  {displayName}
                </span>
              )}
              {layer.linked ? (
                <span className="mask-layer-linked" title={t("mask.layerLinked")} aria-hidden="true">
                  {t("mask.layerBadgeLink")}
                </span>
              ) : null}
              {layer.locked ? (
                <span className="mask-layer-locked" title={t("mask.layerLocked")} aria-hidden="true">
                  {t("mask.layerBadgeLock")}
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
                x
              </button>
            </div>
          );
        })}
      </div>

      {menu ? (
        <>
          <div className="mask-flyout-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="mask-flyout" style={{ left: menu.x, top: menu.y }} role="menu">
            {selectedIndices.length >= 2 ? (
              <button
                className="mask-flyout-item"
                disabled={!mergeable(selectedIndices)}
                onClick={() => merge(selectedIndices)}
              >
                <span className="label">{t("mask.layerMerge")}</span>
              </button>
            ) : (
              <button
                className="mask-flyout-item"
                disabled={!mergeable(mergeDownIndices)}
                onClick={() => merge(mergeDownIndices)}
              >
                <span className="label">{t("mask.layerMergeDown")}</span>
              </button>
            )}
            <button
              className="mask-flyout-item"
              onClick={() => {
                dispatch({ type: "layer_duplicate" });
                setMenu(null);
              }}
            >
              <span className="label">{t("mask.layerDuplicate")}</span>
            </button>
            <button
              className="mask-flyout-item"
              disabled={layers.length <= 1 || activeLayer?.locked}
              onClick={() => {
                onBeforeLayerChange();
                dispatch({ type: "layer_remove", index: active });
                setSelectedIds(new Set());
                setMenu(null);
              }}
            >
              <span className="label">{t("mask.layerDelete")}</span>
            </button>
          </div>
        </>
      ) : null}

      <div className="mask-layer-actions">
        <button
          className="mask-layer-action"
          title={t("mask.layerInvertTitle")}
          disabled={!activeLayer || activeLayer.locked}
          onClick={() => dispatch({ type: "op", op: { type: "invert" } })}
        >
          {t("mask.layerActionInvert")}
        </button>
        <button
          className={`mask-layer-action${activeLayer?.linked ? " on" : ""}`}
          title={activeLayer?.linked ? t("mask.layerUnlink") : t("mask.layerLink")}
          disabled={!activeLayer}
          onClick={() => dispatch({ type: "layer_link", index: active })}
        >
          {t("mask.layerActionLink")}
        </button>
        <button
          className="mask-layer-action"
          title={t("mask.layerDuplicate")}
          onClick={() => dispatch({ type: "layer_duplicate" })}
        >
          {t("mask.layerActionDup")}
        </button>
        <button className="mask-layer-action" title={t("mask.layerAddTitle")} onClick={() => dispatch({ type: "layer_add" })}>
          +
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
          {t("mask.layerActionDel")}
        </button>
      </div>
    </div>
  );
}
