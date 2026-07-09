import type { Edge, HgripeEdgeData, Pt } from "@hgripe/flow";

export function edgeWaypoints(edge: Edge): readonly Pt[] {
  return (edge.data as HgripeEdgeData | undefined)?.waypoints ?? [];
}

export function addEdgeWaypoint(edge: Edge, point: Pt): Edge {
  return {
    ...edge,
    data: { ...edge.data, waypoints: [...edgeWaypoints(edge), point] },
  };
}

export function moveEdgeWaypoint(edge: Edge, index: number, point: Pt): Edge {
  const waypoints = edgeWaypoints(edge);
  if (!waypoints[index]) return edge;
  return {
    ...edge,
    data: {
      ...edge.data,
      waypoints: waypoints.map((waypoint, current) => (current === index ? point : waypoint)),
    },
  };
}

export function removeEdgeWaypoint(edge: Edge, index: number): Edge {
  const waypoints = edgeWaypoints(edge);
  if (!waypoints[index]) return edge;
  const remaining = waypoints.filter((_, current) => current !== index);
  if (remaining.length === 0) return clearEdgeWaypoints(edge);
  return {
    ...edge,
    data: {
      ...edge.data,
      waypoints: remaining,
    },
  };
}

export function clearEdgeWaypoints(edge: Edge): Edge {
  if (edgeWaypoints(edge).length === 0) return edge;
  const data = { ...edge.data };
  delete data.waypoints;
  return { ...edge, data };
}

export function offsetEdgeWaypoints(edge: Edge, offset: Pt): Edge {
  const waypoints = edgeWaypoints(edge);
  if (waypoints.length === 0) return edge;
  return {
    ...edge,
    data: {
      ...edge.data,
      waypoints: waypoints.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      })),
    },
  };
}
