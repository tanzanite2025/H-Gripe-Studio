import { BaseEdge, type EdgeProps } from "@hgripe/flow";
import { chamferPath } from "./edgeRouting";

export function ChamferEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
}: EdgeProps) {
  const path = chamferPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}
