import { describe, expect, it } from "vitest";
import {
  HGRIPE_BINDING_EDGE_TYPE,
  HGRIPE_DATA_EDGE_TYPE,
  normalizeHgripeEdges,
  withHgripeBindingEdge,
  withHgripeDataEdge,
  type Edge,
} from "@hgripe/flow";

describe("H-Gripe edge system", () => {
  it("normalizes stale workflow edge types to the product edge set", () => {
    const edges = normalizeHgripeEdges([
      { id: "old-default", source: "a", target: "b" },
      { id: "old-smooth", source: "b", target: "c", type: "smoothstep" },
      { id: "binding-edit", source: "c", target: "d", type: HGRIPE_BINDING_EDGE_TYPE },
    ] as Edge[]);

    expect(edges.map((edge) => edge.type)).toEqual([
      HGRIPE_DATA_EDGE_TYPE,
      HGRIPE_DATA_EDGE_TYPE,
      HGRIPE_BINDING_EDGE_TYPE,
    ]);
  });

  it("stamps app-created edges at creation time", () => {
    expect(withHgripeDataEdge({ id: "e1", source: "a", target: "b" }).type).toBe(HGRIPE_DATA_EDGE_TYPE);
    expect(withHgripeBindingEdge({ id: "b1", source: "a", target: "edit" }).type).toBe(
      HGRIPE_BINDING_EDGE_TYPE,
    );
  });
});
