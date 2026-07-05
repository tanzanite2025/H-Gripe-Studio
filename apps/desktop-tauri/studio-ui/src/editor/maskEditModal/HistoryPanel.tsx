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
  if (op.type === "heal") return `heal r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "clone") return `clone r${op.amount ?? 8} Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}`;
  if (op.type === "history_brush") return `history r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "dodge_burn") return `${op.mode === "burn" ? "burn" : "dodge"} r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "sponge") return `sponge ${op.mode === "desaturate" ? "desat" : "sat"} r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "healing_brush") return `healing r${op.amount ?? 8} Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)}`;
  if (op.type === "quick_select") return `quick select tol${op.amount ?? 0} (${op.points?.length ?? 0})`;
  if (op.type === "background_eraser") return `bg eraser r${op.amount ?? 8} tol${op.tolerance ?? 0}`;
  if (op.type === "patch") return `patch Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)} (${op.points?.length ?? 0})`;
  if (op.type === "perspective_crop") return "perspective crop";
  if (op.type === "red_eye") return `red eye @${Math.round(op.region?.[0] ?? 0)},${Math.round(op.region?.[1] ?? 0)}`;
  if (op.type === "object_select") return "object select";
  if (op.type === "remove") return `remove r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "content_aware_move") return `ca move Δ${Math.round(op.dx ?? 0)},${Math.round(op.dy ?? 0)} (${op.points?.length ?? 0})`;
  if (op.type === "pattern_stamp") return `pattern r${op.amount ?? 8} (${op.points?.length ?? 0})`;
  if (op.type === "art_history_brush") return `art history r${op.amount ?? 8} (${op.points?.length ?? 0})`;
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
    <div className="mask-panel-body">
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
    </div>
  );
}
