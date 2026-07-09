// Right rail "Layers" panel block: the layer stack (top first).
// The active adjustment layer's parameters live in PropertiesPanel.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { generateThumbnail } from "../../bridge/tauri";
import { useT } from "../../i18n";
import type { LayerBlend, LayerGroup, LayerTargetKind, MaskDocument, MaskLayer } from "../../types/production";
import { LAYER_BLENDS } from "../../types/production";
import { hasSourceImageContent, LAYER_GROUP_COLORS, SOURCE_IMAGE_OP_TYPE } from "../maskEdit";
import { runMaskEditorCommand } from "../maskEditorCommandRunner";
import { buildLayerThumb } from "../maskMorphology";
import { getCommand, getCommandCapability, type CommandId } from "../studioCommands";
import type { StudioTarget } from "../studioTarget";
import { imageLayerHasSourceContent } from "../imageCompositeSource";
import type { MaskEditDispatch } from "./actions";

const LAYER_MIME = "application/x-hgripe-layer";
const MAX_THUMBNAIL_CACHE = 64;
const thumbnailCache = new Map<string, Promise<string | null>>();

interface LayersPanelProps {
  doc: MaskDocument;
  layers: readonly MaskLayer[];
  layerGroups: readonly LayerGroup[];
  active: number;
  /** Which attachment of the active layer receives new edits (PS: the
   * highlighted content / mask thumbnail). */
  activeTarget: LayerTargetKind;
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

function loadLayerThumbnail(imagePath: string, size = 96): Promise<string | null> {
  const key = `${size}:${imagePath}`;
  let cached = thumbnailCache.get(key);
  if (!cached) {
    cached = generateThumbnail({ path: imagePath, size })
      .then((thumb) => thumb.data_url || null)
      .catch(() => {
        thumbnailCache.delete(key);
        return null;
      });
    thumbnailCache.set(key, cached);
    while (thumbnailCache.size > MAX_THUMBNAIL_CACHE) {
      const oldest = thumbnailCache.keys().next().value;
      if (!oldest) break;
      thumbnailCache.delete(oldest);
    }
  }
  return cached;
}

// A real mask thumbnail: the layer's own ops replayed into a tiny grayscale
// surface. It is used for actual edit/mask layers, not for the base image.
function LayerThumb({ layer, dims }: { layer: MaskLayer; dims: { w: number; h: number } }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumb = useMemo(() => buildLayerThumb(layer, dims), [layer, dims.w, dims.h]);

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
    loadLayerThumbnail(imagePath).then((thumb) => {
      if (alive) setSrc(thumb);
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

function SourceImageLayerThumb({
  imagePath,
  layer,
  dims,
  implicitSource = false,
}: {
  imagePath: string;
  layer: MaskLayer;
  dims: { w: number; h: number };
  implicitSource?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const thumbLayer = useMemo<MaskLayer>(() => {
    if (!implicitSource || hasSourceImageContent(layer)) return layer;
    return { ...layer, ops: [{ type: SOURCE_IMAGE_OP_TYPE }, ...layer.ops] };
  }, [implicitSource, layer]);
  const thumb = useMemo(() => buildLayerThumb(thumbLayer, dims), [thumbLayer, dims.w, dims.h]);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    loadLayerThumbnail(imagePath).then((thumb) => {
      if (alive) setSrc(thumb);
    });
    return () => {
      alive = false;
    };
  }, [imagePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = thumb.w;
    canvas.height = thumb.h;
    ctx.clearRect(0, 0, thumb.w, thumb.h);
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      ctx.clearRect(0, 0, thumb.w, thumb.h);
      ctx.drawImage(img, 0, 0, thumb.w, thumb.h);
      try {
        const pixels = ctx.getImageData(0, 0, thumb.w, thumb.h);
        for (let i = 0; i < thumb.data.length; i++) {
          pixels.data[i * 4 + 3] = Math.round((pixels.data[i * 4 + 3] * thumb.data[i]) / 255);
        }
        ctx.putImageData(pixels, 0, 0);
      } catch {
        ctx.clearRect(0, 0, thumb.w, thumb.h);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, thumb]);

  return src ? (
    <canvas ref={canvasRef} className="mask-layer-thumb-canvas" aria-hidden="true" />
  ) : (
    <span className="mask-layer-thumb-fallback">IMG</span>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const GROUP_SPLIT = /[,;\n\uFF0C\uFF1B]+/;

function groupNamesFromDraft(draft: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of draft.split(GROUP_SPLIT)) {
    const name = raw.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function newLayerGroupId(): string {
  return `group-${Math.random().toString(36).slice(2, 10)}`;
}

function groupsFromDraft(draft: string, current: readonly LayerGroup[]): LayerGroup[] {
  const existingNames = new Set(current.map((group) => group.name.toLocaleLowerCase()));
  const additions = groupNamesFromDraft(draft)
    .filter((name) => !existingNames.has(name.toLocaleLowerCase()))
    .map((name, index) => {
      const colorIndex = current.length + index;
      return {
        id: newLayerGroupId(),
        name,
        color: LAYER_GROUP_COLORS[colorIndex % LAYER_GROUP_COLORS.length],
      };
    });
  return [...current, ...additions];
}

function groupStyle(group: LayerGroup): CSSProperties {
  return { "--mask-layer-group-color": group.color } as CSSProperties;
}

function LayerActionIcon({ icon }: { icon: "invert" | "link" | "mask" | "duplicate" | "add" | "delete" }) {
  if (icon === "invert") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
      </svg>
    );
  }
  if (icon === "link") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6.6 5.1 5.2 3.7a3 3 0 0 0-4.2 4.2l1.7 1.7a3 3 0 0 0 4.2 0l.7-.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="m9.4 10.9 1.4 1.4a3 3 0 0 0 4.2-4.2l-1.7-1.7a3 3 0 0 0-4.2 0l-.7.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="m5.8 10.2 4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "mask") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="3" fill="currentColor" />
      </svg>
    );
  }
  if (icon === "duplicate") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 3h5.8c.7 0 1.2.5 1.2 1.2V10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "add") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M5 6v6.5c0 .7.5 1.2 1.2 1.2h3.6c.7 0 1.2-.5 1.2-1.2V6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LayersPanel({ doc, layers, layerGroups, active, activeTarget, dims, imagePath, workspace = "mask", dispatch, onBeforeLayerChange }: LayersPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [groupDraft, setGroupDraft] = useState("");
  // PS multi-select: extra selected layers (by id, so reorders keep them)
  // beyond the active one; Ctrl/Alt+click toggles, Shift+click ranges.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const activeStudioTarget = useMemo<StudioTarget | null>(() => {
    if (!activeLayer) return null;
    const ref = { canvasId: "mask-edit-stage", documentId: imagePath ?? "active-document" };
    if (activeTarget === "mask" && activeLayer.mask) {
      return { kind: "layer_mask", ...ref, layerId: activeLayer.id, maskId: activeLayer.mask.id };
    }
    return { kind: "pixel_layer", ...ref, layerId: activeLayer.id };
  }, [activeLayer, activeTarget, imagePath]);
  const commandCapability = (id: CommandId) =>
    activeStudioTarget ? getCommandCapability(id, { doc, target: activeStudioTarget }) : { enabled: false, reason: "no active target" };

