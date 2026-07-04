// Centre stage: the underlay frame plus the edit canvas, stacked in one
// document-space frame that the view's CSS transform moves as a unit.
// Rendering and pointer→image mapping live in the modal shell (which owns the
// document state); this is the presentation. The underlay presents the
// viewport host's rendered window at its rect in the full frame, so a zoomed
// canvas shows a frame decoded at matching detail (WGPU migration Phase 2).

import type { MutableRefObject } from "react";
import type { ViewportViewState } from "../../viewport/view";
import { isFitView, viewTransform, type CanvasView } from "../canvasView";

interface MaskStageProps {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  view: CanvasView;
  /** Presented underlay frame (a view window of the image), or null. */
  underlay: string | null;
  /** The window `underlay` was rendered for, placing it in the frame. */
  frameView: ViewportViewState;
  /** Transparency preview: hide the underlay (the canvas paints a backdrop). */
  overlayOnly: boolean;
  spacePan: boolean;
  toolId: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}

export function MaskStage({ canvasRef, dims, view, underlay, frameView, overlayOnly, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp }: MaskStageProps) {
  return (
    <div className="mask-edit-stage">
      <div
        className="mask-edit-frame"
        style={{
          aspectRatio: `${dims.w} / ${dims.h}`,
          maxWidth: `min(100%, ${dims.w}px)`,
          maxHeight: `min(100%, ${dims.h}px)`,
          transform: isFitView(view) ? undefined : viewTransform(view),
          transformOrigin: "center",
        }}
      >
        {underlay && !overlayOnly && (
          <img
            className="mask-edit-underlay"
            src={underlay}
            alt=""
            draggable={false}
            style={{
              left: `${frameView.panX * 100}%`,
              top: `${frameView.panY * 100}%`,
              width: `${100 / frameView.zoom}%`,
              height: `${100 / frameView.zoom}%`,
            }}
          />
        )}
        <canvas
          ref={canvasRef}
          className="mask-edit-canvas"
          style={{
            cursor: spacePan || toolId === "hand" ? "grab" : toolId === "zoom" ? "zoom-in" : toolId === "rotate_view" ? "crosshair" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
