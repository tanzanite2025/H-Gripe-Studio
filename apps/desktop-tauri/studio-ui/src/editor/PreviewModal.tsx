import { useEffect, useRef, useState } from "react";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW, panView, zoomView, type ViewportViewState } from "../viewport/view";

// Shared "review gate" modal.
//
// Deliberately NOT Subject-Mask-specific: it is a generic, reusable surface you
// can drop after ANY stage to eyeball the current image / mask / result and
// decide whether to proceed. It exposes an optional `Edit` action that the
// caller wires to a heavier editor (e.g. the Mask-Edit modal) — the preview
// itself stays read-only and cheap. See docs/cards/subject-mask-matte.md
// (§ "Responsibility split").
//
// Like MediaViewer, it shows a backend-generated thumbnail (sized up) rather
// than decoding the raw original in the webview, so the canvas/media discipline
// is preserved. In browser preview the backend is mocked and returns an empty
// data URL, so we degrade to a path-only card.

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

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
  onClose: () => void;
}

function PreviewImage({ path, view }: { path: string; view: ViewportViewState }) {
  // Presented through the viewport host (image_edit viewport, CPU transport);
  // null in browser preview, where we degrade to a path-only card.
  const viewport = useViewportUnderlay("image_edit", path, 1280, view);

  if (viewport.underlay)
    return (
      <img
        className="media-viewer-img"
        src={viewport.underlay}
        alt={basename(path)}
        draggable={false}
      />
    );
  if (viewport.settled) return <p className="muted">preview unavailable (backend mocked)</p>;
  return <p className="muted">loading…</p>;
}

export function PreviewModal({ title, layers, caption, onEdit, onClose }: PreviewModalProps) {
  // Default to the first layer that actually has a path, else the first layer.
  const firstReady = Math.max(0, layers.findIndex((l) => !!l.path));
  const [active, setActive] = useState(firstReady === -1 ? 0 : firstReady);
  // Zoom/pan is viewport state shared across layer flips: wheel zooms (up to
  // 8x), dragging pans when zoomed, double-click resets. Keeping one view
  // while flipping image / mask / cutout compares the same region.
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layer = layers[active];
  const path = layer?.path ?? null;
  const isImage = path ? IMAGE_RE.test(path) : false;

  const handleWheel = (e: React.WheelEvent) => {
    if (!isImage) return;
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
            {onEdit ? (
              <button className="primary" onClick={onEdit} title="Open the mask editor">
                Edit
              </button>
            ) : null}
            <button onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>
        <div
          className="media-viewer-stage fit"
          ref={stageRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={() => setView(IDENTITY_VIEW)}
          style={view.zoom > 1 ? { cursor: dragRef.current ? "grabbing" : "grab" } : undefined}
        >
          {!path ? (
            <p className="muted">No “{layer?.label}” produced yet — run the node to generate it.</p>
          ) : !isImage ? (
            <p className="muted">No inline preview for this file type.</p>
          ) : (
            <PreviewImage path={path} view={view} />
          )}
        </div>
        {path ? <code className="media-viewer-path">{path}</code> : null}
      </div>
    </div>
  );
}
