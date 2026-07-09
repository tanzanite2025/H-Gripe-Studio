import { describe, expect, it } from "vitest";
import type { Edge } from "@hgripe/flow";
import {
  addEdgeWaypoint,
  clearEdgeWaypoints,
  edgeWaypoints,
  moveEdgeWaypoint,
  offsetEdgeWaypoints,
  removeEdgeWaypoint,
} from "./edgeWaypoints";

const edge: Edge = { id: "e1", source: "a", target: "b", data: { label: "kept" } };

describe("edge waypoint editing", () => {
  it("adds, moves, removes, and clears bend points immutably", () => {
    const added = addEdgeWaypoint(edge, { x: 20, y: 30 });
    const moved = moveEdgeWaypoint(added, 0, { x: 40, y: 50 });
    const removed = removeEdgeWaypoint(moved, 0);

    expect(edgeWaypoints(edge)).toEqual([]);
    expect(edgeWaypoints(added)).toEqual([{ x: 20, y: 30 }]);
    expect(edgeWaypoints(moved)).toEqual([{ x: 40, y: 50 }]);
    expect(edgeWaypoints(removed)).toEqual([]);
    expect(removed.data?.label).toBe("kept");
    expect(clearEdgeWaypoints(added).data).toEqual({ label: "kept" });
  });

  it("offsets pasted routes with their nodes", () => {
    const routed = addEdgeWaypoint(edge, { x: 100, y: 200 });
    expect(edgeWaypoints(offsetEdgeWaypoints(routed, { x: 40, y: -20 }))).toEqual([
      { x: 140, y: 180 },
    ]);
  });
});
