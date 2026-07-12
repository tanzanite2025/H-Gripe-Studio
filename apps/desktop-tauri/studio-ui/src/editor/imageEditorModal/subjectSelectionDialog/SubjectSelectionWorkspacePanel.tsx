import type { PointerEvent } from "react";

import {
  SUBJECT_PREVIEW_HEIGHT,
  SUBJECT_PREVIEW_WIDTH,
  type SubjectPromptRegion,
  type SubjectResultManualRefinementBrushMode,
  type SubjectResultManualRefinementStroke,
} from "./subjectSelectionTypes";
import { SubjectPreviewBoundary, SubjectPromptRegionShape } from "./SubjectPromptRegionShape";

interface SubjectSelectionWorkspacePanelProps {
  promptRegion: SubjectPromptRegion | null;
  drawingRegion: SubjectPromptRegion | null;
  resultRegion: SubjectPromptRegion | null;
  manualRefinementStrokes: readonly SubjectResultManualRefinementStroke[];
  activeManualRefinementBrushMode: SubjectResultManualRefinementBrushMode | null;
  onPointerDown: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (e: PointerEvent<SVGSVGElement>) => void;
}

export function SubjectSelectionWorkspacePanel({
  promptRegion,
  drawingRegion,
  resultRegion,
  manualRefinementStrokes,
  activeManualRefinementBrushMode,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: SubjectSelectionWorkspacePanelProps) {
  const promptDisplayRegion = drawingRegion ?? promptRegion;
  return (
    <section className="subject-selection-grid-panel subject-selection-workspace-panel" aria-label="主体选择图框">
      <svg
        className={`subject-selection-preview-svg subject-selection-preview-drawing-surface${activeManualRefinementBrushMode ? " result-brush-active" : ""}`}
        viewBox={`0 0 ${SUBJECT_PREVIEW_WIDTH} ${SUBJECT_PREVIEW_HEIGHT}`}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <SubjectPreviewBoundary />
        {resultRegion ? <SubjectPromptRegionShape region={resultRegion} marching /> : null}
        {manualRefinementStrokes.map((stroke) => (
          <circle
            key={stroke.id}
            className={
              stroke.mode === "add_to_subject_result"
                ? "subject-selection-result-add-brush-stroke"
                : "subject-selection-result-subtract-brush-stroke"
            }
            cx={stroke.x}
            cy={stroke.y}
            r={stroke.radius}
          />
        ))}
        {!resultRegion && promptDisplayRegion ? <SubjectPromptRegionShape region={promptDisplayRegion} /> : null}
      </svg>
    </section>
  );
}
