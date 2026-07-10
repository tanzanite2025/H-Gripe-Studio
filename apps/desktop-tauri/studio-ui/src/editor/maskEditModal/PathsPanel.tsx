// Right rail — "Paths" panel (PS 路径): the active layer's vector path steps
// (pen / lasso / marquee / shape ops), with PS-style anchor re-editing.

import { useT } from "../../i18n";
import { type EditOp } from "../../contracts/maskOps";
import { isPathOp } from "../../contracts/maskOps";

interface PathsPanelProps {
  ops: readonly EditOp[];
  editingPath: number | null;
  startPathEdit: (index: number) => void;
  cancelPathEdit: () => void;
}

export function PathsPanel({ ops, editingPath, startPathEdit, cancelPathEdit }: PathsPanelProps) {
  const t = useT();
  const paths = ops.map((op, i) => ({ op, i })).filter(({ op }) => isPathOp(op));
  return (
    <div className="mask-panel-body">
      {paths.length === 0 ? (
        <small className="muted mask-edit-note">{t("mask.pathsEmpty")}</small>
      ) : (
        <div className="mask-history-list">
          {paths.map(({ op, i }) => {
            if (!isPathOp(op)) return null;
            return (
              <div key={i} className={`mask-history-row${editingPath === i ? " editing" : ""}`}>
                <span className="mask-layer-thumb mask-path-thumb" aria-hidden="true">
                  ◇
                </span>
                <span className="mask-history-label">
                  {t("mask.pathRow", { index: i + 1 })} · {op.tool} {op.mode} ({op.points.length})
                </span>
                <button
                  className="mask-history-edit"
                  title={t("mask.stepEditAnchors")}
                  onClick={() => (editingPath === i ? cancelPathEdit() : startPathEdit(i))}
                >
                  ✎
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
