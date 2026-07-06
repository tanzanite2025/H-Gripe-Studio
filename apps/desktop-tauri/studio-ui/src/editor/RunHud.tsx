import { useContext, useEffect, useMemo, useState } from "react";

import { LangContext, useT, type MsgKey } from "../i18n";
import { NODE_SPECS } from "../graph/nodeSpecs";
import { localizeSpec } from "../graph/nodeSpecsI18n";
import type { RunScope } from "../runtime/runScope";
import type { WorkflowGraph } from "../graph/model";
import { buildRunPreview, type PreviewCategory } from "./runPreview";

function PlayIcon() {
  return (
    <svg className="run-hud-play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

/** The HUD's scope choices; each maps onto an existing RunScope kind. */
export type RunHudScope = "full_canvas" | "selection_with_upstream" | "selection_only";

const CATEGORY_LABEL: Record<PreviewCategory, MsgKey> = {
  source: "palette.catSource",
  generate: "palette.catGenerate",
  process: "palette.catProcess",
  review: "palette.catReview",
  workflow: "palette.catWorkflow",
  output: "palette.catOutput",
  internal: "hud.catInternal",
};

export interface RunHudProps {
  /** The active canvas in the renderer-agnostic model (memoized by the host). */
  graph: WorkflowGraph;
  running: boolean;
  canCancel: boolean;
  /** Graph validation issues; a non-empty list disables execution. */
  issueCount: number;
  selectedNodeIds: string[];
  /** Execute the chosen scope (the host maps it to the run controller). */
  onRunScope: (scope: RunHudScope) => void;
  onCancelRun: () => void;
  hasBatch: boolean;
  batchCount: number;
  onRunBatch: () => void;
  /** Run-history modal toggle — lives next to Run so past runs sit by the entry point. */
  showHistory: boolean;
  historyCount: number;
  onToggleHistory: () => void;
}

/**
 * Floating execution capsule over the canvas viewport (canvas HUD). It is an
 * application-level control — rendered outside React Flow, so it never pans,
 * zooms, or participates in selection/wiring — that owns the whole-canvas run
 * entry point: pick a run scope, preview exactly which cards will execute,
 * confirm, run. Scoped card/row/context-menu runs stay where they are; this
 * replaces only the toolbar's global Run cluster.
 */
export function RunHud({
  graph,
  running,
  canCancel,
  issueCount,
  selectedNodeIds,
  onRunScope,
  onCancelRun,
  hasBatch,
  batchCount,
  onRunBatch,
  showHistory,
  historyCount,
  onToggleHistory,
}: RunHudProps) {
  const t = useT();
  const lang = useContext(LangContext);
  const [scope, setScope] = useState<RunHudScope>("full_canvas");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasSelection = selectedNodeIds.length > 0;

  // A selection scope with nothing selected is meaningless — fall back so the
  // preview count and the run always agree with what would actually execute.
  useEffect(() => {
    if (!hasSelection && scope !== "full_canvas") setScope("full_canvas");
  }, [hasSelection, scope]);

  const runScope: RunScope = useMemo(() => {
    if (scope === "full_canvas") return { kind: "full_canvas", canvasId: "active" };
    return { kind: scope, canvasId: "active", nodeIds: selectedNodeIds };
  }, [scope, selectedNodeIds]);

  const preview = useMemo(() => buildRunPreview(graph, runScope), [graph, runScope]);

  const cardTitle = (kind: string) => {
    const spec = NODE_SPECS[kind];
    return spec ? localizeSpec(spec, lang).title : kind;
  };

  const disabled = running || issueCount > 0;
  const disabledTitle =
    issueCount > 0 ? t("hud.blockedByIssues", { count: issueCount }) : t("btn.runTitle");

  const execute = (s: RunHudScope) => {
    setConfirmOpen(false);
    onRunScope(s);
  };

  return (
    <div className="run-hud">
      <div className="run-hud-bar">
        <button
          className="primary run-hud-run"
          onClick={() => setConfirmOpen((o) => !o)}
          disabled={disabled}
          title={disabledTitle}
        >
          <PlayIcon />
          {running ? t("btn.running") : t("btn.run")}
        </button>
        <button onClick={onToggleHistory} title={t("btn.historyTitle")}>
          {showHistory ? t("btn.hideHistory") : t("btn.history")}
          {historyCount > 0 ? ` (${historyCount})` : ""}
        </button>
        <label className="run-hud-scope">
          <span className="muted">{t("hud.scope")}</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as RunHudScope)}
            disabled={running}
          >
            <option value="full_canvas">{t("hud.scopeFullCanvas")}</option>
            <option value="selection_with_upstream" disabled={!hasSelection}>
              {t("hud.scopeSelection")}
            </option>
            <option value="selection_only" disabled={!hasSelection}>
              {t("hud.scopeSelectionOnly")}
            </option>
          </select>
        </label>
        <span className="muted run-hud-count">
          {t("hud.willRun", { count: preview.total })}
        </span>
        {hasBatch && (
          <button
            onClick={onRunBatch}
            disabled={disabled || batchCount === 0}
            title={t("btn.runBatchTitle")}
          >
            {t("btn.run")} x{batchCount}
          </button>
        )}
        {canCancel && (
          <button onClick={onCancelRun} title={t("btn.cancelTitle")}>
            {t("btn.cancel")}
          </button>
        )}
      </div>

      {confirmOpen && !running && (
        <div className="run-hud-confirm" role="dialog" aria-label={t("hud.confirmTitle")}>
          <div className="run-hud-confirm-title">{t("hud.confirmTitle")}</div>
          <div className="run-hud-confirm-body">
            {preview.groups.map((group) => (
              <div key={group.category} className="run-hud-confirm-group">
                <span className="run-hud-confirm-cat">{t(CATEGORY_LABEL[group.category])}</span>
                <span className="run-hud-confirm-nodes">
                  {group.nodes.map((n) => cardTitle(n.kind)).join(" · ")}
                </span>
              </div>
            ))}
            {preview.total === 0 && <div className="muted">{t("hud.nothingToRun")}</div>}
            {preview.warnings.map((w, i) => (
              <div key={i} className="run-hud-confirm-warning">⚠ {w}</div>
            ))}
          </div>
          <div className="run-hud-confirm-footer">
            <span className="muted">{t("hud.totalNodes", { count: preview.total })}</span>
            <div className="run-hud-confirm-actions">
              <button
                className="primary"
                onClick={() => execute(scope)}
                disabled={disabled || preview.total === 0}
              >
                {t("btn.run")}
              </button>
              {scope === "full_canvas" && hasSelection && (
                <button
                  onClick={() => execute("selection_with_upstream")}
                  disabled={disabled}
                  title={t("btn.runSelectedTitle")}
                >
                  {t("hud.runSelectedOnly", { count: selectedNodeIds.length })}
                </button>
              )}
              <button onClick={() => setConfirmOpen(false)}>{t("btn.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
