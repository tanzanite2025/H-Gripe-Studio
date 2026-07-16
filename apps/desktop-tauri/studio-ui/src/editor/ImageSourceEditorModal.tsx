import { useMemo, useRef } from "react";
import { ImageEditorModal } from "./ImageEditorModal";
import type { CropCommit } from "./CropEditModal";
import type { EditorTab } from "./host/EditorHost";
import { useT } from "../i18n";
import { fromImageEditorDocument, toImageEditorDocument, type ImageDocument } from "./imageDocument";
import { imageDocumentEditBlock } from "./imageDocumentEditGuard";
import { serializeEditState, type EditState } from "./imageEditorState";

/**
 * The image card's single Edit entry.
 *
 * This component is the image editor surface. It is intentionally not a tab
 * container for crop, mask, model preview, or template preview. Those tools
 * should open as their own modal requests and may offer a manual-edit action
 * that returns to this editor.
 */
interface ImageSourceEditorModalProps {
  title: string;
  imagePath?: string | null;
  /** Opening context only. The image editor displays `imagePath`; node
   * context is used by the caller to save/commit back into the graph. */
  imageSourceDocumentKey?: string | null;
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

export function ImageSourceEditorModal({
  title,
  imagePath,
  imageSourceDocumentKey,
  onPickFile,
  tabs,
  onSelectTab,
  initial,
  onDocChange,
  onCommitMask,
  onClose,
}: ImageSourceEditorModalProps) {
  const t = useT();
  const editBlock = useMemo(() => (initial ? imageDocumentEditBlock(initial) : null), [initial]);
  // The image editor's contract is ImageDocument (image-kernel K1). Until the
  // grade-kernel render path lands (K2), the image editor remains the canvas,
  // so documents bridge losslessly at this boundary in both directions.
  const maskInitial = useMemo(() => {
    if (!initial || editBlock) return null;
    if (initial.editHistory) return initial.editHistory;
    return toImageEditorDocument(initial);
  }, [editBlock, initial]);
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
    onDocChange?.(fromImageEditorDocument(state.current, serializeEditState(state)));
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
              <span className="media-edit-light" title={t("imageSourceEditor.saved")} />
            ) : null}
            <span className="media-edit-tab-label">{tab.label}</span>
          </button>
        ))}
        {onPickFile ? (
          <button className="media-edit-tab-add" onClick={onPickFile} title={t("imageSourceEditor.openTitle")}>
            +
          </button>
        ) : null}
      </div>
    ) : null;
  const collapseArrow = (requestClose: () => void) => (
    <button className="media-edit-collapse" title={t("imageSourceEditor.collapse")} onClick={requestClose}>
      <svg viewBox="0 0 48 8" width="48" height="8" aria-hidden="true">
        <path d="M2 1.5 L24 6.5 L46 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );

  if (editBlock) {
    return (
      <div className="media-viewer-backdrop" onClick={onClose}>
        <div
          className="media-viewer image-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby="image-draft-block-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="media-viewer-bar">
            <span className="media-viewer-name" title={title}>{title}</span>
            <div className="media-viewer-actions">
              <button className="primary" disabled aria-label={t("mask.applyTitle")}>
                {t("mask.apply")}
              </button>
              <button onClick={onClose} title={t("mask.closeTitle")} aria-label={t("mask.close")}>
                {t("mask.close")}
              </button>
            </div>
          </div>
          {tabStrip ? <div className="media-viewer-tabs-row">{tabStrip}</div> : null}
          <div
            role="alert"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 32,
              textAlign: "center",
              background: "var(--panel)",
            }}
          >
            <strong id="image-draft-block-title">{t("imageSourceEditor.blockedTitle")}</strong>
            <span>{t("imageSourceEditor.blockedReason", { reason: editBlock.detail })}</span>
            <span className="muted">{t("imageSourceEditor.blockedUnchanged")}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ImageEditorModal
      key={imageSourceDocumentKey ?? "blank"}
      title={title}
      imagePath={imagePath}
      initial={maskInitial}
      wandTolerance={24}
      onCommit={(edits, state) => onCommitMask(fromImageEditorDocument(edits, serializeEditState(state)))}
      onClose={onClose}
      onEditStateChange={handleEditStateChange}
      headerCenter={collapseArrow}
      headerTabs={tabStrip}
      hideTitle
      editorName={t("imageSourceEditor.editor")}
      workspace="image"
    />
  );
}
