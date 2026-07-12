// Subject selection is intentionally separate from the main image-editor
// selection stack. Do not reuse SelectionDraft, pointerMachine, lasso, or
// selection-assist caches here: this dialog only emits a lightweight prompt
// region and, later, an independent subject-mask result for callers to apply.
// Treat this flow like a plug-in: internal model/canvas/cache failures must not
// mutate or corrupt editor layers, marquee state, crop state, move state, nodes,
// or video surfaces.
export type SubjectPromptShape = "rect" | "ellipse";

export interface SubjectPromptRegion {
  shape: SubjectPromptShape;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SubjectPreviewDrawing {
  pointerId: number;
  startX: number;
  startY: number;
}

export type SubjectResultManualRefinementBrushMode = "add_to_subject_result" | "subtract_from_subject_result";

export interface SubjectResultManualRefinementStroke {
  id: string;
  mode: SubjectResultManualRefinementBrushMode;
  x: number;
  y: number;
  radius: number;
}

export const SUBJECT_PREVIEW_WIDTH = 200;
export const SUBJECT_PREVIEW_HEIGHT = 200;
