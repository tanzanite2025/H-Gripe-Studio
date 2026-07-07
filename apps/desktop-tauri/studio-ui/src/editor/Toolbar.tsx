import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Node } from "@hgripe/flow";

import { NodeSearchBox } from "./NodeSearchBox";
import { WindowControls } from "./WindowControls";
import type { ValidationIssue } from "../runtime/dag";
import { useT } from "../i18n";

export function UndoIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

export function RedoIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  );
}

/** Image editor module: a framed photo with a sun and mountain. */
export function ImageEditIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </svg>
  );
}

/** Edit / grade module: a film clapperboard for timeline editing & grading. */
export function EditGradeIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="m4 8 3-4 4 4M11 4l4 4M16 4l4 3.5" />
    </svg>
  );
}

export interface ToolbarProps {
  // Status
  issues: ValidationIssue[];
  isDesktop: boolean;

  // Language
  onToggleLang: () => void;

  // System model manager (Models / APIs)
  onOpenModels: () => void;

  // Unified image editor (mask + crop) for an image source card.
  onOpenImageEdit: () => void;

  // Bottom production drawer (Edit / Timeline + Grade).
  drawerOpen: boolean;
  onToggleDrawer: () => void;

  // Panels
  showProject: boolean;
  setShowProject: Dispatch<SetStateAction<boolean>>;
  showSnapshots: boolean;
  setShowSnapshots: Dispatch<SetStateAction<boolean>>;
  showLog: boolean;
  setShowLog: Dispatch<SetStateAction<boolean>>;
  snapshotCount: number;
  logCount: number;

  // Node search
  nodes: Node[];
  onJumpToNode: (nodeId: string) => void;

  // File actions
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  onFilePicked: (file: File) => void;
}

/**
 * The editor's top toolbar (multi-canvas workspace plan, Phase 1): a global
 * row (document name, search, status, language) over grouped command
 * clusters. The OS window chrome already carries the app brand, so the
 * toolbar does not repeat it, and the language switch lives in the global
 * row — it is not a canvas editing operation.
 */
export function Toolbar({
  issues,
  isDesktop,
  onToggleLang,
  onOpenModels,
  onOpenImageEdit,
  drawerOpen,
  onToggleDrawer,
  showProject,
  setShowProject,
  showSnapshots,
  setShowSnapshots,
  showLog,
  setShowLog,
  snapshotCount,
  logCount,
  nodes,
  onJumpToNode,
  fileInputRef,
  onFilePicked,
}: ToolbarProps) {
  const t = useT();

  return (
    <header className="toolbar">
      <div className="toolbar-title-row" data-tauri-drag-region>
        <div className="toolbar-command-zone">{isDesktop && <WindowControls />}</div>
        <div className="toolbar-search">
          <NodeSearchBox nodes={nodes} onJump={onJumpToNode} />
        </div>

        <div className="toolbar-title-status">
          {issues.length > 0 && (
            <span className="issues" title={issues.map((i) => i.message).join("\n")}>
              ! {issues.length} {issues.length > 1 ? t("issues.many") : t("issues.one")}
            </span>
          )}
          <button
            onClick={onOpenImageEdit}
            title={t("btn.imageEditTitle")}
            aria-label={t("btn.imageEdit")}
            className="module-btn module-image"
          >
            <ImageEditIcon />
          </button>
          <button
            onClick={onToggleDrawer}
            title={drawerOpen ? t("btn.drawerCloseTitle") : t("btn.drawerTitle")}
            aria-label={t("btn.drawer")}
            className={`module-btn module-grade${drawerOpen ? " active" : ""}`}
          >
            <EditGradeIcon />
          </button>
          {isDesktop && (
            <button onClick={() => setShowProject((s) => !s)} title={t("btn.projectTitle")}>
              {showProject ? t("btn.hideProject") : t("btn.project")}
            </button>
          )}
          <button onClick={() => setShowSnapshots((s) => !s)} title={t("btn.snapshotsTitle")}>
            {showSnapshots ? t("btn.hideSnapshots") : t("btn.snapshots")}
            {snapshotCount > 0 ? ` (${snapshotCount})` : ""}
          </button>
          <button onClick={() => setShowLog((s) => !s)} title={t("btn.logTitle")}>
            {showLog ? t("btn.hideLog") : t("btn.log")}
            {logCount > 0 ? ` (${logCount})` : ""}
          </button>
          <button onClick={onOpenModels} title={t("btn.modelsTitle")}>
            {t("btn.models")}
          </button>
          <button onClick={onToggleLang} title={t("label.langTitle")} className="lang-toggle">
            {t("label.lang")}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFilePicked(f);
          e.target.value = "";
        }}
      />
    </header>
  );
}
