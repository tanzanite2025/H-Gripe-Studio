// Canvas tab row (multi-canvas workspace plan, Phase 3): one tab per open
// CanvasDocument. The project is the container; tabs switch which canvas the
// editor below shows. Purely presentational — the document store lives in
// useCanvasDocument.

import { useEffect, useRef, useState } from "react";
import { canvasDocumentTitle } from "./canvasDocument";
import type { CanvasTabInfo } from "./useCanvasDocument";
import { useT } from "../i18n";

interface CanvasTabsProps {
  tabs: CanvasTabInfo[];
  activeId: string;
  /** Active tab's live file state (the stored tab entry is stale). */
  activePath: string | null;
  activeDirty: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewCanvas: () => void;
  /** Open a workflow file via the system file picker (from the "+" menu). */
  onOpenFile: () => void;
  /** Per-tab file actions; a non-active tab is activated first. */
  onSaveTab: (id: string) => void;
  onSaveAsTab: (id: string) => void;
  /** Set (or clear, with null) a tab's display name. */
  onRenameTab: (id: string, name: string | null) => void;
  /** Dangerous per-tab actions, kept behind the "⋯" menu. */
  onResetTab: (id: string) => void;
  onClearTab: (id: string) => void;
  /** Project-level batch: run every open canvas (multi-canvas plan Phase 5). */
  onRunProject: () => void;
  /** Disables the project run while any run is in flight. */
  running: boolean;
}

function SaveAsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 4 H13 L17 8 V11 M4.5 12 V5 A1 1 0 0 1 5 4 M4.5 16 V19 A1 1 0 0 0 5.5 20 H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 12.5 L14.5 18 L12.5 20 H14.5 L16.5 18 L22 12.5 A1.4 1.4 0 0 0 20 12.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M16.5 4.5 L19.5 7.5 L8 19 H5 V16 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M14 7 L17 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SaveStateLight({ dirty }: { dirty: boolean }) {
  return <span className={`canvas-tab-save-light ${dirty ? "dirty" : "saved"}`} aria-hidden="true" />;
}

// Sentinel menu id for the "+" (new/open) dropdown, distinct from any tab id.
const NEW_MENU_ID = "__new__";

export function CanvasTabs({
  tabs,
  activeId,
  activePath,
  activeDirty,
  onActivate,
  onClose,
  onNewCanvas,
  onOpenFile,
  onSaveTab,
  onSaveAsTab,
  onRenameTab,
  onResetTab,
  onClearTab,
  onRunProject,
  running,
}: CanvasTabsProps) {
  const t = useT();
  const untitled = t("status.untitled");
  // Open "⋯" menu (dropdown is position:fixed so the scrollable strip cannot
  // clip it; the anchor point comes from the toggle button).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Close the menu on any click outside the row or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const rename = (id: string, currentTitle: string) => {
    const input = window.prompt(t("canvasTabs.renamePrompt"), currentTitle);
    if (input === null) return;
    const name = input.trim();
    onRenameTab(id, name ? name : null);
  };

  return (
    <div className="canvas-tabs" role="tablist" ref={rowRef}>
      <div className="canvas-tabs-strip">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const path = active ? activePath : tab.path;
          const dirty = active ? activeDirty : tab.dirty;
          const title = tab.name ?? canvasDocumentTitle(path, untitled);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={`canvas-tab${active ? " active" : ""}`}
              title={path ?? untitled}
              onClick={() => onActivate(tab.id)}
            >
              <span className="canvas-tab-title">
                {title}
              </span>
              <button
                className={`canvas-tab-action canvas-tab-save-state ${dirty ? "dirty" : "saved"}`}
                aria-label={dirty ? t("canvasTabs.unsavedState") : t("canvasTabs.savedState")}
                title={dirty ? t("canvasTabs.unsavedTitle") : t("canvasTabs.savedTitle")}
                onClick={(e) => {
                  e.stopPropagation();
                  onSaveTab(tab.id);
                }}
              >
                <SaveStateLight dirty={dirty} />
              </button>
              <button
                className="canvas-tab-action"
                aria-label={t("canvasTabs.saveAs")}
                title={t("canvasTabs.saveAs")}
                onClick={(e) => {
                  e.stopPropagation();
                  onSaveAsTab(tab.id);
                }}
              >
                <SaveAsIcon />
              </button>
              <button
                className="canvas-tab-action"
                aria-label={t("canvasTabs.rename")}
                title={t("canvasTabs.rename")}
                onClick={(e) => {
                  e.stopPropagation();
                  rename(tab.id, title);
                }}
              >
                <RenameIcon />
              </button>
              <button
                className="canvas-tab-action"
                aria-label={t("canvasTabs.more")}
                title={t("canvasTabs.more")}
                aria-expanded={menu?.id === tab.id}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu((cur) =>
                    cur?.id === tab.id ? null : { id: tab.id, x: rect.left, y: rect.bottom + 6 },
                  );
                }}
              >
                ⋯
              </button>
              <button
                className="canvas-tab-close"
                aria-label={t("canvasTabs.close")}
                title={t("canvasTabs.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
              {menu?.id === tab.id && (
                <div
                  className="canvas-tab-menu"
                  role="menu"
                  style={{ left: menu.x, top: menu.y }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setMenu(null);
                      if (window.confirm(t("canvasTabs.confirmReset"))) onResetTab(tab.id);
                    }}
                  >
                    {t("canvasTabs.reset")}
                  </button>
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setMenu(null);
                      if (window.confirm(t("canvasTabs.confirmClear"))) onClearTab(tab.id);
                    }}
                  >
                    {t("canvasTabs.clear")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <button
          className="canvas-tab-new"
          aria-label={t("canvasTabs.new")}
          title={t("canvasTabs.new")}
          aria-expanded={menu?.id === NEW_MENU_ID}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu((cur) =>
              cur?.id === NEW_MENU_ID ? null : { id: NEW_MENU_ID, x: rect.left, y: rect.bottom + 6 },
            );
          }}
        >
          +
        </button>
        {menu?.id === NEW_MENU_ID && (
          <div
            className="canvas-tab-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onNewCanvas();
              }}
            >
              {t("canvasTabs.newBlank")}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenFile();
              }}
            >
              {t("canvasTabs.openFile")}
            </button>
          </div>
        )}
      </div>
      {tabs.length > 1 && (
        <button
          className="canvas-tabs-run-project"
          aria-label={t("canvasTabs.runProject")}
          title={t("canvasTabs.runProjectTitle")}
          disabled={running}
          onClick={onRunProject}
        >
          {t("canvasTabs.runProject")}
        </button>
      )}
    </div>
  );
}
