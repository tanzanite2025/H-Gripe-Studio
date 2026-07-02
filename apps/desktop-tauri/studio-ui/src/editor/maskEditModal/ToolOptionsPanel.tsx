// Right rail — "Tool options" panel block: per-tool parameters plus the
// contextual drafts (morphology preview, pen path, fill / transform / anchor).

import { useContext, type Dispatch, type SetStateAction } from "react";
import { toolTargets, type MaskTool, type PaintTarget, type ShapeKind } from "../maskTools";
import { localizeTool } from "../maskToolsI18n";
import { LangContext, useT } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";
import type { TransformParams } from "../maskEdit";
import type { FillDraft, MaskEditDispatch } from "./actions";

export type PathMode = "add" | "subtract" | "intersect";

interface ToolOptionsPanelProps {
  tool: MaskTool;
  toolId: string;
  dispatch: MaskEditDispatch;
  brushSize: number;
  setBrushSize: (n: number) => void;
  brushHardness: number;
  setBrushHardness: (n: number) => void;
  brushFlow: number;
  setBrushFlow: (n: number) => void;
  brushSpacing: number;
  setBrushSpacing: (n: number) => void;
  paintTarget: PaintTarget;
  setPaintTarget: (t: PaintTarget) => void;
  /** Eyedropper sample (`#rrggbb`); null until a colour has been picked. */
  sampledColor: string | null;
  shapeKind: ShapeKind;
  setShapeKind: (k: ShapeKind) => void;
  shapeSides: number;
  setShapeSides: (n: number) => void;
  showAmount: boolean;
  amount: number;
  setAmount: (n: number) => void;
  applyPreviewOp: () => void;
  cancelPreview: () => void;
  pathMode: PathMode;
  setPathMode: (m: PathMode) => void;
  penAnchors: [number, number][];
  closePenPath: () => void;
  cancelPenPath: () => void;
  tolerance: number;
  setTolerance: (n: number) => void;
  fillDraft: FillDraft | null;
  setFillDraft: Dispatch<SetStateAction<FillDraft | null>>;
  transformDraft: TransformParams | null;
  setTransformDraft: Dispatch<SetStateAction<TransformParams | null>>;
  editingTransform: number | null;
  closeTransformPanel: () => void;
  editingPath: number | null;
  commitPathEdit: () => void;
  cancelPathEdit: () => void;
}

