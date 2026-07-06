import { BaseEdge, type EdgeProps } from "@hgripe/flow";
import { chamferPath } from "./edgeRouting";
import { EDGE_ARROW_MARKER, EDGE_STROKE_WIDTH, edgeMarkerId } from "./edgeVisual";

const BINDING_STROKE = "#7c5cff";

// The "binding" edge ties a media source card to an edit-result node spawned
// from it (see docs/cards/generic-media-card.md). Unlike a normal workflow
// connection it is drawn as a dashed accent line so a binding reads
// differently from an ordinary data wire. It is otherwise a regular data edge
// (the executor treats it like any other), so only the rendering differs here.
export function BindingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
}: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const stroke = String(style?.stroke ?? BINDING_STROKE);
  const markerId = edgeMarkerId("hgripe-binding-arrow", id);

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
          strokeDasharray: "4 3",
          ...style,
        }}
      />
    </>
  );
}
