import { useEffect, useRef, useState } from "react";
import { useViewControls } from "../viewport/useViewControls";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { ViewportBackendBadge } from "../viewport/ViewportBackendBadge";

// Large image extensions we know how to display. Anything else falls back to a
// "open externally" hint rather than trying to decode it in the webview.
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

interface MediaViewerProps {
  path: string;
  onClose: () => void;
}

// Full-resolution media viewer (modal overlay). Big previews live here — never
// inside the node card — so the canvas stays light. We still go through the
// backend thumbnail command (at a large size) rather than decoding the raw
// original in the webview; the original path stays the source of truth and is
// shown for copy / external open.
export function MediaViewer({ path, onClose }: MediaViewerProps) {
  const [actualSize, setActualSize] = useState(false);
  const isImage = IMAGE_RE.test(path);
  // Presented through the viewport host (image_edit viewport, CPU transport):
  // stays null in browser preview, where we degrade to a path-only card.
  const { view, stageProps } = useViewControls(isImage);
  // Native surface presentation (surface swap): the frame presents on a
  // surface window placed at the stage's rect; actual-size mode scrolls the
  // frame, which the aspect-fit surface cannot represent, so it stays on the
  // PNG transport.
  const underlayAnchorRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewportUnderlay(
    "image_edit",
    isImage ? path : undefined,
    1280,
    view,
    null,
    underlayAnchorRef,
    !actualSize,
  );
  const src = viewport.underlay;
  const presented = viewport.presented;
  const dims = viewport.dims;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={path}>
            {basename(path)}
            {dims ? <span className="muted"> · {dims.w}×{dims.h}</span> : null}
            {view.zoom > 1 ? <span className="muted"> · {Math.round(view.zoom * 100)}%</span> : null}
          </span>
          <div className="media-viewer-actions">
            {isImage && (src || presented) ? (
              <button onClick={() => setActualSize((v) => !v)}>
                {actualSize ? "Fit" : "100%"}
              </button>
            ) : null}
            <button onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>
        <div
          className={`media-viewer-stage ${actualSize ? "actual" : "fit"}${presented ? " presented" : ""}`}
          {...stageProps}
        >
          <div ref={underlayAnchorRef} className="media-viewer-underlay-anchor" />
          {!isImage ? (
            <p className="muted">No inline preview for this file type. Original path:</p>
          ) : src ? (
            <img className="media-viewer-img" src={src} alt={basename(path)} />
          ) : presented ? null : viewport.settled ? (
            <p className="muted">preview unavailable (backend mocked)</p>
          ) : (
            <p className="muted">loading…</p>
          )}
          <ViewportBackendBadge backend={viewport.backend} />
        </div>
        <code className="media-viewer-path">{path}</code>
      </div>
    </div>
  );
}
