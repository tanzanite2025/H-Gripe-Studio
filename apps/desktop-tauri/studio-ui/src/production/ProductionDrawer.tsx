import { useT, type MsgKey } from "../i18n";
import type { DrawerMode, DrawerTab } from "./drawerState";
import type { MediaAsset, MediaAssetKind } from "./mediaBin";
import type { ProductionTarget } from "./productionTarget";

export interface AddableAsset {
  kind: MediaAssetKind;
  path: string;
  sourceNodeId: string;
}

export interface ProductionDrawerProps {
  mode: DrawerMode;
  onSetMode: (mode: DrawerMode) => void;
  tab: DrawerTab;
  onSetTab: (tab: DrawerTab) => void;
  /** Current unified production selection (drawer + on-demand editors). */
  target: ProductionTarget | null;
  assets: MediaAsset[];
  /** Asset id currently selected in the bin (targets `{kind:"asset"}`). */
  activeAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  /** The selected canvas node as a bin-addable media reference, when it is one. */
  addableAsset: AddableAsset | null;
  onAddSelected: () => void;
}

function kindKey(kind: MediaAssetKind): MsgKey {
  return kind === "image" ? "drawer.kindImage" : kind === "video" ? "drawer.kindVideo" : "drawer.kindAudio";
}

/**
 * Bottom production drawer (UNIFIED_PRODUCTION_DRAWER_PLAN.md): the resident
 * edit/grade workspace under the node canvas. Only two first-level tabs live
 * here — Edit / Timeline and Grade; image / audio / export editors open on
 * demand from the workspace selection instead of mounting with the drawer.
 * Collapses to a slim rail so the canvas keeps its space when unused.
 */
export function ProductionDrawer({
  mode,
  onSetMode,
  tab,
  onSetTab,
  target,
  assets,
  activeAssetId,
  onSelectAsset,
  onRemoveAsset,
  addableAsset,
  onAddSelected,
}: ProductionDrawerProps) {
  const t = useT();

  if (mode === "collapsed") {
    return (
      <div className="production-drawer production-drawer-rail">
        <button
          className="production-drawer-handle"
          onClick={() => onSetMode("half")}
          title={t("drawer.openTitle")}
        >
          ▴ {t("drawer.title")}
        </button>
        <span className="production-drawer-rail-meta">
          {t("drawer.assetCount", { n: assets.length })}
        </span>
      </div>
    );
  }

  const targetLabel = !target
    ? t("drawer.targetNone")
    : target.kind === "asset"
      ? `${t("drawer.targetAsset")} · ${assets.find((a) => a.id === target.assetId)?.name ?? target.assetId}`
      : target.kind === "node_output"
        ? `${t("drawer.targetNode")} · ${target.nodeId}`
        : target.kind;

  return (
    <div className={`production-drawer production-drawer-${mode}`}>
      <div className="production-drawer-head">
        <div className="production-drawer-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "edit"}
            className={tab === "edit" ? "active" : ""}
            onClick={() => onSetTab("edit")}
          >
            {t("drawer.tabEdit")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "grade"}
            className={tab === "grade" ? "active" : ""}
            onClick={() => onSetTab("grade")}
          >
            {t("drawer.tabGrade")}
          </button>
        </div>
        <span className="production-drawer-target" title={targetLabel}>
          {targetLabel}
        </span>
        <div className="spacer" />
        <button
          onClick={() => onSetMode(mode === "half" ? "full" : "half")}
          title={mode === "half" ? t("drawer.fullTitle") : t("drawer.halfTitle")}
        >
          {mode === "half" ? "⤢" : "⤡"}
        </button>
        <button onClick={() => onSetMode("collapsed")} title={t("drawer.collapseTitle")}>
          ▾
        </button>
      </div>

      {tab === "edit" ? (
        <div className="production-drawer-body production-edit">
          <div className="production-bin">
            <div className="production-bin-head">
              <h3>{t("drawer.binTitle")}</h3>
              <div className="spacer" />
              <button
                onClick={onAddSelected}
                disabled={!addableAsset}
                title={t("drawer.addSelectedTitle")}
              >
                {t("drawer.addSelected")}
              </button>
            </div>
            {assets.length === 0 ? (
              <p className="production-bin-empty">{t("drawer.binEmpty")}</p>
            ) : (
              <ul className="production-bin-list">
                {assets.map((a) => (
                  <li key={a.id} className={a.id === activeAssetId ? "active" : ""}>
                    <button
                      className="production-bin-item"
                      onClick={() => onSelectAsset(a.id === activeAssetId ? null : a.id)}
                      title={a.path}
                    >
                      <span className={`production-bin-kind kind-${a.kind}`}>{t(kindKey(a.kind))}</span>
                      <span className="production-bin-name">{a.name}</span>
                    </button>
                    <button
                      className="production-bin-remove"
                      onClick={() => onRemoveAsset(a.id)}
                      title={t("drawer.removeTitle")}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="production-timeline-placeholder">
            <p>{t("drawer.timelinePlaceholder")}</p>
          </div>
        </div>
      ) : (
        <div className="production-drawer-body production-grade">
          <p>{t("drawer.gradePlaceholder")}</p>
        </div>
      )}
    </div>
  );
}
