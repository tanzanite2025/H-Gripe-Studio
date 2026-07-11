// Right rail history: global document snapshots, not the active layer's op
// list. Restoring a row brings back that snapshot's whole layer tree.

import { useT } from "../../i18n";
import type { HistorySnapshot } from "../imageEditorState";

interface HistoryPanelProps {
  snapshots: readonly HistorySnapshot[];
  onReviewSnapshot: (index: number) => void;
}

export function HistoryPanel({ snapshots, onReviewSnapshot }: HistoryPanelProps) {
  const t = useT();
  return (
    <div className="mask-panel-body">
      <div className="field">
        <div className="mask-history-list snapshot-list">
          {snapshots.length === 0 ? (
            <small className="muted">{t("mask.historyEmpty")}</small>
          ) : (
            snapshots.map((snapshot) => (
              <button
                key={snapshot.index}
                className={`mask-history-row mask-history-snapshot${snapshot.current ? " current" : ""}`}
                title={t("mask.snapshotReviewTitle")}
                onClick={() => onReviewSnapshot(snapshot.index)}
              >
                <span className="mask-history-dot" aria-hidden="true" />
                <span className="mask-history-label">
                  {snapshot.index + 1}. {snapshot.label}
                </span>
                <span className="mask-history-meta">
                  {t("mask.snapshotMeta", { layers: snapshot.layers, edits: snapshot.edits })}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface HistorySnapshotDialogProps {
  snapshot: HistorySnapshot;
  currentIndex: number;
  onRestore: (index: number) => void;
  onClose: () => void;
}

export function HistorySnapshotDialog({ snapshot, currentIndex, onRestore, onClose }: HistorySnapshotDialogProps) {
  const t = useT();
  const isCurrent = snapshot.index === currentIndex;
  return (
    <div className="mask-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="mask-dialog history-snapshot-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mask-dialog-title">{t("mask.snapshotDialogTitle")}</div>
        <div className="mask-dialog-body">
          <div className="history-snapshot-summary">
            <strong>
              {snapshot.index + 1}. {snapshot.label}
            </strong>
            {isCurrent ? <span className="history-current-pill">{t("mask.snapshotCurrent")}</span> : null}
          </div>
          <div className="history-snapshot-grid">
            <span>{t("mask.snapshotLayers")}</span>
            <b>{snapshot.layers}</b>
            <span>{t("mask.snapshotEdits")}</span>
            <b>{snapshot.edits}</b>
            <span>{t("mask.snapshotActiveLayer")}</span>
            <b title={snapshot.activeLayerName}>{snapshot.activeLayerName}</b>
          </div>
          <div className="history-layer-list" aria-label={t("mask.snapshotLayerList")}>
            {snapshot.doc.layers.map((layer, index) => (
              <div key={layer.id} className={`history-layer-row${index === snapshot.doc.active ? " active" : ""}`}>
                <span className="history-layer-name" title={layer.name}>
                  {layer.name}
                </span>
                <span className="history-layer-meta">
                  {layer.visible === false ? t("mask.snapshotHidden") : t("mask.snapshotVisible")}
                  {" / "}
                  {t("mask.snapshotLayerOps", { count: layer.ops.length + (layer.mask?.ops.length ?? 0) })}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="mask-dialog-actions">
          <button onClick={onClose}>{t("mask.previewCancel")}</button>
          <button disabled={isCurrent} onClick={() => onRestore(snapshot.index)}>
            {t("mask.snapshotRestore")}
          </button>
        </div>
      </div>
    </div>
  );
}
