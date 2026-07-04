import { useEffect, useRef, useState } from "react";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW, panView, zoomView, type ViewportViewState } from "../viewport/view";

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
  // Zoom/pan is viewport state: wheel zooms (up to 8x), dragging pans when
  // zoomed, double-click resets. The viewport crops its cached source proxy,
  // so a view tick never re-decodes the image.
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const isImage = IMAGE_RE.test(path);
  // Presented through the viewport host (image_edit viewport, CPU transport):
  // stays null in browser preview, where we degrade to a path-only card.
  const viewport = useViewportUnderlay("image_edit", isImage ? path : undefined, 1280, view);
  const src = viewport.underlay;
  const dims = viewport.dims;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  const handleWheel = (e: React.WheelEvent) => {
    if (!src) return;
    setView((v) => zoomView(v, e.deltaY < 0 ? 1.25 : 0.8));
  };
  const handlePointerDown = (e: React.PointerEvent) => {
    if (view.zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const from = dragRef.current;
    const stage = stageRef.current;
    if (!from || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => panView(v, dx, dy, rect.width, rect.height));
  };
  const handlePointerUp = () => {
    dragRef.current = null;
  };

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
            {isImage && src ? (
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
          className={`media-viewer-stage ${actualSize ? "actual" : "fit"}`}
          ref={stageRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={() => setView(IDENTITY_VIEW)}
          style={view.zoom > 1 ? { cursor: dragRef.current ? "grabbing" : "grab" } : undefined}
        >
          {!isImage ? (
            <p className="muted">No inline preview for this file type. Original path:</p>
          ) : src ? (
            <img className="media-viewer-img" src={src} alt={basename(path)} />
          ) : viewport.settled ? (
            <p className="muted">preview unavailable (backend mocked)</p>
          ) : (
            <p className="muted">loading…</p>
          )}
        </div>
        <code className="media-viewer-path">{path}</code>
      </div>
    </div>
  );
}
