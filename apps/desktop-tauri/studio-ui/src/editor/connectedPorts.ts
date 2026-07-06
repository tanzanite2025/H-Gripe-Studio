// Shared lookup of which input ports have an incoming edge, per node. Built
// once per edges-array revision (WeakMap-cached) so each node card does an
// O(1) map read instead of filtering the full edge list itself.

import type { Edge } from "@hgripe/flow";

const cache = new WeakMap<readonly Edge[], Map<string, string>>();

function buildPortsByTarget(edges: readonly Edge[]): Map<string, string> {
  const portsByTarget = new Map<string, string[]>();
  for (const e of edges) {
    const ports = portsByTarget.get(e.target);
    const port = e.targetHandle ?? "";
    if (ports) ports.push(port);
    else portsByTarget.set(e.target, [port]);
  }
  const joined = new Map<string, string>();
  for (const [target, ports] of portsByTarget) {
    joined.set(target, ports.sort().join(","));
  }
  return joined;
}

/**
 * Comma-joined, sorted list of input ports on `nodeId` that have an incoming
 * edge (a stable string, so it works as a `useStore` selector result).
 */
export function connectedInputPorts(edges: readonly Edge[], nodeId: string): string {
  let map = cache.get(edges);
  if (!map) {
    map = buildPortsByTarget(edges);
    cache.set(edges, map);
  }
  return map.get(nodeId) ?? "";
}
