import type { CSSProperties } from "react";
import { MAX_VIEW_ZOOM, type ViewportViewState } from "../../viewport/view";
import type { CanvasView } from "../canvasView";
import type { SceneFrame } from "./sceneFrame";

export interface StageSize {
  w: number;
  h: number;
}

export interface ProjectedFrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  transformOriginX?: number;
  transformOriginY?: number;
}

export interface RelativeFrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function validFrame(frame: SceneFrame): boolean {
  return Number.isFinite(frame.x)
    && Number.isFinite(frame.y)
    && Number.isFinite(frame.w)
    && Number.isFinite(frame.h)
    && frame.w > 0
    && frame.h > 0;
}

export function fitFrameInStage(stage: StageSize, aspect: number): ProjectedFrameRect | null {
  if (stage.w <= 0 || stage.h <= 0 || !Number.isFinite(aspect) || aspect <= 0) return null;
  const width = Math.min(stage.w, stage.h * aspect);
  const height = width / aspect;
  return {
    left: (stage.w - width) / 2,
    top: (stage.h - height) / 2,
    width,
    height,
  };
}

/** Applies the view-only camera to a frame fitted inside the current stage. */
export function projectCameraFrameInStage(
  stage: StageSize | null,
  aspect: number,
  view: CanvasView,
): ProjectedFrameRect | null {
  if (!stage) return null;
  const base = fitFrameInStage(stage, aspect);
  if (!base) return null;
  const zoom = Math.max(view.zoom, 0.0001);
  const width = base.width * zoom;
  const height = base.height * zoom;
  return {
    left: base.left + view.panX - (width - base.width) / 2,
    top: base.top + view.panY - (height - base.height) / 2,
    width,
    height,
    ...(view.rotate ? { rotate: view.rotate } : null),
  };
}

/**
 * Projects a logical world while keeping `fitFrame` fitted at camera zoom 1.
 * The world is geometry only: its dimensions never imply a bitmap allocation.
 */
export function projectWorldFrameInStage(
  stage: StageSize | null,
  worldFrame: SceneFrame,
  fitFrame: SceneFrame,
  view: CanvasView,
): ProjectedFrameRect | null {
  if (!stage || !validFrame(worldFrame) || !validFrame(fitFrame)) return null;
  const fitted = fitFrameInStage(stage, fitFrame.w / fitFrame.h);
  if (!fitted) return null;

  const zoom = Math.max(view.zoom, 0.0001);
  const scale = fitted.width / fitFrame.w;
  const fitCenterX = fitFrame.x + fitFrame.w / 2;
  const fitCenterY = fitFrame.y + fitFrame.h / 2;
  const screenCenterX = fitted.left + fitted.width / 2 + view.panX;
  const screenCenterY = fitted.top + fitted.height / 2 + view.panY;

  return {
    left: screenCenterX + (worldFrame.x - fitCenterX) * scale * zoom,
    top: screenCenterY + (worldFrame.y - fitCenterY) * scale * zoom,
    width: worldFrame.w * scale * zoom,
    height: worldFrame.h * scale * zoom,
    ...(view.rotate
      ? {
          rotate: view.rotate,
          transformOriginX: (fitCenterX - worldFrame.x) / worldFrame.w,
          transformOriginY: (fitCenterY - worldFrame.y) / worldFrame.h,
        }
      : null),
  };
}

/** Resolves a document/crop frame as a stable child rect of a logical world. */
export function frameRectWithinWorld(
  frame: SceneFrame,
  worldFrame: SceneFrame,
): RelativeFrameRect | null {
  if (!validFrame(frame) || !validFrame(worldFrame)) return null;
  return {
    left: (frame.x - worldFrame.x) / worldFrame.w,
    top: (frame.y - worldFrame.y) / worldFrame.h,
    width: frame.w / worldFrame.w,
    height: frame.h / worldFrame.h,
  };
}

export function frameWithinWorldStyle(
  frame: SceneFrame,
  worldFrame: SceneFrame,
): CSSProperties | undefined {
  const rect = frameRectWithinWorld(frame, worldFrame);
  if (!rect) return undefined;
  return {
    inset: "auto",
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

/** Clip a world-sized pixel plane to a document/crop frame. */
export function frameClipWithinWorldStyle(
  frame: SceneFrame,
  worldFrame: SceneFrame,
): CSSProperties | undefined {
  const rect = frameRectWithinWorld(frame, worldFrame);
  if (!rect) return undefined;
  const percent = (value: number) => `${Math.round(Math.max(0, value) * 100_000_000) / 1_000_000}%`;
  return {
    clipPath: `inset(${percent(rect.top)} ${percent(1 - rect.left - rect.width)} ${percent(1 - rect.top - rect.height)} ${percent(rect.left)})`,
  };
}

/**
 * Resolve the retained compositor window in normalized world coordinates.
 * The window covers the visible stage while the DOM camera keeps fitting the
 * document/crop frame. Rotation falls back to the complete world because the
 * retained raster window is axis-aligned.
 */
export function viewportWindowForWorld(
  stage: StageSize | null,
  worldFrame: SceneFrame,
  fitFrame: SceneFrame,
  view: CanvasView,
): ViewportViewState {
  if (!stage || view.rotate || !validFrame(worldFrame) || !validFrame(fitFrame)) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const fitted = fitFrameInStage(stage, fitFrame.w / fitFrame.h);
  if (!fitted) return { zoom: 1, panX: 0, panY: 0 };
  const cameraZoom = Math.max(view.zoom, 0.0001);
  const pixelsPerWorldUnit = fitted.width / fitFrame.w * cameraZoom;
  const requiredFraction = Math.max(
    stage.w / pixelsPerWorldUnit / worldFrame.w,
    stage.h / pixelsPerWorldUnit / worldFrame.h,
  );
  if (!Number.isFinite(requiredFraction) || requiredFraction >= 1) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const zoom = Math.min(MAX_VIEW_ZOOM, Math.max(1, 1 / requiredFraction));
  const windowFraction = 1 / zoom;
  const fitCenterX = fitFrame.x + fitFrame.w / 2;
  const fitCenterY = fitFrame.y + fitFrame.h / 2;
  const worldCenterX = fitCenterX - view.panX / pixelsPerWorldUnit;
  const worldCenterY = fitCenterY - view.panY / pixelsPerWorldUnit;
  const maxPan = 1 - windowFraction;
  return {
    zoom,
    panX: Math.min(Math.max(
      (worldCenterX - worldFrame.x) / worldFrame.w - windowFraction / 2,
      0,
    ), maxPan),
    panY: Math.min(Math.max(
      (worldCenterY - worldFrame.y) / worldFrame.h - windowFraction / 2,
      0,
    ), maxPan),
  };
}

export function projectedFrameStyle(rect: ProjectedFrameRect | null): CSSProperties | undefined {
  if (!rect) return undefined;
  return {
    inset: "auto",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    ...(rect.rotate
      ? {
          transform: `rotate(${rect.rotate}deg)`,
          transformOrigin: rect.transformOriginX !== undefined && rect.transformOriginY !== undefined
            ? `${rect.transformOriginX * 100}% ${rect.transformOriginY * 100}%`
            : "center",
        }
      : null),
  };
}
