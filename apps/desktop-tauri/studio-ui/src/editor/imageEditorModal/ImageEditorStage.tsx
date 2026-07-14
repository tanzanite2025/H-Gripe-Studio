// Centre stage: one geometry-only pasteboard world containing the document,
// viewport pixels and interaction geometry. The camera projects that parent;
// it never changes the compositor target or allocates pasteboard pixels.
// The modal shell owns document state and pointer-to-document mapping; this
// component owns only the shared presentation hierarchy.

import type { MutableRefObject, ReactNode } from "react";
import type { ViewportBackend } from "../../bridge/viewport";
import { ViewportBackendBadge } from "../../viewport/ViewportBackendBadge";
import type { ViewportViewState } from "../../viewport/view";
import type { CanvasView } from "../canvasView";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { InteractionResultLayer } from "./InteractionResultLayer";
import type { SceneFrame } from "./sceneFrame";
import {
  frameClipWithinWorldStyle,
  frameWithinWorldStyle,
  projectedFrameStyle,
  projectWorldFrameInStage,
  type StageSize,
} from "./stageProjection";
import { ViewportFrameLayer } from "./ViewportFrameLayer";

interface ImageEditorStageProps {
  stageRef: MutableRefObject<HTMLDivElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  renderFrame: SceneFrame;
  logicalPasteboard: SceneFrame;
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
  selectedLayerFrame?: SelectedLayerFrame | null;
  contextActionBar?: ReactNode;
}

function isStagePanBackground(target: EventTarget, stage: HTMLDivElement): boolean {
  return target === stage
    || (target instanceof HTMLElement && target.dataset.imageEditorPanBackground === "true");
}

export function ImageEditorStage({ stageRef, canvasRef, dims, renderFrame, logicalPasteboard, stageSize = null, documentAvailable, view, viewportFrameUrl, isNativeSurfacePresented, nativeSurfacePlacementAnchorRef, viewportFrameView, viewportBackend, overlayOnly, cropView, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp, onContextMenu, brushCursor, brushCursorRef, liveSelectionOverlayRef, selectionDraft, activeSelection, antsPhase = 0, selectedLayerFrame = null, contextActionBar }: ImageEditorStageProps) {
  const documentPixelsPresented = documentAvailable
    && !overlayOnly
    && (isNativeSurfacePresented || Boolean(viewportFrameUrl));
  const displayedSelectedLayerFrame = documentPixelsPresented
    ? selectedLayerFrame
    : null;
  const frame = renderFrame;
  const cropRegion = cropView?.region ?? null;
  const cropW = cropRegion ? Math.max(1, cropRegion[2] - cropRegion[0]) : dims.w;
  const cropH = cropRegion ? Math.max(1, cropRegion[3] - cropRegion[1]) : dims.h;
  const fitFrame = cropRegion
    ? { x: cropRegion[0], y: cropRegion[1], w: cropW, h: cropH }
    : frame;
  const projectedWorldRect = projectWorldFrameInStage(
    stageSize,
    logicalPasteboard,
    fitFrame,
    view,
  );
  const projectedWorldStyle = projectedFrameStyle(projectedWorldRect);
  const fitFrameWithinWorldStyle = frameWithinWorldStyle(fitFrame, logicalPasteboard);
  const documentWithinFitFrameStyle = frameWithinWorldStyle(frame, fitFrame);
  const pixelClipStyle = cropRegion
    ? frameClipWithinWorldStyle(fitFrame, logicalPasteboard)
    : undefined;
  const worldStyle = projectedWorldStyle
    ? {
        ...projectedWorldStyle,
        position: "absolute" as const,
      }
    : null;
  return (
    <div
      ref={stageRef}
      className={`image-editor-stage${isNativeSurfacePresented && !overlayOnly ? " presented" : ""}`}
      style={spacePan ? { cursor: "grab" } : undefined}
      // Nothing on the stage is a native drag source: a stray drag-and-drop
      // shows the no-drop cursor and swallows the tool's pointer events.
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if ((spacePan || toolId === "move") && isStagePanBackground(e.target, e.currentTarget)) onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if ((spacePan || toolId === "move") && isStagePanBackground(e.target, e.currentTarget)) onPointerMove(e);
      }}
      onPointerUp={(e) => {
        if ((spacePan || toolId === "move") && isStagePanBackground(e.target, e.currentTarget)) onPointerUp();
      }}
    >
      {worldStyle && fitFrameWithinWorldStyle && documentWithinFitFrameStyle ? (
        <div
          className="image-editor-world"
          data-image-editor-pan-background="true"
          style={{
            visibility: documentAvailable ? undefined : "hidden",
            pointerEvents: documentAvailable ? undefined : "none",
            ...worldStyle,
          }}
        >
          <div
            className="image-editor-pasteboard-boundary"
            data-image-editor-pan-background="true"
            aria-hidden="true"
          />
          <ViewportFrameLayer
            frameUrl={viewportFrameUrl}
            frameView={viewportFrameView}
            overlayOnly={overlayOnly}
            nativeSurfacePlacementAnchorRef={nativeSurfacePlacementAnchorRef}
            style={pixelClipStyle}
          />
          <div
            className={`image-editor-frame${cropRegion ? " cropped" : ""}`}
            style={{
              aspectRatio: `${fitFrame.w} / ${fitFrame.h}`,
              ...fitFrameWithinWorldStyle,
            }}
          >
            <div className="image-editor-document-layer" style={documentWithinFitFrameStyle}>
              <canvas
                ref={canvasRef}
                className="image-editor-canvas"
                style={{
                  cursor: spacePan ? "grab" : toolId === "rotate_view" ? "crosshair" : brushCursor ? "none" : undefined,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onLostPointerCapture={onPointerUp}
                onPointerLeave={onPointerUp}
                onContextMenu={onContextMenu}
              />
              <InteractionResultLayer
                dims={dims}
                frame={frame}
                selectedLayerFrame={displayedSelectedLayerFrame}
                selectionDraft={selectionDraft ?? null}
                activeSelection={activeSelection ?? null}
                antsPhase={antsPhase}
                liveSelectionOverlayRef={liveSelectionOverlayRef}
                brushCursor={brushCursor}
                brushCursorRef={brushCursorRef}
              />
            </div>
          </div>
        </div>
      ) : null}
      {displayedSelectedLayerFrame ? contextActionBar : null}
      <ViewportBackendBadge backend={viewportBackend} />
    </div>
  );
}
