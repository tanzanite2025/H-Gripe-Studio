import { describe, expect, it } from "vitest";
import {
  addBrushStroke,
  addMatteStroke,
  addOperation,
  addPath,
  addPoint,
  canRedo,
  canUndo,
  clearEdits,
  editCount,
  initEditState,
  isEmpty,
  normalizeEditPaths,
  redo,
  removeOp,
  toggleOp,
  undo,
  updateOpAmount,
  updatePathAnchors,
} from "./maskEdit";
import type { BrushStroke } from "../types/production";
import { editStackBrushStrokes, editStackOperations, editStackPaths } from "../types/production";

const stroke = (id: string): BrushStroke => ({
  id,
  mode: "add",
  radius: 12,
  points: [
    [0, 0],
    [4, 4],
  ],
});

describe("maskEdit normalizeEditPaths", () => {
  it("returns an empty, well-formed EditPaths for junk input", () => {
    for (const bad of [null, undefined, 42, "x", {}]) {
      const e = normalizeEditPaths(bad);
      expect(e.version).toBe(2);
      expect(e.ops).toEqual([]);
      expect(e.matte_strokes).toEqual([]);
      expect(e.points).toEqual([]);
    }
  });

  it("migrates version-1 arrays onto the ops stack in legacy replay order", () => {
    const e = normalizeEditPaths({
      version: 1,
      paths: [{ id: "p1", mode: "add", tool: "lasso", closed: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] }],
      brush_strokes: [stroke("s1")],
      matte_strokes: [stroke("m1")],
      operations: [{ type: "feather", amount: 3 }],
    });
    expect(e.version).toBe(2);
    expect(e.ops.map((op) => op.type)).toEqual(["path", "brush", "feather"]);
    expect(e.matte_strokes).toHaveLength(1);
  });

  it("preserves an existing version-2 ops stack (recorded order)", () => {
    const e = normalizeEditPaths({
      version: 2,
      ops: [{ type: "invert" }, { ...stroke("s1"), type: "brush" }],
      matte_strokes: [],
      points: [],
    });
    expect(e.ops.map((op) => op.type)).toEqual(["invert", "brush"]);
  });
});

