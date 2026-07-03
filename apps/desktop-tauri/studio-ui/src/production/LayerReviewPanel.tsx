import { useEffect, useState } from "react";
import { generateThumbnail } from "../bridge/files";
import { useT } from "../i18n";
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
}

function layerVisible(layer: LayerCandidate, visibility: Record<string, boolean>): boolean {
  return visibility[layer.id] ?? layer.visible;
}

/**
 * Thumbnail preview of the current review target: the selected layer's RGBA
 * cutout (toggleable to its mask) or the asset's composite when the whole
 * asset is targeted. Rendering goes through the backend thumbnail command like
 * every other preview — the raw artifact is never decoded in the webview, and
 * the browser preview (mocked backend) shows a text placeholder instead.
 */
function LayerPreview({ asset, layer }: { asset: LayeredImageAsset; layer: LayerCandidate | null }) {
  const t = useT();
  const [showMask, setShowMask] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = layer
    ? showMask
      ? layer.mask.path
      : layer.rgba?.path ?? layer.mask.path
    : asset.preview_composite.path;

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    generateThumbnail({ path, size: 320 })
      .then((thumb) => {
        if (cancelled) return;
        if (thumb.data_url) setSrc(thumb.data_url);
        else setError(t("layers.previewUnavailable"));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, t]);

  return (
    <div className="layer-review-preview">
      <div className="layer-review-preview-stage" title={path}>
        {src ? (
          <img className="layer-review-preview-img" src={src} alt={layer?.name ?? "composite"} />
        ) : (
          <span className="layer-review-preview-empty">{error ?? "…"}</span>
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
}: LayerReviewPanelProps) {
  const t = useT();
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
              </button>
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
