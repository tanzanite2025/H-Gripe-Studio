import cc from 'classcat';

import type { BaseEdgeProps } from '../../types';

// H-Gripe trim: SVG edge labels (EdgeText) removed — product edges never
// carry labels; edge chrome lives on the node cards instead.
export function BaseEdge({
  id,
  path,
  style,
  markerEnd,
  markerStart,
  className,
  interactionWidth = 20,
}: BaseEdgeProps) {
  return (
    <>
      <path
        id={id}
        style={style}
        d={path}
        fill="none"
        className={cc(['react-flow__edge-path', className])}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {interactionWidth && (
        <path
          d={path}
          fill="none"
          strokeOpacity={0}
          strokeWidth={interactionWidth}
          className="react-flow__edge-interaction"
        />
      )}
    </>
  );
}
