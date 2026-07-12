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
import type { CanvasView } from "../canvasView";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { InteractionResultLayer } from "./InteractionResultLayer";
import type { SceneFrame } from "./sceneFrame";
import type { SelectedLayerMoveSurface } from "./selectedLayerMove/selectedLayerMoveTypes";
import type { SelectedLayerMoveDraftStore } from "./selectedLayerMove/selectedLayerMoveDraftStore";
import { useSelectedLayerMoveDraftSnapshot } from "./selectedLayerMove/selectedLayerMoveDraftStore";
import { useSelectedLayerMoveFrameCache } from "./selectedLayerMove/selectedLayerMoveFrameCache";
import { useSelectedLayerMovePresentation } from "./selectedLayerMove/useSelectedLayerMovePresentation";
import { projectFrameInStage, projectedFrameStyle, type StageSize } from "./stageProjection";

interface ImageEditorStageProps {
  stageRef: MutableRefObject<HTMLDivElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  sceneFrame?: SceneFrame;
  stageSize?: StageSize | null;
  /** Whether a real document pixel size is known. The workspace remains
   * available without one, but no arbitrary placeholder document is shown. */
  documentAvailable: boolean;
  view: CanvasView;
  /** Browser-displayable rendered viewport frame URL, or null when native. */
  viewportFrameUrl: string | null;
  /** True when pixels are displayed by a native surface instead of an `<img>`. */
  isNativeSurfacePresented: boolean;
  /** Anchor the native surface window is placed under — the underlay
   * window's rect in the frame, tracked whether or not a frame presents. */
  nativeSurfacePlacementAnchorRef: MutableRefObject<HTMLDivElement | null>;
  /** The view window the rendered viewport frame represents. */
  viewportFrameView: ViewportViewState;
  /** Backend report for the rendered viewport frame. */
  viewportBackend: ViewportBackend | null;
  /** Transparency preview: hide the rendered frame (the canvas paints a backdrop). */
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
  selectedLayerId?: string | null;
  selectedLayerMoveSurface?: SelectedLayerMoveSurface | null;
  selectedLayerMoveDraftStore: SelectedLayerMoveDraftStore;
  layerMoveActive?: boolean;
  selectedLayerFrame?: SelectedLayerFrame | null;
  viewportTargetSettled?: boolean;
  contextActionBar?: ReactNode;
}

export function ImageEditorStage({ stageRef, canvasRef, dims, sceneFrame, stageSize = null, documentAvailable, view, viewportFrameUrl, isNativeSurfacePresented, nativeSurfacePlacementAnchorRef, viewportFrameView, viewportBackend, overlayOnly, cropView, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp, onContextMenu, brushCursor, brushCursorRef, liveSelectionOverlayRef, selectionDraft, activeSelection, antsPhase = 0, selectedLayerId = null, selectedLayerMoveSurface = null, selectedLayerMoveDraftStore, layerMoveActive = false, selectedLayerFrame = null, viewportTargetSettled = true, contextActionBar }: ImageEditorStageProps) {
  const liveLayerMoveDraft = useSelectedLayerMoveDraftSnapshot(selectedLayerMoveDraftStore);
  const selectedLayerMovePresentation = useSelectedLayerMovePresentation({
    layerMoveActive,
    moveDraft: liveLayerMoveDraft,
    selectedLayerMoveSurface,
    viewportTargetSettled,
  });
  const displayedSelectedLayerFrame = useSelectedLayerMoveFrameCache({
    selectedLayerId,
    resolvedFrame: selectedLayerFrame,
    layerMoveActive,
    liveLayerMoveDraft,
    displayedLayerMoveDraft: selectedLayerMovePresentation.displayedLayerMoveDraft,
    viewportTargetSettled,
  });
  const frame = sceneFrame ?? { x: 0, y: 0, w: Math.max(1, dims.w), h: Math.max(1, dims.h) };
  const windowRect = {
    left: `${viewportFrameView.panX * 100}%`,
    top: `${viewportFrameView.panY * 100}%`,
    width: `${100 / viewportFrameView.zoom}%`,
    height: `${100 / viewportFrameView.zoom}%`,
  };
  const cropRegion = cropView?.region ?? null;
  const cropW = cropRegion ? Math.max(1, cropRegion[2] - cropRegion[0]) : dims.w;
  const cropH = cropRegion ? Math.max(1, cropRegion[3] - cropRegion[1]) : dims.h;
  const projectedFrameRect = projectFrameInStage(
    stageSize,
    cropRegion ? cropW / cropH : frame.w / frame.h,
    view,
  );
  const projectedInteractionStyle = projectedFrameStyle(projectedFrameRect);
  const documentFrameStyle = projectedInteractionStyle
    ? {
        ...projectedInteractionStyle,
        position: "absolute" as const,
      }
    : null;
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
      ref={stageRef}
      className={`image-editor-stage${isNativeSurfacePresented && !overlayOnly ? " presented" : ""}`}
      style={spacePan ? { cursor: "grab" } : undefined}
      // Nothing on the stage is a native drag source: a stray drag-and-drop
      // shows the no-drop cursor and swallows the tool's pointer events.
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (spacePan && e.target === e.currentTarget) onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (spacePan && e.target === e.currentTarget) onPointerMove(e);
      }}
      onPointerUp={(e) => {
        if (spacePan && e.target === e.currentTarget) onPointerUp();
      }}
    >
      {documentFrameStyle ? (
        <div
          className={`image-editor-frame${cropRegion ? " cropped" : ""}`}
          style={{
            aspectRatio: cropRegion ? `${cropW} / ${cropH}` : `${frame.w} / ${frame.h}`,
            visibility: documentAvailable ? undefined : "hidden",
            pointerEvents: documentAvailable ? undefined : "none",
            ...documentFrameStyle,
          }}
        >
          <div className="image-editor-document-layer" style={documentLayerStyle}>
            <div
              className="image-editor-pixel-layer"
              style={selectedLayerMovePresentation.suppressPixelLayer ? { visibility: "hidden" } : undefined}
            >
              <div ref={nativeSurfacePlacementAnchorRef} className="image-editor-native-surface-anchor" style={windowRect} />
              {viewportFrameUrl && !overlayOnly && (
                <img
                  className="image-editor-viewport-frame-img"
                  src={viewportFrameUrl}
                  alt=""
                  draggable={false}
                  style={windowRect}
                />
              )}
            </div>
            <canvas
              ref={canvasRef}
              className="image-editor-canvas"
              style={{
                cursor: spacePan ? "grab" : toolId === "rotate_view" ? "crosshair" : brushCursor ? "none" : undefined,
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onContextMenu={onContextMenu}
            />
          </div>
        </div>
      ) : null}
      {projectedInteractionStyle ? (
        <InteractionResultLayer
          dims={dims}
          frame={frame}
          style={projectedInteractionStyle}
          selectedLayerMoveSurface={selectedLayerMoveSurface?.pixels ?? null}
          selectedLayerMoveDraft={selectedLayerMovePresentation.displayedLayerMoveDraft}
          selectedLayerFrame={displayedSelectedLayerFrame}
          selectionDraft={selectionDraft ?? null}
          activeSelection={activeSelection ?? null}
          antsPhase={antsPhase}
          liveSelectionOverlayRef={liveSelectionOverlayRef}
          brushCursor={brushCursor}
          brushCursorRef={brushCursorRef}
        />
      ) : null}
      {displayedSelectedLayerFrame ? contextActionBar : null}
      <ViewportBackendBadge backend={viewportBackend} />
    </div>
  );
}
