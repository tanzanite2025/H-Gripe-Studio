import { useEffect, useState } from "react";
import { probeImageDims } from "../bridge/files";
import { useSettledView, useViewControls } from "../viewport/useViewControls";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { ViewportBackendBadge } from "../viewport/ViewportBackendBadge";
import { useT } from "../i18n";
import { isSupportedImagePath } from "../domain/mediaFormats";

// Shared "review gate" modal.
//
// Deliberately NOT Subject-Mask-specific: it is a generic, reusable surface you
// can drop after ANY stage to eyeball the current image / mask / result and
// decide whether to proceed. It exposes an optional `Edit` action that the
// caller wires to a heavier editor (e.g. the Image Editor modal) — the preview
// itself stays read-only and cheap. See docs/cards/subject-mask-matte.md
// (§ "Responsibility split").
//
// It presents through the shared viewport host rather than decoding the raw
// original in the webview, so the canvas/media discipline is preserved. In
// browser preview the backend is mocked and returns an empty data URL, so we
// degrade to a path-only card.

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

interface PreviewLayer {
  label: string;
  path: string | null | undefined;
}

interface PreviewModalProps {
  title: string;
  /** Layers to flip between (e.g. image / mask / cutout). Blank paths are kept
   * so the gate can still say "not produced yet". */
  layers: PreviewLayer[];
  /** Optional caption under the bar (e.g. mask coverage / mode). */
  caption?: string;
  /** When set, an `Edit` button is shown that opens the heavier editor. */
  onEdit?: () => void;
  /** When set, an entry that opens the standalone image editor over this
   * node's result (the node-result → image-editor pipeline). */
  onOpenImageEditor?: () => void;
  onClose: () => void;
}

export function PreviewModal({ title, layers, caption, onEdit, onOpenImageEditor, onClose }: PreviewModalProps) {
  const t = useT();
  // Default to the first layer that actually has a path, else the first layer.
  const firstReady = Math.max(0, layers.findIndex((l) => !!l.path));
  const [active, setActive] = useState(firstReady === -1 ? 0 : firstReady);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layer = layers[active];
  const path = layer?.path ?? null;
  const isImage = path ? isSupportedImagePath(path) : false;
  // Source pixel dimensions for the details row, from the file header only
  // (no decode); null in browser preview where the backend is mocked.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setDims(null);
    if (!path || !isImage) return;
    let cancelled = false;
    probeImageDims(path)
      .then((d) => {
        if (!cancelled && d && d.width && d.height) setDims({ w: d.width, h: d.height });
      })
      .catch(() => {
        /* leave the details row without dimensions */
      });
    return () => {
      cancelled = true;
    };
  }, [path, isImage]);
  // Zoom/pan is viewport state shared across layer flips, so flipping
  // image / mask / cutout compares the same region.
  const { view, stageProps } = useViewControls(isImage);
  // Full-detail re-renders wait for the view to settle; the live view rides
  // the surface's GPU crop fast path per tick below.
  const settledView = useSettledView(view);
  // The modal must always paint an in-webview frame. Native surface swap can
  // be enabled later for heavy editors, but a read-only preview popup cannot
  // risk reporting `presented` while the surface is hidden by the modal stack.
  const viewport = useViewportUnderlay(
    "image_edit",
    path && isImage ? path : undefined,
    1280,
    settledView,
    null,
    null,
    false,
    null,
    undefined,
    view,
  );
  // A zoomed frame is the `1/zoom` window of the source, so its natural size
  // shrinks with each zoom tick. Present it in the identity frame's box
  // (`dims`, stable across zoom) so the window magnifies instead of the
  // element shrinking in step — otherwise the on-screen scale never changes.
  const zoomedStyle =
    view.zoom > 1 && viewport.dims
      ? { width: viewport.dims.w, height: viewport.dims.h, objectFit: "contain" as const }
      : undefined;

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={title}>
            {title}
            {caption ? <span className="muted"> · {caption}</span> : null}
            {view.zoom > 1 ? <span className="muted"> · {Math.round(view.zoom * 100)}%</span> : null}
          </span>
          <div className="media-viewer-actions">
            {layers.length > 1 &&
              layers.map((l, i) => (
                <button
                  key={l.label}
                  className={i === active ? "active" : ""}
                  disabled={!l.path}
                  title={l.path ? l.label : `${l.label} (not produced yet)`}
                  onClick={() => setActive(i)}
                >
                  {l.label}
                </button>
              ))}
            {onOpenImageEditor ? (
              <button onClick={onOpenImageEditor} title={t("preview.openImageEditorTitle")}>
                {t("preview.openImageEditor")}
              </button>
            ) : null}
            {onEdit ? (
              <button className="primary" onClick={onEdit} title="Open the image editor">
                Edit
              </button>
            ) : null}
            <button onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>
        <div
          className={`media-viewer-stage fit${viewport.presented ? " presented" : ""}`}
          {...stageProps}
        >
          {!path ? (
            <p className="muted">No “{layer?.label}” produced yet — run the node to generate it.</p>
          ) : !isImage ? (
            <p className="muted">No inline preview for this file type.</p>
          ) : viewport.underlay ? (
            <>
              <img
                className="media-viewer-img"
                src={viewport.underlay}
                alt={basename(path)}
                draggable={false}
                style={zoomedStyle}
              />
              <ViewportBackendBadge backend={viewport.backend} />
            </>
          ) : viewport.presented ? (
            <ViewportBackendBadge backend={viewport.backend} />
          ) : viewport.settled ? (
            <p className="muted">preview unavailable (backend mocked)</p>
          ) : (
            <p className="muted">loading…</p>
          )}
        </div>
        {path ? (
          <div className="media-viewer-details">
            <span className="media-viewer-detail-name" title={path}>
              {basename(path)}
            </span>
            {dims ? (
              <span className="media-viewer-detail-dims">
                {dims.w}×{dims.h}
              </span>
            ) : null}
            <code className="media-viewer-path">{path}</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}
