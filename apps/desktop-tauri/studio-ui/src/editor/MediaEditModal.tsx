import { MaskEditModal } from "./MaskEditModal";
import type { CropCommit } from "./CropEditModal";
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
  /** Blank-editor "open image" entry (shown when there is no image yet). */
  onPickFile?: () => void;
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
  onCommitMask,
  onClose,
}: MediaEditModalProps) {
  const t = useT();
  const headerExtra =
    onPickFile && !imagePath ? (
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
      initial={null}
      wandTolerance={24}
      onCommit={onCommitMask}
      onClose={onClose}
      headerExtra={headerExtra}
      editorName={t("mediaEdit.editor")}
      workspace="image"
    />
  );
}
