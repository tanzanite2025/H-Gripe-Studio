// Right-click context menu for a timeline clip: grade / edit / split-to-layers
// / remove actions, filtered by the clip's kind.

import { useT } from "../i18n";
import type { ClipKind } from "./timeline";

export interface TimelineClipMenuState {
  x: number;
  y: number;
  clipId: string;
  assetId: string;
  kind: ClipKind;
}

export function TimelineClipContextMenu({
  menu,
  onClose,
  onRemoveClip,
  onOpenImageEdit,
  onOpenAudioEdit,
  onOpenClipGrade,
  onSplitClipToLayers,
}: {
  menu: TimelineClipMenuState;
  onClose: () => void;
  onRemoveClip: (clipId: string) => void;
  onOpenImageEdit: (assetId: string) => void;
  onOpenAudioEdit: (clipId: string) => void;
  onOpenClipGrade: (clipId: string) => void;
  onSplitClipToLayers: (clipId: string) => void;
}) {
  const t = useT();
  return (
    <div
      className="production-clip-menu-backdrop"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="production-clip-menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {menu.kind !== "audio" ? (
          <button
            onClick={() => {
              onOpenClipGrade(menu.clipId);
              onClose();
            }}
          >
            {t("drawer.menuGrade")}
          </button>
        ) : null}
        {menu.kind === "still" ? (
          <button
            onClick={() => {
              onOpenImageEdit(menu.assetId);
              onClose();
            }}
          >
            {t("drawer.menuEditImage")}
          </button>
        ) : null}
        {menu.kind !== "audio" ? (
          <button
            onClick={() => {
              onSplitClipToLayers(menu.clipId);
              onClose();
            }}
          >
            {t("drawer.menuSplitLayers")}
          </button>
        ) : null}
        {menu.kind === "audio" ? (
          <button
            onClick={() => {
              onOpenAudioEdit(menu.clipId);
              onClose();
            }}
          >
            {t("drawer.menuEditAudio")}
          </button>
        ) : null}
        <button
          onClick={() => {
            onRemoveClip(menu.clipId);
            onClose();
          }}
        >
          {t("drawer.menuRemoveClip")}
        </button>
      </div>
    </div>
  );
}
