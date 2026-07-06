import type { EdgeTypes } from '../../types';

// H-Gripe fork: the generic edge variants (bezier / simplebezier / step /
// smoothstep / straight) are removed. All product edges come from the
// edgeTypes map owned by HgripeFlow; an unknown type renders nothing.
const NullEdge = () => null;

export const builtinEdgeTypes: EdgeTypes = {
  default: NullEdge,
};

export const nullPosition = {
  sourceX: null,
  sourceY: null,
  targetX: null,
  targetY: null,
  sourcePosition: null,
  targetPosition: null,
};
