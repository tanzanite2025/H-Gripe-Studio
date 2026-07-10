// Centre stage: the underlay frame plus the edit canvas, stacked in one
// document-space frame that the view's CSS transform moves as a unit.
// Rendering and pointer→image mapping live in the modal shell (which owns the
// document state); this is the presentation. The underlay presents the
// viewport host's rendered window at its rect in the full frame, so a zoomed
// canvas shows a frame decoded at matching detail (WGPU migration Phase 2).

import type { MutableRefObject, ReactNode } from "react";
import type { ViewportBackend } from "../../bridge/viewport";
import { ViewportBackendBadge } from "../../viewport/ViewportBackendBadge";
import type { ViewportViewState } from "../../viewport/view";
import { isFitView, viewTransform, type CanvasView } from "../canvasView";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { SelectionOverlay } from "./SelectionOverlay";

interface MaskStageProps {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  /** Whether a real document pixel size is known. The workspace remains
   * available without one, but no arbitrary placeholder document is shown. */
  documentAvailable: boolean;
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
  /** Backend report of the presented underlay frame (fallback contract). */
  backend: ViewportBackend | null;
  /** Transparency preview: hide the underlay (the canvas paints a backdrop). */
  overlayOnly: boolean;
  /** Confirmed image crop: show only this original-image rect, PS-style. */
  cropView?: { region: [number, number, number, number] } | null;
  spacePan: boolean;
  toolId: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** PS-style brush cursor: the tip's outline (image px) for brush-sized
   * tools, or null (no outline). Position is driven imperatively through
   * `brushCursorRef` (left/top %) to avoid re-rendering per pointer move. */
  brushCursor: { diameter: number } | null;
  brushCursorRef: MutableRefObject<HTMLDivElement | null>;
  liveSelectionOverlayRef: MutableRefObject<SVGSVGElement | null>;
  selectionDraft?: SelectionDraft | null;
  activeSelection?: ActiveSelection | null;
  antsPhase?: number;
  contextActionBar?: ReactNode;
}

export function MaskStage({ canvasRef, dims, documentAvailable, view, underlay, presented, underlayRef, frameView, backend, overlayOnly, cropView, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp, onContextMenu, brushCursor, brushCursorRef, liveSelectionOverlayRef, selectionDraft, activeSelection, antsPhase = 0, contextActionBar }: MaskStageProps) {
  const windowRect = {
    left: `${frameView.panX * 100}%`,
    top: `${frameView.panY * 100}%`,
    width: `${100 / frameView.zoom}%`,
    height: `${100 / frameView.zoom}%`,
  };
  const cropRegion = cropView?.region ?? null;
  const cropW = cropRegion ? Math.max(1, cropRegion[2] - cropRegion[0]) : dims.w;
  const cropH = cropRegion ? Math.max(1, cropRegion[3] - cropRegion[1]) : dims.h;
  const documentLayerStyle = cropRegion
    ? {
        left: `${-(cropRegion[0] / cropW) * 100}%`,
        top: `${-(cropRegion[1] / cropH) * 100}%`,
        width: `${(dims.w / cropW) * 100}%`,
        height: `${(dims.h / cropH) * 100}%`,
      }
    : undefined;
  return (
    <div
      className={`mask-edit-stage${presented && !overlayOnly ? " presented" : ""}`}
      style={spacePan || toolId === "hand" ? { cursor: "grab" } : undefined}
      // Nothing on the stage is a native drag source: a stray drag-and-drop
      // shows the no-drop cursor and swallows the tool's pointer events.
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if ((spacePan || toolId === "hand") && e.target === e.currentTarget) onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if ((spacePan || toolId === "hand") && e.target === e.currentTarget) onPointerMove(e);
      }}
      onPointerUp={(e) => {
        if ((spacePan || toolId === "hand") && e.target === e.currentTarget) onPointerUp();
      }}
    >
      <div
        className={`mask-edit-frame${cropRegion ? " cropped" : ""}`}
        style={{
          aspectRatio: `${cropW} / ${cropH}`,
          maxWidth: "100%",
          maxHeight: "100%",
          visibility: documentAvailable ? undefined : "hidden",
          pointerEvents: documentAvailable ? undefined : "none",
          transform: isFitView(view) ? undefined : viewTransform(view),
          transformOrigin: "center",
        }}
      >
        <div className="mask-edit-document-layer" style={documentLayerStyle}>
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
              cursor: spacePan || toolId === "hand" ? "grab" : toolId === "rotate_view" ? "crosshair" : brushCursor ? "none" : undefined,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onContextMenu={onContextMenu}
          />
          <SelectionOverlay
            dims={dims}
            draft={selectionDraft ?? null}
            active={activeSelection ?? null}
            phase={antsPhase}
          />
          <svg
            ref={liveSelectionOverlayRef}
            className="mask-selection-overlay mask-selection-live-overlay"
            viewBox={`0 0 ${dims.w} ${dims.h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect
              data-live-selection-shape="rect"
              className="mask-selection-draft-path"
              vectorEffect="non-scaling-stroke"
              style={{ display: "none" }}
            />
            <ellipse
              data-live-selection-shape="ellipse"
              className="mask-selection-draft-path"
              vectorEffect="non-scaling-stroke"
              style={{ display: "none" }}
            />
            <polyline
              data-live-selection-shape="polyline"
              className="mask-selection-draft-path"
              vectorEffect="non-scaling-stroke"
              style={{ display: "none" }}
            />
          </svg>
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
          {contextActionBar}
        </div>
      </div>
      <ViewportBackendBadge backend={backend} />
    </div>
  );
}
