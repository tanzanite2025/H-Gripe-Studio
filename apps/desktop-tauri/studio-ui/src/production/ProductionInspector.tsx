import { useState } from "react";

import { useT } from "../i18n";
import { ClipPropertiesPanel } from "./ClipPropertiesPanel";
import type { ClipProperties } from "./clipProps";
import { LayerReviewPanel } from "./LayerReviewPanel";
import type { LayeredImageAsset } from "./layeredImage";
import { mediaAssetKindLabel } from "./MediaWorkspacePopover";
import type { MediaAsset } from "./mediaBin";
import type { TimelineClip } from "./timeline";

interface ProductionInspectorProps {
  activeAsset: MediaAsset | null;
  selectedClip: TimelineClip | null;
  selectedClipAsset: MediaAsset | null;
  playheadSec: number;
  clipProperties?: ClipProperties;
  onSetClipProperties?: (clipId: string, props: ClipProperties) => void;
  layeredAsset: LayeredImageAsset | null;
  selectedLayerId: string | null;
  onSelectLayer: (layerId: string | null) => void;
  layerVisibility: Record<string, boolean>;
  onToggleLayerVisibility: (layerId: string) => void;
  onMergeLayers?: (layerIds: string[]) => void;
  onSplitLayer?: (layerId: string) => void;
  onToggleProtected?: (layerId: string) => void;
  height: number | null;
}

export function ProductionInspector({
  activeAsset,
  selectedClip,
  selectedClipAsset,
  playheadSec,
  clipProperties,
  onSetClipProperties,
  layeredAsset,
  selectedLayerId,
  onSelectLayer,
  layerVisibility,
  onToggleLayerVisibility,
  onMergeLayers,
  onSplitLayer,
  onToggleProtected,
  height,
}: ProductionInspectorProps) {
  const t = useT();
  const [tab, setTab] = useState<"details" | "grade">("details");

  return (
    <aside
      className="production-detail-panel"
      style={height ? { height: `${height}px`, maxHeight: `${height}px` } : undefined}
    >
      <div className="production-detail-tabs" role="tablist" aria-label={t("drawer.detailTabs")}>
        <button
          type="button"
          className={tab === "details" ? "active" : ""}
          aria-selected={tab === "details"}
          onClick={() => setTab("details")}
        >
          {t("drawer.detailsTab")}
        </button>
        <button
          type="button"
          className={tab === "grade" ? "active" : ""}
          aria-selected={tab === "grade"}
          onClick={() => setTab("grade")}
        >
          {t("drawer.gradeTab")}
        </button>
      </div>
      <div className="production-detail-body">
        {tab === "details" ? (
          layeredAsset ? (
            <LayerReviewPanel
              asset={layeredAsset}
              selectedLayerId={selectedLayerId}
              onSelectLayer={onSelectLayer}
              visibility={layerVisibility}
              onToggleVisibility={onToggleLayerVisibility}
              onMergeLayers={onMergeLayers}
              onSplitLayer={onSplitLayer}
              onToggleProtected={onToggleProtected}
            />
          ) : selectedClip ? (
            <>
              <dl className="production-detail-list">
                <div>
                  <dt>{t("drawer.detailClip")}</dt>
                  <dd>{selectedClipAsset?.name ?? selectedClip.assetId}</dd>
                </div>
                <div>
                  <dt>{t("drawer.detailKind")}</dt>
                  <dd>{selectedClip.kind}</dd>
                </div>
                <div>
                  <dt>{t("drawer.detailRange")}</dt>
                  <dd>
                    {selectedClip.start.toFixed(2)}s -{" "}
                    {(selectedClip.start + selectedClip.duration).toFixed(2)}s
                  </dd>
                </div>
              </dl>
              {selectedClip.kind !== "audio" && clipProperties && onSetClipProperties ? (
                <ClipPropertiesPanel
                  clipName={selectedClipAsset?.name ?? selectedClip.assetId}
                  props={clipProperties}
                  clipLocalSec={Math.min(
                    Math.max(0, playheadSec - selectedClip.start),
                    selectedClip.duration,
                  )}
                  onChange={(next) => onSetClipProperties(selectedClip.id, next)}
                />
              ) : null}
            </>
          ) : activeAsset ? (
            <dl className="production-detail-list">
              <div>
                <dt>{t("drawer.detailAsset")}</dt>
                <dd>{activeAsset.name}</dd>
              </div>
              <div>
                <dt>{t("drawer.detailKind")}</dt>
                <dd>{mediaAssetKindLabel(activeAsset.kind, t)}</dd>
              </div>
              <div>
                <dt>{t("drawer.detailPath")}</dt>
                <dd title={activeAsset.path}>{activeAsset.path}</dd>
              </div>
            </dl>
          ) : (
            <p className="production-detail-empty">{t("drawer.detailEmpty")}</p>
          )
        ) : (
          <p className="production-detail-empty">{t("drawer.gradePlaceholder")}</p>
        )}
      </div>
    </aside>
  );
}
