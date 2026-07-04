import { useRef, useState } from "react";
import { useT } from "../i18n";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW, panView, zoomViewAt, type ViewportViewState } from "../viewport/view";
import type { LayerCandidate, LayeredImageAsset } from "./layeredImage";

export interface LayerReviewPanelProps {
  asset: LayeredImageAsset;
  /** Layer currently selected as the production target, or null = whole asset. */
  selectedLayerId: string | null;
  /** Select a layer (`image_layer` target) or null to reselect the whole asset. */
  onSelectLayer: (layerId: string | null) => void;
  /** Per-layer visibility overrides on top of each candidate's own flag. */
  visibility: Record<string, boolean>;
  onToggleVisibility: (layerId: string) => void;
  /**
   * Merge the checked (unlocked) layers into one. Omitted when merging is
   * unavailable (browser preview has no backend to union the masks).
   */
  onMergeLayers?: (layerIds: string[]) => void;
  /**
   * Split the selected (unlocked) layer into its connected components.
   * Omitted when splitting is unavailable (browser preview has no backend).
   */
  onSplitLayer?: (layerId: string) => void;
  /**
   * Mark / unmark an (unlocked) layer as protected so downstream edits keep
   * its pixels. Omitted when the asset is read-only.
   */
  onToggleProtected?: (layerId: string) => void;
}

function layerVisible(layer: LayerCandidate, visibility: Record<string, boolean>): boolean {
  return visibility[layer.id] ?? layer.visible;
}

/**
 * Preview of the current review target: the selected layer's RGBA cutout
 * (toggleable to its mask) or the asset's composite when the whole asset is
 * targeted. Presentation flows through the viewport host by resource
 * reference — the artifact path is registered, an `image_edit` viewport
 * renders it, and the raw pixels never enter webview state. The browser
 * preview (no resource registry) shows a text placeholder instead.
 */
