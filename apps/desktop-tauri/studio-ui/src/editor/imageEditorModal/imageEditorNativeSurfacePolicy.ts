import type { CanvasView } from "../canvasView";

interface ImageEditorNativeSurfacePolicy {
  overlayOnly: boolean;
  view: CanvasView;
  cropRegion: unknown;
  gradePreview: unknown;
  entering: boolean;
  closing: boolean;
}

export function canPresentImageEditorNativeSurfaceWithScopedHole({
  overlayOnly,
  view,
  cropRegion,
  gradePreview,
  entering,
  closing,
}: ImageEditorNativeSurfacePolicy): boolean {
  const surfaceCanRepresentCurrentEditorState =
    !overlayOnly &&
    !view.rotate &&
    !cropRegion &&
    !gradePreview &&
    !entering &&
    !closing;

  // A below-webview native surface is safe only after the image editor owns a
  // scoped hole/matte inside its stage. Until then, native presentation would
  // require transparent shared chrome and could leak the graph behind the modal.
  const imageEditorStageOwnsScopedNativeSurfaceHole = false;
  return surfaceCanRepresentCurrentEditorState && imageEditorStageOwnsScopedNativeSurfaceHole;
}
