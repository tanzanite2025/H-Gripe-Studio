import { describe, expect, it } from "vitest";
import { paintTargetBounds } from "./stagePainter";
import type { TargetBounds } from "../studioTarget";

function mockCtx() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    setLineDash: (dash: number[]) => calls.push(`dash:${dash.join(",")}`),
    strokeRect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    set lineWidth(_value: number) {},
    set lineDashOffset(_value: number) {},
    set strokeStyle(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("paintTargetBounds", () => {
  it("draws a quiet dashed frame for layer-like targets", () => {
    const { ctx, calls } = mockCtx();
    const bounds: TargetBounds = { kind: "layer_frame", rect: [10, 12, 40, 52], layerId: "layer-1" };

    paintTargetBounds(ctx, bounds, 4);

    expect(calls).toContain("save");
    expect(calls).toContain("dash:6,4");
    expect(calls.filter((call) => call.startsWith("rect:"))).toHaveLength(2);
    expect(calls).toContain("rect:10.5,12.5,29,39");
  });

  it("does not draw document, selection, path, or missing bounds", () => {
    for (const bounds of [
      { kind: "none" },
      { kind: "document", rect: [0, 0, 100, 80] },
      { kind: "selection", rect: [1, 1, 4, 4], selectionId: "sel" },
      { kind: "path", rect: [1, 1, 4, 4], pathId: "path" },
    ] as TargetBounds[]) {
      const { ctx, calls } = mockCtx();
      paintTargetBounds(ctx, bounds);
      expect(calls).toEqual([]);
    }
  });
});
