import type { SceneFrame } from "./sceneFrame";

export interface ImageEditorDimensions {
  w: number;
  h: number;
}

export interface ImageEditorCoordinateSpaces {
  /** Current legacy compositor window. It is never sized from the stage. */
  renderFrame: SceneFrame;
  /** Logical editor-only movement boundary. It is not a bitmap allocation. */
  logicalPasteboard: SceneFrame;
}

export const IMAGE_EDITOR_PASTEBOARD_FACTOR = 2.5;

export function normalizedImageEditorDimensions(
  dims: ImageEditorDimensions,
): ImageEditorDimensions {
  const finiteRound = (value: number) => (
    Number.isFinite(value) ? Math.round(value) : 1
  );
  return {
    w: Math.max(1, finiteRound(dims.w)),
    h: Math.max(1, finiteRound(dims.h)),
  };
}

export function imageEditorDocumentFrame(dims: ImageEditorDimensions): SceneFrame {
  const safe = normalizedImageEditorDimensions(dims);
  return { x: 0, y: 0, w: safe.w, h: safe.h };
}

export function imageEditorLogicalPasteboard(dims: ImageEditorDimensions): SceneFrame {
  const safe = normalizedImageEditorDimensions(dims);
  const w = safe.w * IMAGE_EDITOR_PASTEBOARD_FACTOR;
  const h = safe.h * IMAGE_EDITOR_PASTEBOARD_FACTOR;
  return {
    x: (safe.w - w) / 2,
    y: (safe.h - h) / 2,
    w,
    h,
  };
}

/**
 * Defines the editor's stable coordinate spaces from document dimensions.
 * Stage size, camera state, layer placement, and document contents are
 * deliberately absent from this input.
 */
export function imageEditorCoordinateSpaces(
  dims: ImageEditorDimensions,
): ImageEditorCoordinateSpaces {
  return {
    renderFrame: imageEditorDocumentFrame(dims),
    logicalPasteboard: imageEditorLogicalPasteboard(dims),
  };
}
