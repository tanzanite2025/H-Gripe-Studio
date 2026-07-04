// Canvas tab row (multi-canvas workspace plan, Phase 3): one tab per open
// CanvasDocument. The project is the container; tabs switch which canvas the
// editor below shows. Purely presentational — the document store lives in
// useCanvasDocument.

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
}

export function CanvasTabs({
  tabs,
  activeId,
  activePath,
  activeDirty,
  onActivate,
  onClose,
  onNewCanvas,
}: CanvasTabsProps) {
  const t = useT();
  const untitled = t("status.untitled");

  return (
    <div className="canvas-tabs" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const path = active ? activePath : tab.path;
        const dirty = active ? activeDirty : tab.dirty;
        const title = canvasDocumentTitle(path, untitled);
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
    </div>
  );
}
