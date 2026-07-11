import { useEffect, useRef, useState } from "react";

import { useT, type MsgKey } from "../i18n";
import { loadMediaAssetThumbnailDataUrl } from "./mediaAssetAnalysis";
import type { MediaAsset, MediaAssetKind } from "./mediaBin";

/** Pixels of pointer travel before an armed press becomes an asset drag. */
const DRAG_START_THRESHOLD_PX = 4;

function MediaAssetThumbnail({ asset }: { asset: MediaAsset }) {
  const [thumbnailDataUrl, setThumbnailDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadMediaAssetThumbnailDataUrl(asset.kind, asset.path).then((dataUrl) => {
      if (!cancelled) setThumbnailDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [asset.kind, asset.path]);

  return (
    <span className={`production-bin-thumb kind-${asset.kind}`} aria-hidden="true">
      {thumbnailDataUrl ? (
        <img src={thumbnailDataUrl} alt="" draggable={false} />
      ) : (
        <span className="production-bin-thumb-glyph">
          {asset.kind === "audio" ? "\u266a" : asset.kind === "video" ? "\u25b6" : "\u25a3"}
        </span>
      )}
    </span>
  );
}

export interface AddableAsset {
  kind: MediaAssetKind;
  path: string;
  sourceNodeId: string;
}

interface MediaWorkspacePopoverProps {
  assets: MediaAsset[];
  activeAssetId: string | null;
  addableAsset: AddableAsset | null;
  onAddSelected: () => void;
  onImportMedia?: () => void;
  onClose: () => void;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  onOpenImageEdit: (assetId: string) => void;
  onDragAssetChange: (assetId: string | null) => void;
}

function kindKey(kind: MediaAssetKind): MsgKey {
  return kind === "image" ? "drawer.kindImage" : kind === "video" ? "drawer.kindVideo" : "drawer.kindAudio";
}

export function mediaAssetKindLabel(kind: MediaAssetKind, t: (key: MsgKey) => string): string {
  return t(kindKey(kind));
}

export function MediaWorkspacePopover({
  assets,
  activeAssetId,
  addableAsset,
  onAddSelected,
  onImportMedia,
  onClose,
  onSelectAsset,
  onRemoveAsset,
  onOpenImageEdit,
  onDragAssetChange,
}: MediaWorkspacePopoverProps) {
  const t = useT();
  // Pointer-based drag: Tauri's native drag-drop handler (needed for OS file
  // drops) suppresses HTML5 drag events inside the WebView, so asset dragging
  // is armed on pointerdown and starts once the pointer travels far enough.
  const dragArm = useRef<{ assetId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const arm = dragArm.current;
      if (!arm) return;
      if (Math.hypot(e.clientX - arm.x, e.clientY - arm.y) < DRAG_START_THRESHOLD_PX) return;
      dragArm.current = null;
      onSelectAsset(arm.assetId);
      onDragAssetChange(arm.assetId);
    };
    const onUp = () => {
      dragArm.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onSelectAsset, onDragAssetChange]);

  return (
    <aside
      className="production-bin production-bin-popover"
      aria-label={t("drawer.binTitle")}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
      }}
    >
      <div className="production-bin-head">
        <h3>{t("drawer.binTitle")}</h3>
        <div className="spacer" />
        <button
          onClick={onImportMedia}
          disabled={!onImportMedia}
          title={t("drawer.importMediaTitle")}
        >
          {t("drawer.importMedia")}
        </button>
        <button
          onClick={onAddSelected}
          disabled={!addableAsset}
          title={t("drawer.addSelectedTitle")}
        >
          {t("drawer.addSelected")}
        </button>
        <button
          className="production-bin-close"
          onClick={onClose}
          title={t("drawer.closeBin")}
        >
          ×
        </button>
      </div>
      <p className="production-bin-drop-hint">{t("drawer.importDropHint")}</p>
      {assets.length === 0 ? (
        <p className="production-bin-empty">{t("drawer.binEmpty")}</p>
      ) : (
        <ul className="production-bin-list">
          {assets.map((a) => (
            <li key={a.id} className={a.id === activeAssetId ? "active" : ""}>
              <button
                className="production-bin-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("application/x-hgripe-asset", a.id);
                  onSelectAsset(a.id);
                  onDragAssetChange(a.id);
                }}
                onDragEnd={() => onDragAssetChange(null)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragArm.current = { assetId: a.id, x: e.clientX, y: e.clientY };
                }}
                onClick={() => onSelectAsset(a.id === activeAssetId ? null : a.id)}
                onContextMenu={(e) => {
                  if (a.kind !== "image") return;
                  e.preventDefault();
                  onSelectAsset(a.id);
                  onOpenImageEdit(a.id);
                }}
                title={a.kind === "image" ? `${a.path} · ${t("drawer.imageEditHint")}` : a.path}
              >
                <MediaAssetThumbnail asset={a} />
                <span className="production-bin-meta">
                  <span className="production-bin-name">{a.name}</span>
                  <span className={`production-bin-kind kind-${a.kind}`}>{mediaAssetKindLabel(a.kind, t)}</span>
                </span>
              </button>
              <button
                className="production-bin-remove"
                onClick={() => onRemoveAsset(a.id)}
                title={t("drawer.removeTitle")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
