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
  /** Per-tab file actions; a non-active tab is activated first. */
  onSaveTab: (id: string) => void;
  onSaveAsTab: (id: string) => void;
  /** Set (or clear, with null) a tab's display name. */
  onRenameTab: (id: string, name: string | null) => void;
  /** Project-level batch: run every open canvas (multi-canvas plan Phase 5). */
  onRunProject: () => void;
  /** Disables the project run while any run is in flight. */
  running: boolean;
}

export function CanvasTabs({
  tabs,
  activeId,
  activePath,
  activeDirty,
  onActivate,
  onClose,
  onNewCanvas,
  onSaveTab,
  onSaveAsTab,
  onRenameTab,
  onRunProject,
  running,
}: CanvasTabsProps) {
  const t = useT();
  const untitled = t("status.untitled");
  // Open tab menu (dropdown is position:fixed so the scrollable tab row
  // cannot clip it; the anchor point comes from the toggle button).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuId = menu?.id ?? null;
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Close the tab menu on any click outside the row or on Escape.
  useEffect(() => {
    if (!menuId) return;
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
  }, [menuId]);

  const rename = (id: string, currentTitle: string) => {
    const input = window.prompt(t("canvasTabs.renamePrompt"), currentTitle);
    if (input === null) return;
    const name = input.trim();
    onRenameTab(id, name ? name : null);
  };

  return (
    <div className="canvas-tabs" role="tablist" ref={rowRef}>
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
              {dirty ? " *" : ""}
            </span>
            <button
              className="canvas-tab-menu-button"
              aria-label={t("canvasTabs.menu")}
              title={t("canvasTabs.menu")}
              aria-expanded={menuId === tab.id}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu((cur) =>
                  cur?.id === tab.id ? null : { id: tab.id, x: rect.left, y: rect.bottom + 4 },
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
                  onClick={() => {
                    setMenu(null);
                    onSaveTab(tab.id);
                  }}
                >
                  {t("canvasTabs.save")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    onSaveAsTab(tab.id);
                  }}
                >
                  {t("canvasTabs.saveAs")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    rename(tab.id, title);
                  }}
                >
                  {t("canvasTabs.rename")}
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
        onClick={onNewCanvas}
      >
        +
      </button>
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