  const groupById = useMemo(() => new Map(layerGroups.map((group) => [group.id, group])), [layerGroups]);

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

  // PS thumbnails: clicking the content / mask thumbnail activates that
  // attachment as the edit target (the document stores it explicitly).
  const selectTarget = (e: MouseEvent, i: number, target: LayerTargetKind) => {
    e.stopPropagation();
    setSelectedIds(new Set());
    onBeforeLayerChange();
    dispatch({ type: "layer_active", index: i });
    if (target === "mask") dispatch({ type: "target_active", target });
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

  const commitGroups = () => {
    if (!groupDraft.trim()) return;
    dispatch({ type: "layer_groups", groups: groupsFromDraft(groupDraft, layerGroups) });
    setGroupDraft("");
  };

  const removeGroup = (groupId: string) => {
    dispatch({ type: "layer_groups", groups: layerGroups.filter((group) => group.id !== groupId) });
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

  const invertCommand: CommandId = activeTarget === "mask" ? "mask.invert" : "layer.invert";
  const deleteCommand: CommandId = activeTarget === "mask" ? "mask.delete" : "target.delete";
  const invertCapability = commandCapability(invertCommand);
  const linkCapability = commandCapability("layer.link");
  const addMaskCapability = commandCapability("layer.addMask");
  const duplicateCapability = commandCapability("layer.duplicate");
  const addLayerCapability = commandCapability("layer.add");
  const deleteCapability = commandCapability(deleteCommand);
  const titleFor = (id: CommandId, reason?: string) => {
    const title = t(getCommand(id).titleKey);
    return reason ? `${title} - ${reason}` : title;
  };
  const runLayerCommand = (id: CommandId) => {
    if (!activeStudioTarget) return;
    runMaskEditorCommand(id, {
      doc,
      target: activeStudioTarget,
      dispatch,
      beforeStructuralChange: onBeforeLayerChange,
      includeSourceImage: workspace === "image",
    });
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

      <div className="mask-layer-groups">
        <label className="mask-layer-groups-label">
          <span className="muted">{t("mask.layerGroupsLabel")}</span>
          <input
            className="mask-layer-groups-input"
            value={groupDraft}
            placeholder={t("mask.layerGroupsPlaceholder")}
            title={t("mask.layerGroupsTitle")}
            onChange={(e) => setGroupDraft(e.target.value)}
            onBlur={commitGroups}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setGroupDraft("");
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        <div className="mask-layer-group-chips" aria-label={t("mask.layerGroupsLabel")}>
          {layerGroups.map((group) => (
            <span key={group.id} className="mask-layer-group-chip" style={groupStyle(group)} title={group.name}>
              <span className="mask-layer-group-swatch" aria-hidden="true" />
              <span className="mask-layer-group-name">{group.name}</span>
              <button
                className="mask-layer-group-delete"
                title={t("mask.layerGroupDelete")}
                onClick={(e) => {
                  e.stopPropagation();
                  removeGroup(group.id);
                }}
              >
                x
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="mask-layer-list">
        {[...layers].map((_, ri) => layers.length - 1 - ri).map((i) => {
          const layer = layers[i];
          const group = layer.groupId ? groupById.get(layer.groupId) : undefined;
          // The image workspace's pixel layers can draw the backing image:
          // the bottom layer implicitly, and source_image copies explicitly.
          const showSourceImage = Boolean(
              imagePath &&
              workspace === "image" &&
              imageLayerHasSourceContent(layer, i),
          );
          const showPlainBaseImage = Boolean(
            imagePath &&
              layer.kind !== "adjustment" &&
              ((workspace === "image" && i === 0 && !layer.mask && layer.ops.length === 0) ||
                (workspace !== "image" && i === 0 && layer.ops.length === 0)),
          );
          const displayName =
            showSourceImage && imagePath && layer.name === "Background" ? basename(imagePath) : layer.name;
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
              <span className="mask-layer-group-cell">
                <select
                  className={`mask-layer-group-select${group ? " has-group" : ""}`}
                  value={group?.id ?? ""}
                  disabled={layerGroups.length === 0}
                  title={group ? group.name : t("mask.layerNoGroup")}
                  style={group ? groupStyle(group) : undefined}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => dispatch({ type: "layer_group", index: i, groupId: e.target.value || null })}
                >
                  <option value="">{t("mask.layerNoGroupShort")}</option>
                  {layerGroups.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </span>
              <button
                className={`mask-layer-thumb${i === active && activeTarget === "pixel" ? " target" : ""}`}
                title={t("mask.pixelThumbTitle")}
                onClick={(e) => selectTarget(e, i, "pixel")}
              >
                {showPlainBaseImage && imagePath ? (
                  <BaseImageThumb imagePath={imagePath} />
                ) : showSourceImage && imagePath ? (
                  <SourceImageLayerThumb imagePath={imagePath} layer={layer} dims={dims} implicitSource={i === 0} />
                ) : layer.kind === "adjustment" ? (
                  "ADJ"
                ) : (
                  <LayerThumb layer={layer} dims={dims} />
                )}
              </button>
              {layer.mask ? (
                <>
                  <button
                    className={`mask-layer-mask-link${layer.mask.unlinked ? "" : " on"}`}
                    title={layer.mask.unlinked ? t("mask.maskLinkOff") : t("mask.maskLinkOn")}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "layer_mask_link", index: i });
                    }}
                  >
                    {t("mask.layerBadgeLink")}
                  </button>
                  <button
                    className={`mask-layer-thumb mask-thumb${i === active && activeTarget === "mask" ? " target" : ""}${layer.mask.disabled ? " off" : ""}`}
                    title={layer.mask.disabled ? t("mask.maskDisabledBadge") : t("mask.maskThumbTitle")}
                    onClick={(e) => selectTarget(e, i, "mask")}
                  >
                    <LayerThumb layer={{ ...layer, ops: layer.mask.ops }} dims={dims} />
                  </button>
                </>
              ) : (
                // Reserved mask slot so rows do not jump; click attaches a mask.
                <button
                  className="mask-layer-thumb mask-thumb empty"
                  title={t("mask.maskAdd")}
                  disabled={layer.kind === "adjustment" || layer.locked}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBeforeLayerChange();
                    dispatch({ type: "layer_mask_add", index: i });
                  }}
                >
                  +
                </button>
              )}
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
                  title={showSourceImage && imagePath ? imagePath : layer.name}
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
                dispatch({
                  type: "layer_duplicate",
                  ...(workspace === "image" ? { includeSourceImage: true } : null),
                });
                setMenu(null);
              }}
            >
              <span className="label">{t("mask.layerDuplicate")}</span>
            </button>
            {activeLayer?.mask ? (
              <>
                <button
                  className="mask-flyout-item"
                  onClick={() => {
                    dispatch({ type: "layer_mask_disable", index: active });
                    setMenu(null);
                  }}
                >
                  <span className="label">{activeLayer.mask.disabled ? t("mask.maskEnable") : t("mask.maskDisable")}</span>
                </button>
                <button
                  className="mask-flyout-item"
                  disabled={activeLayer.locked}
                  onClick={() => {
                    onBeforeLayerChange();
                    dispatch({ type: "layer_mask_remove", index: active });
                    setMenu(null);
                  }}
                >
                  <span className="label">{t("mask.maskDelete")}</span>
                </button>
              </>
            ) : (
              <button
                className="mask-flyout-item"
                disabled={!activeLayer || activeLayer.kind === "adjustment" || activeLayer.locked}
                onClick={() => {
                  onBeforeLayerChange();
                  dispatch({ type: "layer_mask_add", index: active });
                  setMenu(null);
                }}
              >
                <span className="label">{t("mask.maskAdd")}</span>
              </button>
            )}
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
          title={titleFor(invertCommand, invertCapability.reason)}
          aria-label={titleFor(invertCommand, invertCapability.reason)}
          disabled={!invertCapability.enabled}
          onClick={() => runLayerCommand(invertCommand)}
        >
          <LayerActionIcon icon="invert" />
        </button>
        <button
          className={`mask-layer-action${activeLayer?.linked ? " on" : ""}`}
          title={linkCapability.reason ? `${activeLayer?.linked ? t("mask.layerUnlink") : t("mask.layerLink")} - ${linkCapability.reason}` : activeLayer?.linked ? t("mask.layerUnlink") : t("mask.layerLink")}
          aria-label={linkCapability.reason ? `${activeLayer?.linked ? t("mask.layerUnlink") : t("mask.layerLink")} - ${linkCapability.reason}` : activeLayer?.linked ? t("mask.layerUnlink") : t("mask.layerLink")}
          disabled={!linkCapability.enabled}
          onClick={() => runLayerCommand("layer.link")}
        >
          <LayerActionIcon icon="link" />
        </button>
        <button
          className="mask-layer-action"
          title={titleFor("layer.addMask", addMaskCapability.reason)}
          aria-label={titleFor("layer.addMask", addMaskCapability.reason)}
          disabled={!addMaskCapability.enabled}
          onClick={() => runLayerCommand("layer.addMask")}
        >
          <LayerActionIcon icon="mask" />
        </button>
        <button
          className="mask-layer-action"
          title={titleFor("layer.duplicate", duplicateCapability.reason)}
          aria-label={titleFor("layer.duplicate", duplicateCapability.reason)}
          disabled={!duplicateCapability.enabled}
          onClick={() => runLayerCommand("layer.duplicate")}
        >
          <LayerActionIcon icon="duplicate" />
        </button>
        <button
          className="mask-layer-action"
          title={titleFor("layer.add", addLayerCapability.reason)}
          aria-label={titleFor("layer.add", addLayerCapability.reason)}
          disabled={!addLayerCapability.enabled}
          onClick={() => runLayerCommand("layer.add")}
        >
          <LayerActionIcon icon="add" />
        </button>
        <button
          className="mask-layer-action"
          title={titleFor(deleteCommand, deleteCapability.reason)}
          aria-label={titleFor(deleteCommand, deleteCapability.reason)}
          disabled={!deleteCapability.enabled}
          onClick={() => runLayerCommand(deleteCommand)}
        >
          <LayerActionIcon icon="delete" />
        </button>
      </div>
    </div>
  );
}
