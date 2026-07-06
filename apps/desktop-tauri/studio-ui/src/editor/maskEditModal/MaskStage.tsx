// Centre stage: the underlay frame plus the edit canvas, stacked in one
// document-space frame that the view's CSS transform moves as a unit.
// Rendering and pointer→image mapping live in the modal shell (which owns the
// document state); this is the presentation. The underlay presents the
// viewport host's rendered window at its rect in the full frame, so a zoomed
// canvas shows a frame decoded at matching detail (WGPU migration Phase 2).

import type { MutableRefObject } from "react";
import type { ViewportBackend } from "../../bridge/viewport";
import { ViewportBackendBadge } from "../../viewport/ViewportBackendBadge";
import type { ViewportViewState } from "../../viewport/view";
import { isFitView, viewTransform, type CanvasView } from "../canvasView";
import type { TransformParams } from "../maskEdit";

interface MaskStageProps {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  view: CanvasView;
  /** Presented underlay frame (a view window of the image), or null. */
  underlay: string | null;
  /** The frame is on the native surface window below the webview (surface
   * swap): no `<img>` mounts and the stage keeps the hole see-through. */
  presented: boolean;
  /** Anchor the native surface window is placed under — the underlay
   * window's rect in the frame, tracked whether or not a frame presents. */
  underlayRef: MutableRefObject<HTMLDivElement | null>;
  /** The window `underlay` was rendered for, placing it in the frame. */
  frameView: ViewportViewState;
  /** Image-workspace layer transform (move tool / free transform), applied
   * to the underlay as CSS: the render target keeps the source untouched,
   * so the stage carries the recorded move on the presented window. */
  imageTransform?: TransformParams | null;
  /** Backend report of the presented underlay frame (fallback contract). */
  backend: ViewportBackend | null;
  /** Transparency preview: hide the underlay (the canvas paints a backdrop). */
  overlayOnly: boolean;
  /** Image workspace: the background pixel layer is hidden — the frame
   * shows the transparency checkerboard instead of the source frame. */
  baseHidden?: boolean;
  spacePan: boolean;
  toolId: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  /** PS-style brush cursor: the tip's outline (image px) for brush-sized
   * tools, or null (no outline). Position is driven imperatively through
   * `brushCursorRef` (left/top %) to avoid re-rendering per pointer move. */
  brushCursor: { diameter: number } | null;
  brushCursorRef: MutableRefObject<HTMLDivElement | null>;
}

export function MaskStage({ canvasRef, dims, view, underlay, presented, underlayRef, frameView, imageTransform, backend, overlayOnly, baseHidden, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp, brushCursor, brushCursorRef }: MaskStageProps) {
  // Percentages are of the window element's own size (1/zoom of the frame):
  // an image-pixel delta is `px / dims · zoom` element-widths, and the image
  // centre (the op's scale/rotate pivot) sits at `(0.5 − pan) · zoom`.
  const layerStyle = imageTransform
    ? {
        transform: `translate(${(imageTransform.dx / dims.w) * frameView.zoom * 100}%, ${(imageTransform.dy / dims.h) * frameView.zoom * 100}%) rotate(${imageTransform.rotate}deg) scale(${imageTransform.scale})`,
        transformOrigin: `${(0.5 - frameView.panX) * frameView.zoom * 100}% ${(0.5 - frameView.panY) * frameView.zoom * 100}%`,
      }
    : null;
  const windowRect = {
    left: `${frameView.panX * 100}%`,
    top: `${frameView.panY * 100}%`,
    width: `${100 / frameView.zoom}%`,
    height: `${100 / frameView.zoom}%`,
    ...layerStyle,
  };
  return (
    <div
      className={`mask-edit-stage${presented && !overlayOnly ? " presented" : ""}`}
      // Nothing on the stage is a native drag source: a stray drag-and-drop
      // shows the no-drop cursor and swallows the tool's pointer events.
      onDragStart={(e) => e.preventDefault()}
    >
      <div
        className={`mask-edit-frame${baseHidden ? " base-hidden" : ""}`}
        style={{
          aspectRatio: `${dims.w} / ${dims.h}`,
          maxWidth: `min(100%, ${dims.w}px)`,
          maxHeight: `min(100%, ${dims.h}px)`,
          transform: isFitView(view) ? undefined : viewTransform(view),
          transformOrigin: "center",
        }}
      >
        <div ref={underlayRef} className="mask-edit-underlay-anchor" style={windowRect} />
        {underlay && !overlayOnly && (
          <img
            className="mask-edit-underlay"
            src={underlay}
            alt=""
            draggable={false}
            style={windowRect}
          />
        )}
        <canvas
          ref={canvasRef}
          className="mask-edit-canvas"
          style={{
            cursor: spacePan || toolId === "hand" ? "grab" : toolId === "zoom" ? "zoom-in" : toolId === "rotate_view" ? "crosshair" : brushCursor ? "none" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {brushCursor ? (
          <div
            ref={brushCursorRef}
            className="mask-brush-cursor"
            style={{
              width: `${(brushCursor.diameter / dims.w) * 100}%`,
              height: `${(brushCursor.diameter / dims.h) * 100}%`,
              display: "none",
            }}
          />
        ) : null}
      </div>
      <ViewportBackendBadge backend={backend} />
    </div>
  );
}
