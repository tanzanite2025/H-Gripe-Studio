import type {
  Dispatch,
  MouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";

import { WindowControls } from "./WindowControls";
import { startWindowDrag } from "../bridge/windowControls";
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

/** Model/API manager: connected local/API endpoints. */
export function ModelApiIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="5" width="6" height="6" rx="1.5" />
      <rect x="14" y="13" width="6" height="6" rx="1.5" />
      <path d="M10 8h2.5a3.5 3.5 0 0 1 3.5 3.5V13M14 16h-2.5A3.5 3.5 0 0 1 8 12.5V11" />
      <path d="M6.5 17.5h3M8 16v3" />
    </svg>
  );
}

/** Snapshots: named saved states. */
export function SnapshotIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 5.5 9.4 3h5.2L16 5.5" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

/** Run log: stacked text lines. */
export function LogIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

/** System settings module: a compact gear, placeholder until settings opens. */
export function SettingsIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2M12 18.5v2M4.6 7.8l1.7 1M17.7 15.2l1.7 1M4.6 16.2l1.7-1M17.7 8.8l1.7-1" />
      <path d="M7.3 4.8 8.5 7M15.5 17l1.2 2.2M4.8 12h2.4M16.8 12h2.4" />
    </svg>
  );
}

function beginWindowDrag(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  e.preventDefault();
  void startWindowDrag().catch(() => {});
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
  showSnapshots: boolean;
  setShowSnapshots: Dispatch<SetStateAction<boolean>>;
  showLog: boolean;
  setShowLog: Dispatch<SetStateAction<boolean>>;
  snapshotCount: number;
  logCount: number;

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
  showSnapshots,
  setShowSnapshots,
  showLog,
  setShowLog,
  snapshotCount,
  logCount,
  fileInputRef,
  onFilePicked,
}: ToolbarProps) {
  const t = useT();

  return (
    <header className="toolbar">
      <div className="toolbar-title-row" data-tauri-drag-region>
        <div className="toolbar-command-zone">{isDesktop && <WindowControls />}</div>
        <div
          className="toolbar-drag-spacer"
          data-tauri-drag-region
          onMouseDown={beginWindowDrag}
          aria-hidden="true"
        />

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
          <button
            type="button"
            title={t("btn.settingsTitle")}
            aria-label={t("btn.settings")}
            className="module-btn module-settings"
          >
            <SettingsIcon />
          </button>
          <button
            onClick={() => setShowSnapshots((s) => !s)}
            title={t("btn.snapshotsTitle")}
            aria-label={`${showSnapshots ? t("btn.hideSnapshots") : t("btn.snapshots")}${snapshotCount > 0 ? ` (${snapshotCount})` : ""}`}
            className={`module-btn module-snapshots${showSnapshots ? " active" : ""}`}
          >
            <SnapshotIcon />
            {snapshotCount > 0 ? <span className="module-count-badge">{snapshotCount}</span> : null}
          </button>
          <button
            onClick={() => setShowLog((s) => !s)}
            title={t("btn.logTitle")}
            aria-label={`${showLog ? t("btn.hideLog") : t("btn.log")}${logCount > 0 ? ` (${logCount})` : ""}`}
            className={`module-btn module-log${showLog ? " active" : ""}`}
          >
            <LogIcon />
            {logCount > 0 ? <span className="module-count-badge">{logCount}</span> : null}
          </button>
          <button
            onClick={onOpenModels}
            title={t("btn.modelsTitle")}
            aria-label={t("btn.models")}
            className="module-btn module-model"
          >
            <ModelApiIcon />
          </button>
          <button
            onClick={onToggleLang}
            title={t("label.langTitle")}
            aria-label={t("label.langTitle")}
            className="module-btn module-lang lang-toggle"
          >
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
