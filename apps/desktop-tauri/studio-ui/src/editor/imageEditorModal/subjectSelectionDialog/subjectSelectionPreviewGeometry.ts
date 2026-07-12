import type { PointerEvent } from "react";

import {
  SUBJECT_PREVIEW_HEIGHT,
  SUBJECT_PREVIEW_WIDTH,
  type SubjectPromptRegion,
  type SubjectPromptShape,
} from "./subjectSelectionTypes";

function clampPreviewCoordinate(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

export function pointerEventToSubjectPreviewPoint(e: PointerEvent<SVGSVGElement>): readonly [number, number] {
  const bounds = e.currentTarget.getBoundingClientRect();
  const x = bounds.width > 0 ? ((e.clientX - bounds.left) / bounds.width) * SUBJECT_PREVIEW_WIDTH : 0;
  const y = bounds.height > 0 ? ((e.clientY - bounds.top) / bounds.height) * SUBJECT_PREVIEW_HEIGHT : 0;
  return [clampPreviewCoordinate(x, SUBJECT_PREVIEW_WIDTH), clampPreviewCoordinate(y, SUBJECT_PREVIEW_HEIGHT)];
}

export function createSubjectPromptRegionFromDrag(
  shape: SubjectPromptShape,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): SubjectPromptRegion {
  return {
    shape,
    x0: Math.min(startX, endX),
    y0: Math.min(startY, endY),
    x1: Math.max(startX, endX),
    y1: Math.max(startY, endY),
  };
}

export function hasVisibleSubjectPromptRegion(region: SubjectPromptRegion | null): region is SubjectPromptRegion {
  return Boolean(region && region.x1 - region.x0 >= 2 && region.y1 - region.y0 >= 2);
}
