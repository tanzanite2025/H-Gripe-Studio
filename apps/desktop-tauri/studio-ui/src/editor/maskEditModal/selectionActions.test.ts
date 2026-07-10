import { describe, expect, it } from "vitest";
import type { MaskEditAction } from "./actions";
import { applyActiveSelectionClip } from "./selectionActions";
import type { ActiveSelection } from "./selection";

describe("applyActiveSelectionClip", () => {
  const polygonSelection: ActiveSelection = {
    region: [10, 10, 70, 50],
    ellipse: false,
    polygon: [
      [10, 10],
      [70, 10],
      [40, 50],
    ],
  };

  it("applies exact polygon clips to ordinary edit operations", () => {
    const action: MaskEditAction = { type: "op", op: { type: "invert" } };

    expect(applyActiveSelectionClip(action, polygonSelection)).toEqual({
      type: "op",
      op: {
        type: "invert",
        clip: {
          region: [10, 10, 70, 50],
          points: [
            [10, 10],
            [70, 10],
            [40, 50],
          ],
        },
      },
    });
  });

  it("applies ellipse clips to brush and path actions", () => {
    const selection: ActiveSelection = { region: [0, 0, 40, 50], ellipse: true };
    const stroke: MaskEditAction = {
      type: "stroke",
      stroke: { id: "s1", mode: "add", radius: 4, points: [[5, 5]] },
    };
    const path: MaskEditAction = {
      type: "path",
      path: {
        id: "p1",
        mode: "add",
        tool: "pen",
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
      },
    };

    expect(applyActiveSelectionClip(stroke, selection)).toMatchObject({
      stroke: { clip: { region: [0, 0, 40, 50], ellipse: true } },
    });
    expect(applyActiveSelectionClip(path, selection)).toMatchObject({
      path: { clip: { region: [0, 0, 40, 50], ellipse: true } },
    });
  });

  it("leaves whole-mask reshape operations unclipped", () => {
    for (const type of ["transform", "crop", "select_all"]) {
      const action: MaskEditAction = { type: "op", op: { type } };
      expect(applyActiveSelectionClip(action, polygonSelection)).toBe(action);
    }
  });

  it("leaves unrelated actions untouched", () => {
    const action: MaskEditAction = { type: "layer_active", index: 1 };
    expect(applyActiveSelectionClip(action, polygonSelection)).toBe(action);
    expect(applyActiveSelectionClip(action, null)).toBe(action);
  });
});
