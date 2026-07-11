import type { SelectedLayerFrame } from "../selectedLayerFrame";

interface SelectedLayerFrameOverlayProps {
  selectedFrame: SelectedLayerFrame | null;
  viewFrame?: { x: number; y: number; w: number; h: number };
}

// Render-only: the selected layer rect has already been resolved by Rust.
export function SelectedLayerFrameOverlay({ selectedFrame, viewFrame }: SelectedLayerFrameOverlayProps) {
  if (!selectedFrame || !viewFrame || viewFrame.w <= 0 || viewFrame.h <= 0) return null;
  const [x0, y0, x1, y1] = selectedFrame.rect;
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (width <= 0 || height <= 0) return null;
  return (
    <svg
      className="selected-layer-frame-overlay"
      viewBox={`${viewFrame.x} ${viewFrame.y} ${viewFrame.w} ${viewFrame.h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect
        className="selected-layer-frame-halo"
        x={x}
        y={y}
        width={width}
        height={height}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        className="selected-layer-frame-line"
        x={x}
        y={y}
        width={width}
        height={height}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
