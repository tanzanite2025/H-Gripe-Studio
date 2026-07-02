// Right rail — "History" panel block (M2): one row per edit-stack step.

import { useT } from "../../i18n";
import type { EditOp } from "../../types/production";
import { isBrushOp, isPathOp } from "../../types/production";
import type { MaskEditDispatch } from "./actions";

// One-line label for a history step (raw op vocabulary, like the old chips).
function opLabel(op: EditOp): string {
  if (isPathOp(op)) return `${op.tool} ${op.mode} (${op.points.length})`;
  if (isBrushOp(op)) return `${op.mode === "subtract" ? "eraser" : "brush"} r${op.radius} (${op.points.length})`;
  if (op.type === "transform") {
    const scale = op.scale ?? 1;
    const rotate = op.rotate ?? 0;
    return `transform Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}${scale !== 1 ? ` ×${scale}` : ""}${rotate !== 0 ? ` ∠${rotate}°` : ""}`;
  }
  if (op.type === "fill") return `fill ${op.mode === "subtract" ? "subtract" : "add"} ${op.amount ?? 100}%`;
  return op.type;
}

interface HistoryPanelProps {
  ops: readonly EditOp[];
  dispatch: MaskEditDispatch;
  editingPath: number | null;
  startPathEdit: (index: number) => void;
  cancelPathEdit: () => void;
  /** Open the transform draft panel pointed at history step `index`. */
  editTransformStep: (index: number, op: EditOp) => void;
}

export function HistoryPanel({ ops, dispatch, editingPath, startPathEdit, cancelPathEdit, editTransformStep }: HistoryPanelProps) {
  const t = useT();
  return (
    <section className="mask-panel">
      <header>{t("mask.history", { count: ops.length })}</header>
      <div className="field">
        <div className="mask-history-list">
          {ops.length === 0 ? (
            <small className="muted">{t("mask.historyEmpty")}</small>
          ) : (
            ops.map((op, i) => (
              <div
                key={i}
                className={`mask-history-row${op.disabled ? " disabled" : ""}${editingPath === i ? " editing" : ""}`}
              >
                <button
                  className="mask-history-toggle"
                  title={op.disabled ? t("mask.stepEnable") : t("mask.stepDisable")}
                  onClick={() => dispatch({ type: "toggle_op", index: i })}
                >
                  {op.disabled ? "◌" : "●"}
                </button>
                <span className="mask-history-label" title={opLabel(op)}>
                  {i + 1}. {opLabel(op)}
                </span>
                {!isPathOp(op) && !isBrushOp(op) && op.amount != null ? (
                  <input
                    className="mask-history-amount"
                    type="number"
                    min={0}
                    max={255}
                    value={op.amount}
                    title={t("mask.stepAmount")}
                    onChange={(e) => dispatch({ type: "op_amount", index: i, amount: Number(e.target.value) })}
                  />
                ) : null}
                {isPathOp(op) ? (
                  <button
                    className="mask-history-edit"
                    title={t("mask.stepEditAnchors")}
                    onClick={() => (editingPath === i ? cancelPathEdit() : startPathEdit(i))}
                  >
                    ✎
                  </button>
                ) : null}
                {!isPathOp(op) && !isBrushOp(op) && op.type === "transform" ? (
                  <button
                    className="mask-history-edit"
                    title={t("mask.stepEditTransform")}
                    onClick={() => editTransformStep(i, op)}
                  >
                    ✎
                  </button>
                ) : null}
                <button
                  className="mask-history-delete"
                  title={t("mask.stepDelete")}
                  onClick={() => {
                    if (editingPath === i) cancelPathEdit();
                    dispatch({ type: "remove_op", index: i });
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
