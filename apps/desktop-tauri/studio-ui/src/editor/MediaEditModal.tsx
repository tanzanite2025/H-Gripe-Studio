import { MaskEditModal } from "./MaskEditModal";
import type { CropCommit } from "./CropEditModal";
import type { EditorTab } from "./host/EditorHost";
import { useT } from "../i18n";
import type { MaskDocument } from "../types/production";

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
  initial?: MaskDocument | null;
  /** Draft sink: called on every edit so tab switches keep the document. */
  onDocChange?: (doc: MaskDocument) => void;
  onCommitMask: (edits: MaskDocument) => void;
  // Kept for EditorHost request compatibility; crop opens through editor:"crop".
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
  const headerExtra = (
    <>
      {onPickFile ? (
        <div className="media-edit-groups">
          <button className="media-edit-open" onClick={onPickFile} title={t("mediaEdit.openTitle")}>
            {t("mediaEdit.open")}
          </button>
        </div>
      ) : null}
      {tabStrip}
    </>
  );

  return (
    <MaskEditModal
      title={title}
      imagePath={imagePath}
      nodeId={nodeId}
      initial={initial ?? null}
      wandTolerance={24}
      onCommit={onCommitMask}
      onClose={onClose}
      onDocChange={onDocChange}
      headerExtra={headerExtra}
      hideTitle
      editorName={t("mediaEdit.editor")}
      workspace="image"
    />
  );
}
