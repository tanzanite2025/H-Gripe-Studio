import { describe, expect, it } from "vitest";

import { parseInitialOps } from "./GradePanel";

describe("parseInitialOps", () => {
  it("accepts the current single-layer operation vocabulary", () => {
    const parsed = parseInitialOps(
      JSON.stringify({
        layers: [
          {
            blend: "normal",
            opacity: 1,
            visible: true,
            mask: null,
            ops: [{ type: "levels", in_black: 0, in_white: 1, gamma: 1, out_black: 0, out_white: 1 }],
          },
        ],
      }),
    );
    expect(parsed.error).toBeNull();
    expect(parsed.ops[0]?.type).toBe("levels");
  });

  it("rejects a retired operation in any layer", () => {
    const parsed = parseInitialOps(
      JSON.stringify({
        layers: [
          { ops: [{ type: "levels" }] },
          { ops: [{ type: "retired_external_transform" }] },
        ],
      }),
    );
    expect(parsed.ops).toEqual([]);
    expect(parsed.error).toContain("unsupported retired operation");
  });

  it("does not silently flatten a multi-layer document", () => {
    const parsed = parseInitialOps(
      JSON.stringify({ layers: [{ ops: [] }, { ops: [] }] }),
    );
    expect(parsed.ops).toEqual([]);
    expect(parsed.error).toContain("multi-layer");
  });
});