describe("maskEdit reducer-style helpers", () => {
  it("records brush strokes and operations and counts them", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = addOperation(s, { type: "feather", amount: 3 });
    expect(editStackBrushStrokes(s.current)).toHaveLength(1);
    expect(editStackOperations(s.current)).toHaveLength(1);
    expect(s.current.ops.map((op) => op.type)).toEqual(["brush", "feather"]);
    expect(editCount(s.current)).toBe(2);
    expect(isEmpty(s.current)).toBe(false);
  });

  it("records trimap matting-band strokes and counts them", () => {
    let s = initEditState();
    s = addMatteStroke(s, stroke("m1"));
    expect(s.current.matte_strokes).toHaveLength(1);
    expect(editStackBrushStrokes(s.current)).toHaveLength(0);
    expect(editCount(s.current)).toBe(1);
    expect(isEmpty(s.current)).toBe(false);
    s = undo(s);
    expect(s.current.matte_strokes).toHaveLength(0);
  });

  it("records positive and negative SAM 2 point prompts and counts them", () => {
    let s = initEditState();
    s = addPoint(s, { x: 120, y: 80, label: 1 });
    s = addPoint(s, { x: 200, y: 150, label: 0 });
    expect(s.current.points).toEqual([
      { x: 120, y: 80, label: 1 },
      { x: 200, y: 150, label: 0 },
    ]);
    expect(editCount(s.current)).toBe(2);
    expect(isEmpty(s.current)).toBe(false);
    s = undo(s);
    expect(s.current.points).toEqual([{ x: 120, y: 80, label: 1 }]);
  });

  it("records closed pen / lasso paths and counts them", () => {
    let s = initEditState();
    s = addPath(s, {
      id: "p1",
      mode: "add",
      tool: "lasso",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    expect(editStackPaths(s.current)).toHaveLength(1);
    expect(editCount(s.current)).toBe(1);
    expect(isEmpty(s.current)).toBe(false);
    s = undo(s);
    expect(editStackPaths(s.current)).toHaveLength(0);
  });

  it("ignores degenerate paths with fewer than three anchors", () => {
    let s = initEditState();
    s = addPath(s, {
      id: "p1",
      mode: "add",
      tool: "pen",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    expect(editStackPaths(s.current)).toHaveLength(0);
  });

  it("migrates legacy [x, y] points to positive prompts on load", () => {
    const s = normalizeEditPaths({
      version: 1,
      points: [[10, 20], { x: 30, y: 40, label: 0 }, { x: 5, y: 6 }],
    });
    expect(s.points).toEqual([
      { x: 10, y: 20, label: 1 },
      { x: 30, y: 40, label: 0 },
      { x: 5, y: 6, label: 1 },
    ]);
  });

  it("ignores empty strokes", () => {
    let s = initEditState();
    s = addBrushStroke(s, { id: "x", mode: "add", radius: 4, points: [] });
    expect(editStackBrushStrokes(s.current)).toHaveLength(0);
  });

  it("undo/redo walks the history and toggles availability", () => {
    let s = initEditState();
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);

    s = addBrushStroke(s, stroke("s1"));
    s = addBrushStroke(s, stroke("s2"));
    expect(editCount(s.current)).toBe(2);
    expect(canUndo(s)).toBe(true);

    s = undo(s);
    expect(editCount(s.current)).toBe(1);
    expect(canRedo(s)).toBe(true);

    s = redo(s);
    expect(editCount(s.current)).toBe(2);
    expect(canRedo(s)).toBe(false);
  });

  it("a new edit after undo clears the redo branch", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = undo(s);
    expect(canRedo(s)).toBe(true);
    s = addOperation(s, { type: "invert" });
    expect(canRedo(s)).toBe(false);
    expect(editStackOperations(s.current)).toHaveLength(1);
  });

  it("clear is undoable and a no-op when already empty", () => {
    let s = initEditState();
    expect(clearEdits(s)).toBe(s); // no-op, same reference
    s = addBrushStroke(s, stroke("s1"));
    s = clearEdits(s);
    expect(isEmpty(s.current)).toBe(true);
    s = undo(s);
    expect(editCount(s.current)).toBe(1);
  });

  it("removes a history step (undoable)", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = addOperation(s, { type: "feather", amount: 3 });
    s = removeOp(s, 0);
    expect(s.current.ops.map((op) => op.type)).toEqual(["feather"]);
    s = undo(s);
    expect(s.current.ops.map((op) => op.type)).toEqual(["brush", "feather"]);
    expect(removeOp(s, 99)).toBe(s); // out of range: no-op
  });

  it("toggles a step's disabled flag without dropping it from history", () => {
    let s = initEditState();
    s = addOperation(s, { type: "invert" });
    s = toggleOp(s, 0);
    expect(s.current.ops[0].disabled).toBe(true);
    s = toggleOp(s, 0);
    expect(s.current.ops[0].disabled).toBeUndefined();
    expect(toggleOp(s, 5)).toBe(s);
  });

  it("revises a queued operation's amount (undoable, ops-only)", () => {
    let s = initEditState();
    s = addOperation(s, { type: "feather", amount: 3 });
    s = addBrushStroke(s, stroke("s1"));
    s = updateOpAmount(s, 0, 8);
    expect(editStackOperations(s.current)[0].amount).toBe(8);
    expect(updateOpAmount(s, 0, 8)).toBe(s); // unchanged value: no-op
    expect(updateOpAmount(s, 1, 8)).toBe(s); // brush step: no-op
    s = undo(s);
    expect(editStackOperations(s.current)[0].amount).toBe(3);
  });

  it("replaces a path step's anchors (undoable, path-only)", () => {
    let s = initEditState();
    s = addPath(s, {
      id: "p1",
      mode: "add",
      tool: "pen",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    const moved = [
      { x: 2, y: 2 },
      { x: 12, y: 2 },
      { x: 12, y: 12 },
    ];
    s = updatePathAnchors(s, 0, moved);
    expect(editStackPaths(s.current)[0].points).toEqual(moved);
    expect(updatePathAnchors(s, 0, moved.slice(0, 2))).toBe(s); // degenerate: no-op
    s = undo(s);
    expect(editStackPaths(s.current)[0].points[0]).toEqual({ x: 0, y: 0 });
  });

  it("seeds from an initial EditPaths (including a legacy version-1 value)", () => {
    const legacy = { version: 1, paths: [], brush_strokes: [stroke("s0")], matte_strokes: [], operations: [], points: [] };
    const s = initEditState(legacy);
    expect(editCount(s.current)).toBe(1);
    expect(canUndo(s)).toBe(false);
  });
});
