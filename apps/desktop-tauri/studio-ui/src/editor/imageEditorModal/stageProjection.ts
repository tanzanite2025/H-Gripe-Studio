import type { CSSProperties } from "react";
import type { CanvasView } from "../canvasView";

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

export function projectFrameInStage(
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
          transformOrigin: "center",
        }
      : null),
  };
}
