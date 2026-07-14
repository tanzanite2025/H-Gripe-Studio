import type { CSSProperties, MutableRefObject } from "react";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import type { ActiveSelection, SelectionDraft } from "./selection";
import type { SceneFrame } from "./sceneFrame";
import { SelectedLayerFrameOverlay } from "./SelectedLayerFrameOverlay";
import { SelectionOverlay } from "./SelectionOverlay";

interface InteractionResultLayerProps {
  dims: { w: number; h: number };
  frame: SceneFrame;
  selectedLayerFrame?: SelectedLayerFrame | null;
  selectionDraft?: SelectionDraft | null;
  activeSelection?: ActiveSelection | null;
  antsPhase?: number;
  liveSelectionOverlayRef: MutableRefObject<SVGSVGElement | null>;
  brushCursor?: { diameter: number } | null;
  brushCursorRef: MutableRefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}

// Single DOM/SVG interaction result layer. New selected-frame, selection,
// transform, or cursor visuals should enter here instead of
// mounting another overlay path in ImageEditorStage.
export function InteractionResultLayer({
  dims,
  frame,
  selectedLayerFrame = null,
  selectionDraft = null,
  activeSelection = null,
  antsPhase = 0,
  liveSelectionOverlayRef,
  brushCursor = null,
  brushCursorRef,
  style,
}: InteractionResultLayerProps) {
  return (
    <div className="mask-interaction-result-layer" style={style} aria-hidden="true">
      <SelectedLayerFrameOverlay selectedFrame={selectedLayerFrame} viewFrame={frame} />
      <SelectionOverlay
        dims={dims}
        frame={frame}
        draft={selectionDraft}
        active={activeSelection}
        phase={antsPhase}
      />
      <svg
        ref={liveSelectionOverlayRef}
        className="mask-selection-overlay mask-selection-live-overlay"
        viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
        preserveAspectRatio="none"
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
            width: `${(brushCursor.diameter / frame.w) * 100}%`,
            height: `${(brushCursor.diameter / frame.h) * 100}%`,
            display: "none",
          }}
        />
      ) : null}
    </div>
  );
}
