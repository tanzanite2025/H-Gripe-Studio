import { useMemo, useRef, useState } from "react";
import { MaskEditModal } from "./MaskEditModal";
import type { CropCommit } from "./CropEditModal";
import type { EditorTab } from "./host/EditorHost";
import { useT } from "../i18n";
import type { MaskDocument } from "../types/production";
import { fromMaskDocument, toMaskDocument, type ImageDocument } from "./imageDocument";

/**
 * The image card's single Edit entry.
 *
 * This component is the image editor surface. It is intentionally not a tab
 * container for crop, mask, model preview, or template preview. Those tools
 * should open as their own modal requests and may offer a manual-edit action
 * that returns to this editor.
 */
interface MediaEditModalProps {
  title: string;
  imagePath?: string | null;
  /** Node whose output backs the underlay, for a `node_output` target. */
  nodeId?: string | null;
  /** "Open image" entry: lands the picked file on a new image card / tab. */
  onPickFile?: () => void;
  /** Open-document tabs (PS-style top strip); clicking switches targets. */
  tabs?: EditorTab[];
  onSelectTab?: (id: string) => void;
  /** In-progress edit document restored when the tab re-activates. */
  initial?: ImageDocument | null;
  /** Draft sink: called on the explicit save (the header light), never
   * automatically — closing with unsaved edits drops them. */
  onDocChange?: (doc: ImageDocument) => void;
  onCommitMask: (edits: ImageDocument) => void;
  // Kept for EditorHost request compatibility; the crop tool records a
  // document step inside the editor instead of routing through this sink.
  onCommitCrop: (commit: CropCommit) => void;
  onClose: () => void;
}

export function MediaEditModal({
  title,
  imagePath,
  nodeId,
  onPickFile,
  tabs,
  onSelectTab,
  initial,
  onDocChange,
  onCommitMask,
  onClose,
}: MediaEditModalProps) {
  const t = useT();
  // The image editor's contract is ImageDocument (image-kernel K1). Until the
  // grade-kernel render path lands (K2), the mask editor remains the canvas,
  // so documents bridge losslessly at this boundary in both directions.
  const maskInitial = useMemo(() => (initial ? toMaskDocument(initial) : null), [initial]);
  // Explicit-save model: the editor mirrors every edit here, but the host
  // draft only updates when the user clicks the save light. Red = unsaved
  // edits (lost on close), green = saved (restored on reopen).
  const latestDoc = useRef<MaskDocument | null>(null);
  const seeded = useRef(false);
  const [dirty, setDirty] = useState(false);
  const handleDocChange = (doc: MaskDocument) => {
    latestDoc.current = doc;
    // The editor mirrors its initial document on mount; only later edits dirty.
    if (!seeded.current) {
      seeded.current = true;
      return;
    }
    setDirty(true);
  };
  const saveDraft = () => {
    if (!dirty || !latestDoc.current) return;
    onDocChange?.(fromMaskDocument(latestDoc.current));
    setDirty(false);
  };
  const tabStrip =
    tabs && tabs.length > 0 ? (
      <div className="media-edit-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            className={`media-edit-tab${tab.active ? " active" : ""}`}
            title={tab.label}
            onClick={() => {
              if (!tab.active) onSelectTab?.(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    ) : null;
  const saveLight = onDocChange ? (
    <button
      className={`media-edit-light${dirty ? " unsaved" : ""}`}
      title={dirty ? t("mediaEdit.unsaved") : t("mediaEdit.saved")}
      onClick={saveDraft}
    />
  ) : null;
  const collapseArrow = (
    <button className="media-edit-collapse" title={t("mediaEdit.collapse")} onClick={onClose}>
      <svg viewBox="0 0 48 8" width="48" height="8" aria-hidden="true">
        <path d="M2 1.5 L24 6.5 L46 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
  const headerExtra = onPickFile ? (
    <div className="media-edit-groups">
      <button className="media-edit-open" onClick={onPickFile} title={t("mediaEdit.openTitle")}>
        {t("mediaEdit.open")}
      </button>
    </div>
  ) : null;

  return (
    <MaskEditModal
      title={title}
      imagePath={imagePath}
      nodeId={nodeId}
      initial={maskInitial}
      wandTolerance={24}
      onCommit={(edits: MaskDocument) => onCommitMask(fromMaskDocument(edits))}
      onClose={onClose}
      onDocChange={handleDocChange}
      headerExtra={headerExtra}
      headerLeft={saveLight}
      headerCenter={collapseArrow}
      headerTabs={tabStrip}
      hideTitle
      editorName={t("mediaEdit.editor")}
      workspace="image"
    />
  );
}
