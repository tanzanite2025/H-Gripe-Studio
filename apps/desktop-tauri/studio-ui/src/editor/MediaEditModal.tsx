import { useMemo, useRef } from "react";
import { MaskEditModal } from "./MaskEditModal";
import type { CropCommit } from "./CropEditModal";
import type { EditorTab } from "./host/EditorHost";
import { useT } from "../i18n";
import { fromMaskDocument, maskBridgeGap, toMaskDocument, type ImageDocument } from "./imageDocument";
import { serializeEditState, type EditState } from "./maskEdit";

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
  /** Draft sink: mirrors every edit, so collapsing / reopening the editor
   * restores the in-progress document (PS-style). */
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
  const maskInitial = useMemo(() => {
    if (!initial) return null;
    if (initial.editHistory) return initial.editHistory;
    const lowered = toMaskDocument(initial);
    // A draft that cannot lower opens as a blank document; surface why so
    // the restored-empty editor is diagnosable rather than silent.
    if (!lowered) console.warn(`image draft cannot lower to edit_paths (${maskBridgeGap(initial)}) — opening blank`);
    return lowered;
  }, [initial]);
  // Every edit mirrors straight into the host draft, so collapsing and
  // reopening the editor restores layers / history exactly as left. The tab
  // light reports the draft as saved; committing to the graph stays on the
  // explicit Apply.
  const seeded = useRef(false);
  const handleEditStateChange = (state: EditState) => {
    if (!seeded.current) {
      seeded.current = true;
      return;
    }
    onDocChange?.(fromMaskDocument(state.current, serializeEditState(state)));
  };
  const tabStrip =
    (tabs && tabs.length > 0) || onPickFile ? (
      <div className="media-edit-tabs" role="tablist">
        {(tabs ?? []).map((tab) => (
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
            {tab.active && onDocChange ? (
              // Per-document draft light: green — edits persist automatically.
              <span className="media-edit-light" title={t("mediaEdit.saved")} />
            ) : null}
            <span className="media-edit-tab-label">{tab.label}</span>
          </button>
        ))}
        {onPickFile ? (
          <button className="media-edit-tab-add" onClick={onPickFile} title={t("mediaEdit.openTitle")}>
            +
          </button>
        ) : null}
      </div>
    ) : null;
  const collapseArrow = (requestClose: () => void) => (
    <button className="media-edit-collapse" title={t("mediaEdit.collapse")} onClick={requestClose}>
      <svg viewBox="0 0 48 8" width="48" height="8" aria-hidden="true">
        <path d="M2 1.5 L24 6.5 L46 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );

  return (
    <MaskEditModal
      title={title}
      imagePath={imagePath}
      nodeId={nodeId}
      initial={maskInitial}
      wandTolerance={24}
      onCommit={(edits, state) => onCommitMask(fromMaskDocument(edits, serializeEditState(state)))}
      onClose={onClose}
      onEditStateChange={handleEditStateChange}
      headerCenter={collapseArrow}
      headerTabs={tabStrip}
      hideTitle
      editorName={t("mediaEdit.editor")}
      workspace="image"
    />
  );
}
