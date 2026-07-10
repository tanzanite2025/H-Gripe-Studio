import { describe, expect, it } from "vitest";
import { paintPenAnchors, paintTargetBounds } from "./stagePainter";
import type { TargetBounds } from "../studioTarget";

function mockCtx() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    setLineDash: (dash: number[]) => calls.push(`dash:${dash.join(",")}`),
    beginPath: () => calls.push("begin"),
    moveTo: (x: number, y: number) => calls.push(`move:${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`line:${x},${y}`),
    closePath: () => calls.push("close"),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`pathRect:${x},${y},${w},${h}`),
    ellipse: () => calls.push("ellipse"),
    stroke: () => calls.push("stroke"),
    fill: () => calls.push("fill"),
    strokeRect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    set lineWidth(_value: number) {},
    set lineDashOffset(_value: number) {},
    set strokeStyle(_value: string) {},
    set fillStyle(_value: string) {},
    set lineJoin(_value: string) {},
    set lineCap(_value: string) {},
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

describe("pen anchor painter", () => {
  it("draws pending pen paths as solid guides, not marching ants", () => {
    const { ctx, calls } = mockCtx();

    paintPenAnchors(ctx, [[10, 10], [40, 20], [60, 50]], 6);

    expect(calls).not.toContain("dash:7,5");
    expect(calls).toContain("move:10,10");
    expect(calls).toContain("line:40,20");
    expect(calls.filter((call) => call === "stroke")).toHaveLength(4);
  });
});
