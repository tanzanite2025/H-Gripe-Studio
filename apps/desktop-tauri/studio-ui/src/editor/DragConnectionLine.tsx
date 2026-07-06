import type { ConnectionLineComponentProps } from "@hgripe/flow";
import { chamferPath } from "./edgeRouting";
import { EDGE_ARROW_MARKER, EDGE_STROKE_WIDTH } from "./edgeVisual";

const DRAG_ARROW_ID = "hgripe-drag-connection-arrow";

export function DragConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  connectionStatus,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const valid = connectionStatus !== "invalid";
  const stroke = valid ? "#8fb2ff" : "#ff6b6b";
  const path = chamferPath({ x: fromX, y: fromY }, { x: toX, y: toY });

  return (
    <>
      <defs>
        <marker
          id={DRAG_ARROW_ID}
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
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={EDGE_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#${DRAG_ARROW_ID})`}
        style={connectionLineStyle}
      />
    </>
  );
}
