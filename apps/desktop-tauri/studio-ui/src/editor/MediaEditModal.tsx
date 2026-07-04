import { useState } from "react";
import { MaskEditModal } from "./MaskEditModal";
import { CropEditModal, type CropCommit } from "./CropEditModal";
import { useT } from "../i18n";
import type { MaskDocument } from "../types/production";

/**
 * The image card's single "Edit" entry. It hosts the manual (human-spatial)
 * editors behind one unified UI: a tool-group switcher in the bar flips between
 * the mask brush editor and the crop box editor on the *source* image. Nothing
 * is mutated until the user applies — at which point exactly one bound edit node
 * of the matching kind is spawned and run (see generic-media-card.md, Phase 4,
 * option A: "one editor, one result node per apply").
 */
export type MediaEditGroup = "mask" | "crop";

interface MediaEditModalProps {
  title: string;
  imagePath?: string | null;
  /** Node whose output backs the underlay, for a `node_output` target. */
  nodeId?: string | null;
  initialGroup?: MediaEditGroup;
  onCommitMask: (edits: MaskDocument) => void;
  onCommitCrop: (commit: CropCommit) => void;
  onClose: () => void;
}

export function MediaEditModal({
  title,
  imagePath,
  nodeId,
  initialGroup = "mask",
  onCommitMask,
  onCommitCrop,
  onClose,
}: MediaEditModalProps) {
  const t = useT();
  const [group, setGroup] = useState<MediaEditGroup>(initialGroup);

  const switcher = (
    <div className="media-edit-groups" role="tablist">
      <button
        role="tab"
        aria-selected={group === "mask"}
        className={group === "mask" ? "active" : ""}
        onClick={() => setGroup("mask")}
      >
        {t("mediaEdit.mask")}
      </button>
      <button
        role="tab"
        aria-selected={group === "crop"}
        className={group === "crop" ? "active" : ""}
        onClick={() => setGroup("crop")}
      >
        {t("mediaEdit.crop")}
      </button>
    </div>
  );

  if (group === "mask") {
    return (
      <MaskEditModal
        title={title}
        imagePath={imagePath}
        nodeId={nodeId}
        initial={null}
        wandTolerance={24}
        onCommit={onCommitMask}
        onClose={onClose}
        headerExtra={switcher}
        editorName={t("mediaEdit.editor")}
      />
    );
  }
  return (
    <CropEditModal
      title={title}
      imagePath={imagePath}
      nodeId={nodeId}
      initialMode="manual"
      initialBox={null}
      initialAspect="free"
      initialMargin={6}
      onCommit={onCommitCrop}
      onClose={onClose}
      headerExtra={switcher}
      editorName={t("mediaEdit.editor")}
    />
  );
}
