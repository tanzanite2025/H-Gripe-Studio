import { useEffect } from "react";

import { useT } from "../i18n";
import { GradePanel, type GradeCommit } from "./GradePanel";

export type { GradeCommit };

// Thin modal wrapper around the embeddable GradePanel: backdrop, title bar
// and Escape-to-close. The op stack, live preview and apply logic live in
// GradePanel, which the production drawer's Grade tab embeds directly.

interface GradeEditModalProps {
  title: string;
  imagePath?: string | null;
  /** Node whose output is being graded, for a `node_output` preview target. */
  nodeId?: string | null;
  /** The node's current `grade_doc` param (JSON string), if any. */
  initialDoc?: string | null;
  onCommit: (commit: GradeCommit) => void;
  onClose: () => void;
}

export function GradeEditModal({ title, imagePath, nodeId, initialDoc, onCommit, onClose }: GradeEditModalProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer grade-edit" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={title}>
            {title} <span className="muted">· {t("grade.title")}</span>
          </span>
          <div className="media-viewer-actions">
            <button onClick={onClose} title={t("grade.closeTitle")}>
              ✕
            </button>
          </div>
        </div>
        <GradePanel
          imagePath={imagePath}
          nodeId={nodeId}
          initialDoc={initialDoc}
          onCommit={(commit) => {
            onCommit(commit);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
