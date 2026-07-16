import { describe, expect, it } from "vitest";
import {
  buildSelectionOverlayScene,
  commitSelectionDraft,
  createBoxSelection,
  createPolygonSelection,
  createSelectionAlphaDraft,
  pointInSelection,
  replaceSelectionBox,
  resizeSelectionDraftBox,
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

  it("resizes a draft box as geometry only, without committing it", () => {
    const draft = createBoxSelection([90, 80, 140, 120], false, "rect_marquee");

    const resized = resizeSelectionDraftBox(draft, 60, 50, { w: 120, h: 100 });

    expect(resized).toMatchObject({
      region: [60, 50, 120, 100],
      ellipse: false,
      status: "closed",
      source: "rect_marquee",
      combineMode: "replace",
    });
    expect(resized).not.toHaveProperty("antiAlias");
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

  it("carries pixel-alpha selections as exact selection alpha clips", () => {
    const draft = createSelectionAlphaDraft(
      [10, 20, 14, 22],
      { width: 4, height: 2, startsWith: 0, runs: [1, 2, 2, 3] },
      "magic_wand",
    );

    const active = commitSelectionDraft(draft);

    expect(active).toMatchObject({
      region: [10, 20, 14, 22],
      ellipse: false,
      source: "magic_wand",
      antiAlias: true,
    });
    expect(selectionClipFromActive(active)).toEqual({
      region: [10, 20, 14, 22],
      selectionAlpha: { width: 4, height: 2, startsWith: 0, runs: [1, 2, 2, 3] },
    });
    expect(pointInSelection([11, 20], active)).toBe(true);
    expect(pointInSelection([10, 20], active)).toBe(false);
    expect(pointInSelection([13, 21], active)).toBe(true);
    expect(pointInSelection([14, 21], active)).toBe(false);
  });

  it("commits every selection source into the same ActiveSelection contract", () => {
    const drafts = [
      createBoxSelection([10, 20, 60, 80], false, "rect_marquee"),
      createBoxSelection([10, 20, 60, 80], true, "ellipse_marquee"),
      createPolygonSelection([[10, 10], [70, 10], [40, 50]], "pen"),
      createPolygonSelection([[10, 10], [70, 10], [40, 50]], "polygon_lasso"),
      createPolygonSelection([[10, 10], [70, 10], [40, 50]], "magnetic_lasso"),
      createPolygonSelection([[10, 10], [70, 10], [40, 50]], "mask"),
    ];

    for (const draft of drafts) {
      const active = commitSelectionDraft(draft);
      expect(active.region).toEqual(draft.region);
      expect(active.ellipse).toBe(draft.ellipse);
      expect(active.source).toBe(draft.source);
      expect(active.combineMode).toBe("replace");
      expect(active.antiAlias).toBe(true);
      expect(active).not.toHaveProperty("status");
      if (draft.polygon) expect(active.polygon).toEqual(draft.polygon);
    }
  });

  it("builds one overlay scene where a draft outline always suppresses the ants", () => {
    const draft = createBoxSelection([5, 5, 40, 40]);
    const active = commitSelectionDraft(createBoxSelection([10, 10, 80, 80]));

    expect(buildSelectionOverlayScene(draft, active)).toEqual({ draft, ants: null });
    expect(buildSelectionOverlayScene(null, active)).toEqual({ draft: null, ants: active });
    expect(buildSelectionOverlayScene(null, null)).toEqual({ draft: null, ants: null });
  });

  it("maps tool ids to selection sources without letting commands depend on the tool", () => {
    expect(selectionSourceFromToolId("rect")).toBe("rect_marquee");
    expect(selectionSourceFromToolId("ellipse")).toBe("ellipse_marquee");
    expect(selectionSourceFromToolId("pen")).toBe("pen");
    expect(selectionSourceFromToolId("curvature_pen")).toBe("pen");
    expect(selectionSourceFromToolId("magnetic_lasso")).toBe("magnetic_lasso");
    expect(selectionSourceFromToolId("object_select")).toBe("object_select");
    expect(selectionSourceFromToolId("quick_select")).toBe("quick_select");
    expect(selectionSourceFromToolId("wand")).toBe("magic_wand");
    expect(selectionSourceFromToolId("point")).toBe("point");
    expect(selectionSourceFromToolId("unknown_future_tool")).toBe("manual");
  });
});
