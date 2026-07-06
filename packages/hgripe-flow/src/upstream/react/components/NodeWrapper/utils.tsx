import type { XYPosition } from '@xyflow/system';

import type { InternalNode, Node, NodeTypes } from '../../types';

// H-Gripe fork: the generic built-in node components (input / output /
// default / group) are removed. All product nodes come from the nodeTypes
// map passed to HgripeFlow; an unknown type renders nothing.
const NullNode = () => null;

export const arrowKeyDiffs: Record<string, XYPosition> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

export const builtinNodeTypes: NodeTypes = {
  default: NullNode,
};

export function getNodeInlineStyleDimensions<NodeType extends Node = Node>(
  node: InternalNode<NodeType>
): {
  width: number | string | undefined;
  height: number | string | undefined;
} {
  if (node.internals.handleBounds === undefined) {
    return {
      width: node.width ?? node.initialWidth ?? node.style?.width,
      height: node.height ?? node.initialHeight ?? node.style?.height,
    };
  }

  return {
    width: node.width ?? node.style?.width,
    height: node.height ?? node.style?.height,
  };
}
