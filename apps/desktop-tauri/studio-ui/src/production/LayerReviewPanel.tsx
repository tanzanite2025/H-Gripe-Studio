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
 * Minimal layer review list (IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md, Review
 * Editor stage 1): consumes a `LayeredImageAsset` — today the smartLayerSplit
 * stub — and lets the user select the whole asset or one candidate layer as
 * the unified production target, toggle candidate visibility, and read the
 * split report's warnings. Mask overlay / confirm-asset land with the real
 * segmentation engine.
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
