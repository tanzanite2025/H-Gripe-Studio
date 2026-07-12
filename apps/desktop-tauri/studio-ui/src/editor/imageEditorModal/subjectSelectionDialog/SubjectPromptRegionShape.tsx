import {
  SUBJECT_PREVIEW_HEIGHT,
  SUBJECT_PREVIEW_WIDTH,
  type SubjectPromptRegion,
} from "./subjectSelectionTypes";

export function SubjectPromptRegionShape({
  region,
  marching,
}: {
  region: SubjectPromptRegion;
  marching?: boolean;
}) {
  const shapeClass = marching ? "subject-selection-marching-shape" : "subject-selection-prompt-shape";
  if (region.shape === "ellipse") {
    return (
      <ellipse
        className={shapeClass}
        cx={(region.x0 + region.x1) / 2}
        cy={(region.y0 + region.y1) / 2}
        rx={Math.max(1, (region.x1 - region.x0) / 2)}
        ry={Math.max(1, (region.y1 - region.y0) / 2)}
      />
    );
  }
  return (
    <rect
      className={shapeClass}
      x={region.x0}
      y={region.y0}
      width={Math.max(1, region.x1 - region.x0)}
      height={Math.max(1, region.y1 - region.y0)}
      rx="2"
    />
  );
}

export function SubjectPreviewBoundary() {
  return (
    <rect
      className="subject-selection-preview-grid"
      x="1"
      y="1"
      width={SUBJECT_PREVIEW_WIDTH - 2}
      height={SUBJECT_PREVIEW_HEIGHT - 2}
      rx="5"
    />
  );
}