function LayerPreview({ asset, layer }: { asset: LayeredImageAsset; layer: LayerCandidate | null }) {
  const t = useT();
  const [showMask, setShowMask] = useState(false);
  const path = layer
    ? showMask
      ? layer.mask.path
      : layer.rgba?.path ?? layer.mask.path
    : asset.preview_composite.path;
  // Zoom/pan is viewport state, shared across layer/mask flips so an
  // inspected region stays framed while comparing candidates.
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { underlay, settled } = useViewportUnderlay("image_edit", path, 320, view);

  const handleWheel = (e: React.WheelEvent) => {
    if (!underlay) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const fx = rect && rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const fy = rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    setView((v) => zoomViewAt(v, e.deltaY < 0 ? 1.25 : 0.8, fx, fy));
  };
  const handlePointerDown = (e: React.PointerEvent) => {
    if (view.zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => panView(v, dx, dy, rect.width, rect.height));
  };
  const handlePointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="layer-review-preview">
      <div
        className="layer-review-preview-stage"
        title={path}
        ref={stageRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => setView(IDENTITY_VIEW)}
        style={view.zoom > 1 ? { cursor: dragRef.current ? "grabbing" : "grab" } : undefined}
      >
        {underlay ? (
          <img
            className="layer-review-preview-img"
            src={underlay}
            alt={layer?.name ?? "composite"}
            draggable={false}
          />
        ) : (
          <span className="layer-review-preview-empty">
            {settled ? t("layers.previewUnavailable") : "…"}
          </span>
        )}
      </div>
      {layer ? (
        <button
          className="layer-review-preview-toggle"
          onClick={() => setShowMask((v) => !v)}
          title={t("layers.previewToggleTitle")}
          aria-pressed={showMask}
        >
          {showMask ? t("layers.previewMask") : t("layers.previewLayer")}
          {view.zoom > 1 ? <span className="muted"> · {Math.round(view.zoom * 100)}%</span> : null}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Minimal layer review list (IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Review
 * Editor stage 1): consumes a `LayeredImageAsset` — today the smartLayerSplit
 * stub — and lets the user select the whole asset or one candidate layer as
 * the unified production target, toggle candidate visibility, preview the
 * selected layer's RGBA / mask, and read the split report's warnings.
 */
export function LayerReviewPanel({
  asset,
  selectedLayerId,
  onSelectLayer,
  visibility,
  onToggleVisibility,
  onMergeLayers,
  onSplitLayer,
  onToggleProtected,
}: LayerReviewPanelProps) {
  const t = useT();
  const [checked, setChecked] = useState<string[]>([]);
  // Drop stale ids when the asset's layer set changes (e.g. after a merge).
  const layerIds = new Set(asset.layers.map((layer) => layer.id));
  const validChecked = checked.filter((id) => layerIds.has(id));
  const toggleChecked = (layerId: string) =>
    setChecked((ids) =>
      ids.includes(layerId) ? ids.filter((id) => id !== layerId) : [...ids, layerId],
    );
  const issuesByLayer = new Map<string, number>();
  for (const issue of asset.split_report.suggested_review) {
    issuesByLayer.set(issue.layer_id, (issuesByLayer.get(issue.layer_id) ?? 0) + 1);
  }

  return (
    <div className="layer-review">
      <div className="layer-review-head">
        <h3>{t("layers.title")}</h3>
        <span className="layer-review-engine" title={asset.split_report.engine_version}>
          {asset.split_report.engine_version}
        </span>
      </div>
      <LayerPreview
        asset={asset}
        layer={asset.layers.find((layer) => layer.id === selectedLayerId) ?? null}
      />
      <ul className="layer-review-list">
        <li className={selectedLayerId === null ? "active" : ""}>
          <button
            className="layer-review-item"
            onClick={() => onSelectLayer(null)}
            title={t("layers.selectAssetTitle")}
          >
            <span className="layer-review-name">{t("layers.wholeAsset")}</span>
            <span className="layer-review-kind">{t("layers.compositeBadge")}</span>
          </button>
        </li>
        {asset.layers.map((layer) => {
          const selected = layer.id === selectedLayerId;
          const issues = issuesByLayer.get(layer.id) ?? 0;
          return (
            <li key={layer.id} className={selected ? "active" : ""}>
              {onMergeLayers && !layer.locked ? (
                <input
                  type="checkbox"
                  className="layer-review-check"
                  checked={validChecked.includes(layer.id)}
                  onChange={() => toggleChecked(layer.id)}
                  title={t("layers.mergeCheckTitle")}
                />
              ) : null}
              <button
                className="layer-review-item"
                onClick={() => onSelectLayer(selected ? null : layer.id)}
                title={
                  layer.notes?.length
                    ? `${layer.name} · ${layer.notes.join("; ")}`
                    : layer.name
                }
              >
                <span className="layer-review-name">{layer.name}</span>
                <span className="layer-review-kind">{layer.kind}</span>
                <span className="layer-review-confidence">
                  {t("layers.confidence", { pct: Math.round(layer.confidence * 100) })}
                </span>
                {layer.locked ? (
                  <span className="layer-review-locked" title={t("layers.lockedTitle")}>
                    {t("layers.locked")}
                  </span>
                ) : null}
                {issues > 0 ? (
                  <span className="layer-review-issues" title={t("layers.issuesTitle")}>
                    {t("layers.issues", { n: issues })}
                  </span>
                ) : null}
                {layer.protected ? (
                  <span className="layer-review-protected" title={t("layers.protectedTitle")}>
                    {t("layers.protected")}
                  </span>
                ) : null}
              </button>
              {onToggleProtected && !layer.locked ? (
                <button
                  className="layer-review-protect"
                  onClick={() => onToggleProtected(layer.id)}
                  title={t("layers.protectTitle")}
                  aria-pressed={layer.protected ?? false}
                >
                  {layer.protected ? "🛡" : "○"}
                </button>
              ) : null}
              <button
                className="layer-review-visibility"
                onClick={() => onToggleVisibility(layer.id)}
                title={t("layers.visibilityTitle")}
                aria-pressed={layerVisible(layer, visibility)}
              >
                {layerVisible(layer, visibility) ? "👁" : "–"}
              </button>
            </li>
          );
        })}
      </ul>
      {onMergeLayers || onSplitLayer ? (
        <div className="layer-review-actions">
          {onMergeLayers ? (
            <button
              className="layer-review-merge"
              disabled={validChecked.length < 2}
              onClick={() => {
                onMergeLayers(validChecked);
                setChecked([]);
              }}
              title={t("layers.mergeTitle")}
            >
              {t("layers.merge", { n: validChecked.length })}
            </button>
          ) : null}
          {onSplitLayer ? (
            <button
              className="layer-review-split"
              disabled={!asset.layers.some((layer) => layer.id === selectedLayerId && !layer.locked)}
              onClick={() => selectedLayerId && onSplitLayer(selectedLayerId)}
              title={t("layers.splitTitle")}
            >
              {t("layers.split")}
            </button>
          ) : null}
        </div>
      ) : null}
      {asset.split_report.warnings.length > 0 ? (
        <ul className="layer-review-warnings">
          {asset.split_report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
