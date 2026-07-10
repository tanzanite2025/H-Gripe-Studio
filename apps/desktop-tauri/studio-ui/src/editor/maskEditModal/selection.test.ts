import { describe, expect, it } from "vitest";
import {
  commitSelectionDraft,
  createBoxSelection,
  createPolygonSelection,
  pointInSelection,
  replaceSelectionBox,
  selectionBoundsFromPoints,
  selectionClipFromActive,
  selectionSourceFromToolId,
} from "./selection";

describe("selection protocol helpers", () => {
  it("builds stable bounds for polygon drafts", () => {
    expect(selectionBoundsFromPoints([
      [20, 10],
      [80, 40],
      [30, 90],
      [10, 50],
    ])).toEqual([10, 10, 80, 90]);
  });

  it("commits a closed draft into one active selection shape", () => {
    const draft = createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "magnetic_lasso");

    const active = commitSelectionDraft(draft);

    expect(active).toMatchObject({
      region: [10, 10, 70, 50],
      ellipse: false,
      source: "magnetic_lasso",
      combineMode: "replace",
      antiAlias: true,
    });
    expect(active.polygon).toEqual([
      [10, 10],
      [70, 10],
      [40, 50],
    ]);
    expect(active).not.toHaveProperty("status");
  });

  it("hit-tests rectangle, ellipse, and polygon selections through one API", () => {
    const rect = createBoxSelection([10, 20, 60, 80]);
    const ellipse = createBoxSelection([10, 20, 60, 80], true);
    const polygon = createPolygonSelection([
      [10, 10],
      [80, 10],
      [30, 80],
    ]);

    expect(pointInSelection([30, 40], rect)).toBe(true);
    expect(pointInSelection([5, 40], rect)).toBe(false);
    expect(pointInSelection([35, 50], ellipse)).toBe(true);
    expect(pointInSelection([10, 20], ellipse)).toBe(false);
    expect(pointInSelection([30, 30], polygon)).toBe(true);
    expect(pointInSelection([70, 70], polygon)).toBe(false);
  });

  it("resizes a selection box without changing draft or active semantics", () => {
    const draft = createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "pen");

    const resized = replaceSelectionBox(draft, [20, 30, 120, 90], true);

    expect(resized).toMatchObject({
      region: [20, 30, 120, 90],
      ellipse: true,
      status: "closed",
      source: "pen",
      combineMode: "replace",
    });
    expect(resized).not.toHaveProperty("polygon");
  });

  it("converts active selections to exact edit clips", () => {
    const polygon = commitSelectionDraft(createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "pen"));
    const ellipse = commitSelectionDraft(createBoxSelection([0, 0, 50, 60], true));

    expect(selectionClipFromActive(polygon)).toEqual({
      region: [10, 10, 70, 50],
      points: [
        [10, 10],
        [70, 10],
        [40, 50],
      ],
    });
    expect(selectionClipFromActive(ellipse)).toEqual({
      region: [0, 0, 50, 60],
      ellipse: true,
    });
  });

  it("maps tool ids to selection sources without letting commands depend on the tool", () => {
    expect(selectionSourceFromToolId("rect")).toBe("rect_marquee");
    expect(selectionSourceFromToolId("ellipse")).toBe("ellipse_marquee");
    expect(selectionSourceFromToolId("pen")).toBe("pen");
    expect(selectionSourceFromToolId("curvature_pen")).toBe("pen");
    expect(selectionSourceFromToolId("magnetic_lasso")).toBe("magnetic_lasso");
    expect(selectionSourceFromToolId("unknown_future_tool")).toBe("manual");
  });
});
