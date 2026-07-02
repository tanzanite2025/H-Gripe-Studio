// Centre stage: the edit canvas. Rendering and pointer→image mapping live in
// the modal shell (which owns the document state); this is the presentation.

import type { MutableRefObject } from "react";
import { isFitView, viewTransform, type CanvasView } from "../canvasView";

interface MaskStageProps {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  dims: { w: number; h: number };
  view: CanvasView;
  spacePan: boolean;
  toolId: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}

export function MaskStage({ canvasRef, dims, view, spacePan, toolId, onPointerDown, onPointerMove, onPointerUp }: MaskStageProps) {
  return (
    <div className="mask-edit-stage">
      <canvas
        ref={canvasRef}
        className="mask-edit-canvas"
        style={{
          aspectRatio: `${dims.w} / ${dims.h}`,
          transform: isFitView(view) ? undefined : viewTransform(view),
          transformOrigin: "center",
          cursor: spacePan || toolId === "hand" ? "grab" : toolId === "zoom" ? "zoom-in" : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
