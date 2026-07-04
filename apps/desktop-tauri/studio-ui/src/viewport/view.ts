// Normalized viewport view math (WGPU migration: zoom/pan is viewport
// state). `zoom >= 1` selects a window `1/zoom` the size of the frame;
// `panX`/`panY` place the window's top-left in normalized coordinates,
// clamped so the window stays inside the frame — matching the backend's
// `viewport_set_view` clamp.

export interface ViewportViewState {
  zoom: number;
  panX: number;
  panY: number;
}

/** The identity view: full frame, no pan. */
export const IDENTITY_VIEW: ViewportViewState = { zoom: 1, panX: 0, panY: 0 };

export const MAX_VIEW_ZOOM = 8;

/** Clamp pan so the `1/zoom`-sized window stays inside the frame. */
export function clampView(view: ViewportViewState): ViewportViewState {
  const zoom = Math.min(Math.max(view.zoom, 1), MAX_VIEW_ZOOM);
  const max = 1 - 1 / zoom;
  return {
    zoom,
    panX: Math.min(Math.max(view.panX, 0), max),
    panY: Math.min(Math.max(view.panY, 0), max),
  };
}

/** Zoom by `factor` keeping the window's center fixed. */
export function zoomView(view: ViewportViewState, factor: number): ViewportViewState {
  const zoom = Math.min(Math.max(view.zoom * factor, 1), MAX_VIEW_ZOOM);
  const centerX = view.panX + 0.5 / view.zoom;
  const centerY = view.panY + 0.5 / view.zoom;
  return clampView({ zoom, panX: centerX - 0.5 / zoom, panY: centerY - 0.5 / zoom });
}

/** Pan by a drag of (`dx`, `dy`) pixels over a stage of `w`×`h` pixels. */
export function panView(
  view: ViewportViewState,
  dx: number,
  dy: number,
  w: number,
  h: number,
): ViewportViewState {
  if (w === 0 || h === 0) return view;
  return clampView({
    zoom: view.zoom,
    panX: view.panX - dx / w / view.zoom,
    panY: view.panY - dy / h / view.zoom,
  });
}

export function isIdentityView(view: ViewportViewState): boolean {
  return view.zoom <= 1 && view.panX === 0 && view.panY === 0;
}