export function ToolOptionsPanel({
  tool,
  toolId,
  dispatch,
  brushSize,
  setBrushSize,
  brushHardness,
  setBrushHardness,
  brushFlow,
  setBrushFlow,
  brushSpacing,
  setBrushSpacing,
  paintTarget,
  setPaintTarget,
  sampledColor,
  shapeKind,
  setShapeKind,
  shapeSides,
  setShapeSides,
  showAmount,
  amount,
  setAmount,
  applyPreviewOp,
  cancelPreview,
  pathMode,
  setPathMode,
  penAnchors,
  closePenPath,
  cancelPenPath,
  tolerance,
  setTolerance,
  fillDraft,
  setFillDraft,
  transformDraft,
  setTransformDraft,
  editingTransform,
  closeTransformPanel,
  editingPath,
  commitPathEdit,
  cancelPathEdit,
}: ToolOptionsPanelProps) {
  const t = useT();
  const lang = useContext(LangContext);
  return (
    <div className="mask-panel-body">
      <label className="field">
        <span>{t("mask.brushSize")}</span>
        <span className="slider-row">
          <input type="range" min={1} max={96} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          <output>{brushSize}</output>
        </span>
      </label>
      {tool.kind === "paint" || tool.kind === "matte" ? (
        <>
          <label className="field">
            <span>{t("mask.brushHardness")}</span>
            <span className="slider-row">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(brushHardness * 100)}
                onChange={(e) => setBrushHardness(Number(e.target.value) / 100)}
              />
              <output>{Math.round(brushHardness * 100)}</output>
            </span>
          </label>
          <label className="field">
            <span>{t("mask.brushFlow")}</span>
            <span className="slider-row">
              <input
                type="range"
                min={1}
                max={100}
                value={Math.round(brushFlow * 100)}
                onChange={(e) => setBrushFlow(Number(e.target.value) / 100)}
              />
              <output>{Math.round(brushFlow * 100)}</output>
            </span>
          </label>
          <label className="field">
            <span>{t("mask.brushSpacing")}</span>
            <span className="slider-row">
              <input
                type="range"
                min={1}
                max={100}
                value={Math.round(brushSpacing * 100)}
                onChange={(e) => setBrushSpacing(Number(e.target.value) / 100)}
              />
              <output>{Math.round(brushSpacing * 100)}</output>
            </span>
          </label>
        </>
      ) : null}
      {toolTargets(tool).length > 1 ? (
        <div className="field">
          <span>{t("mask.paintTarget")}</span>
          <span className="slider-row">
            {toolTargets(tool).map((tg) => (
              <button key={tg} className={paintTarget === tg ? "active" : ""} onClick={() => setPaintTarget(tg)}>
                {t(tg === "layer" ? "mask.targetLayer" : "mask.targetMatte")}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      {showAmount ? (
        <label className="field">
          <span>{t("mask.amount")}</span>
          <span className="slider-row">
            <input type="range" min={0} max={16} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            <output>{amount}</output>
          </span>
        </label>
      ) : null}
      {isPreviewableOp(toolId) ? (
        <div className="field mask-preview-actions">
          <span>
            {localizeTool(tool, lang).label}{" "}
            <span className="muted">· {t("mask.previewBadge")}</span>
          </span>
          <span className="slider-row">
            <button className="primary" onClick={applyPreviewOp} title={t("mask.applyTitle")}>
              {t("mask.previewApply", { op: localizeTool(tool, lang).label })}
            </button>
            <button onClick={cancelPreview}>{t("mask.previewCancel")}</button>
          </span>
          <small className="muted">{t("mask.previewHint")}</small>
        </div>
      ) : null}
      {tool.kind === "shape" ? (
        <div className="field">
          <span>{t("mask.shapeKind")}</span>
          <span className="slider-row">
            {(["triangle", "polygon", "star", "line"] as const).map((k) => (
              <button key={k} className={shapeKind === k ? "active" : ""} onClick={() => setShapeKind(k)}>
                {t(
                  k === "triangle"
                    ? "mask.shapeTriangle"
                    : k === "polygon"
                      ? "mask.shapePolygon"
                      : k === "star"
                        ? "mask.shapeStar"
                        : "mask.shapeLine",
                )}
              </button>
            ))}
          </span>
          {shapeKind === "polygon" || shapeKind === "star" ? (
            <label className="slider-row">
              <span>{t("mask.shapeSides")}</span>
              <input type="range" min={3} max={12} value={shapeSides} onChange={(e) => setShapeSides(Number(e.target.value))} />
              <output>{shapeSides}</output>
            </label>
          ) : null}
        </div>
      ) : null}
      {tool.kind === "path" || tool.kind === "shape" ? (
        <div className="field">
          <span>{t("mask.pathMode")}</span>
          <span className="slider-row">
            {(["add", "subtract", "intersect"] as const).map((m) => (
              <button key={m} className={pathMode === m ? "active" : ""} onClick={() => setPathMode(m)}>
                {t(m === "add" ? "mask.pathAdd" : m === "subtract" ? "mask.pathSubtract" : "mask.pathIntersect")}
              </button>
            ))}
          </span>
          {tool.id === "pen" && penAnchors.length > 0 ? (
            <span className="slider-row">
              <button className="primary" disabled={penAnchors.length < 3} onClick={closePenPath}>
                {t("mask.closePath", { count: penAnchors.length })}
              </button>
              <button onClick={cancelPenPath}>{t("mask.cancelPath")}</button>
            </span>
          ) : null}
        </div>
      ) : null}
      {tool.kind === "sample" ? (
        <div className="field">
          <span>{t("mask.sampledColor")}</span>
          <span className="slider-row">
            <span
              className="mask-color-swatch"
              style={{
                display: "inline-block",
                width: 24,
                height: 24,
                borderRadius: 4,
                border: "1px solid rgba(255,255,255,0.3)",
                background: sampledColor ?? "transparent",
              }}
            />
            <output>{sampledColor ?? t("mask.sampledNone")}</output>
          </span>
        </div>
      ) : null}
      {tool.id === "wand" ? (
        <label className="field">
          <span>{t("mask.wandTolerance")}</span>
          <span className="slider-row">
            <input type="range" min={0} max={255} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
            <output>{tolerance}</output>
          </span>
        </label>
      ) : null}

      {fillDraft ? (
        <div className="field mask-preview-actions">
          <span>{t("mask.fillDialog")}</span>
          <span className="slider-row">
            {(["add", "subtract"] as const).map((m) => (
              <button
                key={m}
                className={fillDraft.mode === m ? "active" : ""}
                onClick={() => setFillDraft((prev) => (prev ? { ...prev, mode: m } : prev))}
              >
                {t(m === "add" ? "mask.fillAdd" : "mask.fillSubtract")}
              </button>
            ))}
          </span>
          <label className="slider-row">
            <span>{t("mask.fillOpacity")}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={fillDraft.opacity}
              onChange={(e) =>
                setFillDraft((prev) => (prev ? { ...prev, opacity: Number(e.target.value) } : prev))
              }
            />
            <output>{fillDraft.opacity}</output>
          </label>
          <span className="slider-row">
            <button
              className="primary"
              onClick={() => {
                dispatch({ type: "op", op: { type: "fill", mode: fillDraft.mode, amount: fillDraft.opacity } });
                setFillDraft(null);
              }}
            >
              {t("mask.fillApply")}
            </button>
            <button onClick={() => setFillDraft(null)}>{t("mask.fillCancel")}</button>
          </span>
          <small className="muted">{t("mask.fillHint")}</small>
        </div>
      ) : null}

      {transformDraft ? (
        <div className="field mask-preview-actions">
          <span>{t("mask.freeTransform")}</span>
          {(
            [
              ["dx", "mask.transformDx", 1],
              ["dy", "mask.transformDy", 1],
              ["scale", "mask.transformScale", 100],
              ["rotate", "mask.transformRotate", 1],
            ] as const
          ).map(([key, label, factor]) => (
            <label key={key} className="slider-row">
              <span>{t(label)}</span>
              <input
                type="number"
                value={Math.round(transformDraft[key] * factor)}
                onChange={(e) =>
                  setTransformDraft((prev) =>
                    prev ? { ...prev, [key]: Number(e.target.value) / factor } : prev,
                  )
                }
              />
            </label>
          ))}
          <span className="slider-row">
            <button
              className="primary"
              onClick={() => {
                if (editingTransform != null) {
                  dispatch({ type: "op_transform", index: editingTransform, params: transformDraft });
                } else {
                  dispatch({
                    type: "op",
                    op: {
                      type: "transform",
                      dx: transformDraft.dx,
                      dy: transformDraft.dy,
                      scale: transformDraft.scale,
                      rotate: transformDraft.rotate,
                    },
                  });
                }
                closeTransformPanel();
              }}
            >
              {editingTransform != null ? t("mask.transformUpdate") : t("mask.transformApply")}
            </button>
            <button onClick={closeTransformPanel}>{t("mask.transformCancel")}</button>
          </span>
          <small className="muted">{t("mask.transformHint")}</small>
        </div>
      ) : null}

      {editingPath != null ? (
        <div className="field mask-preview-actions">
          <span>{t("mask.anchorEditing")}</span>
          <span className="slider-row">
            <button className="primary" onClick={commitPathEdit}>{t("mask.anchorDone")}</button>
            <button onClick={cancelPathEdit}>{t("mask.anchorCancel")}</button>
          </span>
          <small className="muted">{t("mask.anchorHint")}</small>
        </div>
      ) : null}
    </div>
  );
}
