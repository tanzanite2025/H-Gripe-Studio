import { useLayoutEffect, useRef } from "react";
import type { ViewportPixels } from "../../bridge/viewport";
import type { SceneFrame } from "./sceneFrame";

interface SelectedLayerMoveSurfaceProps {
  surface: ViewportPixels | null;
  frame: SceneFrame;
  moveDraft: readonly [number, number] | null;
}

export function SelectedLayerMoveSurface({ surface, frame, moveDraft }: SelectedLayerMoveSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !surface) return;
    canvas.width = surface.width;
    canvas.height = surface.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const data = new ImageData(new Uint8ClampedArray(surface.pixels), surface.width, surface.height);
    ctx.clearRect(0, 0, surface.width, surface.height);
    ctx.putImageData(data, 0, 0);
  }, [surface]);

  if (!surface || frame.w <= 0 || frame.h <= 0) return null;
  const [dx, dy] = moveDraft ?? [0, 0];
  return (
    <canvas
      ref={canvasRef}
      className="selected-layer-move-surface"
      style={{
        transform: `translate(${(dx / frame.w) * 100}%, ${(dy / frame.h) * 100}%)`,
        opacity: moveDraft ? 1 : 0,
      }}
    />
  );
}
