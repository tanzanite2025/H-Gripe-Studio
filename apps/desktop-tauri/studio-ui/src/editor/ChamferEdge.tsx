import { BaseEdge, type EdgeProps } from "@hgripe/flow";
import { chamferPath } from "./edgeRouting";
import { EDGE_ARROW_MARKER, EDGE_STROKE_WIDTH, edgeMarkerId } from "./edgeVisual";

const EDGE_STROKE = "#aeb4c2";

export function ChamferEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
}: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const stroke = String(style?.stroke ?? EDGE_STROKE);
  const markerId = edgeMarkerId("hgripe-edge-arrow", id);

  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox={EDGE_ARROW_MARKER.viewBox}
          refX={EDGE_ARROW_MARKER.refX}
          refY={EDGE_ARROW_MARKER.refY}
          markerWidth={EDGE_ARROW_MARKER.markerWidth}
          markerHeight={EDGE_ARROW_MARKER.markerHeight}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke,
          strokeWidth: EDGE_STROKE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          ...style,
        }}
      />
    </>
  );
}
