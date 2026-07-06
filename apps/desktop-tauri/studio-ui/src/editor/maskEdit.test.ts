import { describe, expect, it } from "vitest";
import {
  activeOps,
  addBrushStroke,
  addLayer,
  addMatteStroke,
  addOperation,
  addPath,
  addPoint,
  canRedo,
  canUndo,
  clearEdits,
  composeTransforms,
  duplicateLayer,
  editCount,
  initEditState,
  moveLayer,
  normalizeEditPaths,
  isEmpty,
  redo,
  renameLayer,
  reselect,
  removeLayer,
  removeOp,
  setActiveLayer,
  setLayerBlend,
  setLayerGroup,
  setLayerGroups,
  setLayerOpacity,
  toggleLayerLink,
  toggleLayerLock,
  toggleLayerVisible,
  toggleOp,
  undo,
  updateOpAmount,
  updatePathAnchors,
} from "./maskEdit";
import type { BrushStroke, MaskDocument } from "../types/production";
import { isBrushOp, isMaskOperation, isPathOp } from "../types/production";

const stackPaths = (doc: MaskDocument) => activeOps(doc).filter(isPathOp);
const stackBrushStrokes = (doc: MaskDocument) => activeOps(doc).filter(isBrushOp);
const stackOperations = (doc: MaskDocument) => activeOps(doc).filter(isMaskOperation);

const stroke = (id: string): BrushStroke => ({
  id,
  mode: "add",
  radius: 12,
  points: [
    [0, 0],
    [4, 4],
  ],
});

describe("maskEdit composeTransforms", () => {
  it("composes translations additively", () => {
    expect(
      composeTransforms({ dx: 10, dy: 5, scale: 1, rotate: 0 }, { dx: -4, dy: 3, scale: 1, rotate: 0 }),
    ).toEqual({ dx: 6, dy: 8, scale: 1, rotate: 0 });
  });
  it("carries the earlier translation through the later rotation and scale", () => {
    const t = composeTransforms({ dx: 10, dy: 0, scale: 1, rotate: 0 }, { dx: 0, dy: 0, scale: 2, rotate: 90 });
    expect(t.dx).toBeCloseTo(0);
    expect(t.dy).toBeCloseTo(20);
    expect(t.scale).toBe(2);
    expect(t.rotate).toBe(90);
  });
});

describe("maskEdit normalizeEditPaths", () => {
  it("returns an empty, well-formed single-layer document for junk input", () => {
    for (const bad of [null, undefined, 42, "x", {}]) {
      const e = normalizeEditPaths(bad);
      expect(e.version).toBe(3);
      expect(e.layers).toHaveLength(1);
      expect(e.layers[0].ops).toEqual([]);
      expect(e.layers[0].blend).toBe("normal");
      expect(e.layers[0].visible).toBe(true);
      expect(e.active).toBe(0);
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
    expect(e.version).toBe(3);
    expect(e.layers[0].ops.map((op) => op.type)).toEqual(["path", "brush", "feather"]);
    expect(e.matte_strokes).toHaveLength(1);
  });

  it("loads a version-2 ops stack as the single background layer (recorded order)", () => {
    const e = normalizeEditPaths({
      version: 2,
      ops: [{ type: "invert" }, { ...stroke("s1"), type: "brush" }],
      matte_strokes: [],
      points: [],
    });
    expect(e.layers).toHaveLength(1);
    expect(e.layers[0].ops.map((op) => op.type)).toEqual(["invert", "brush"]);
  });

  it("loads a version-3 layered document, clamping malformed fields", () => {
    const e = normalizeEditPaths({
      version: 3,
      layers: [
        { name: "bg", ops: [{ type: "invert" }] },
        { name: "top", blend: "screen", opacity: 2, visible: false, ops: [] },
      ],
      active: 99,
    });
    expect(e.layers).toHaveLength(2);
    expect(e.layers[0].name).toBe("bg");
    expect(e.layers[1].blend).toBe("screen");
    expect(e.layers[1].opacity).toBe(1); // clamped
    expect(e.layers[1].visible).toBe(false);
    expect(e.active).toBe(1); // clamped into range
  });

  it("normalizes visual layer groups as tags without changing stack order", () => {
    const e = normalizeEditPaths({
      version: 3,
      layerGroups: [
        { id: "g1", name: "Subject", color: "#FFAA00" },
        { id: "bad", name: "", color: "#000000" },
        { id: "g2", name: "Light", color: "#59c98f" },
        { id: "bad-color", name: "Skip", color: "not-a-color" },
      ],
      layers: [
        { name: "bg", groupId: "g1", ops: [] },
        { name: "middle", groupId: "missing", ops: [] },
        { name: "top", groupId: "g2", ops: [] },
      ],
    });
    expect(e.layerGroups).toEqual([
      { id: "g1", name: "Subject", color: "#ffaa00" },
      { id: "g2", name: "Light", color: "#59c98f" },
    ]);
    expect(e.layers.map((layer) => layer.name)).toEqual(["bg", "middle", "top"]);
    expect(e.layers.map((layer) => layer.groupId)).toEqual(["g1", undefined, "g2"]);
  });
});

describe("maskEdit reducer-style helpers", () => {
  it("records brush strokes and operations and counts them", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = addOperation(s, { type: "feather", amount: 3 });
    expect(stackBrushStrokes(s.current)).toHaveLength(1);
    expect(stackOperations(s.current)).toHaveLength(1);
    expect(activeOps(s.current).map((op) => op.type)).toEqual(["brush", "feather"]);
    expect(editCount(s.current)).toBe(2);
    expect(isEmpty(s.current)).toBe(false);
  });

  it("records trimap matting-band strokes and counts them", () => {
    let s = initEditState();
    s = addMatteStroke(s, stroke("m1"));
    expect(s.current.matte_strokes).toHaveLength(1);
    expect(stackBrushStrokes(s.current)).toHaveLength(0);
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
    expect(stackPaths(s.current)).toHaveLength(1);
    expect(editCount(s.current)).toBe(1);
    expect(isEmpty(s.current)).toBe(false);
    s = undo(s);
    expect(stackPaths(s.current)).toHaveLength(0);
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
    expect(stackPaths(s.current)).toHaveLength(0);
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
    expect(stackBrushStrokes(s.current)).toHaveLength(0);
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
    expect(stackOperations(s.current)).toHaveLength(1);
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

  it("reselect restores the last non-empty snapshot only when empty (undoable)", () => {
    let s = initEditState();
    expect(reselect(s)).toBe(s); // nothing to reselect
    s = addBrushStroke(s, stroke("s1"));
    expect(reselect(s)).toBe(s); // live document: no-op
    s = clearEdits(s);
    s = reselect(s);
    expect(editCount(s.current)).toBe(1);
    s = undo(s);
    expect(isEmpty(s.current)).toBe(true);
  });

  it("duplicates the active layer above itself with a fresh id (undoable)", () => {
    let s = initEditState();
    s = addOperation(s, { type: "invert" });
    s = duplicateLayer(s);
    expect(s.current.layers).toHaveLength(2);
    expect(s.current.active).toBe(1);
    expect(s.current.layers[1].name).toBe(`${s.current.layers[0].name} copy`);
    expect(s.current.layers[1].id).not.toBe(s.current.layers[0].id);
    expect(s.current.layers[1].ops.map((op) => op.type)).toEqual(["invert"]);
    expect(s.current.layers[1].ops[0]).not.toBe(s.current.layers[0].ops[0]);
    s = undo(s);
    expect(s.current.layers).toHaveLength(1);
  });

  it("renames a layer (undoable) and ignores blank or unchanged names", () => {
    let s = initEditState();
    const original = s.current.layers[0].name;
    expect(renameLayer(s, 0, "   ")).toBe(s);
    expect(renameLayer(s, 0, original)).toBe(s);
    expect(renameLayer(s, 5, "x")).toBe(s);
    s = renameLayer(s, 0, "  Sky mask  ");
    expect(s.current.layers[0].name).toBe("Sky mask");
    s = undo(s);
    expect(s.current.layers[0].name).toBe(original);
  });

  it("locks a layer (undoable): rejects new edits and deletion until unlocked", () => {
    let s = initEditState();
    s = addLayer(s, "B"); // active = 1 (B)
    s = toggleLayerLock(s, 1);
    expect(s.current.layers[1].locked).toBe(true);
    expect(addBrushStroke(s, stroke("s1"))).toBe(s);
    expect(addOperation(s, { type: "invert" })).toBe(s);
    expect(removeLayer(s, 1)).toBe(s);
    s = toggleLayerLock(s, 1);
    expect(s.current.layers[1].locked).toBeFalsy();
    s = addBrushStroke(s, stroke("s1"));
    expect(editCount(s.current)).toBe(1);
  });

  it("mirrors transform ops across linked, unlocked mask layers as one undo step", () => {
    let s = initEditState();
    s = addLayer(s, "B");
    s = addLayer(s, "C");
    s = addLayer(s, "D"); // stack: [Background, B, C, D], active = 3 (D)
    s = toggleLayerLink(s, 1); // B linked
    s = toggleLayerLink(s, 3); // D linked (active)
    s = toggleLayerLock(s, 1); // ...but B is locked, so it must be skipped
    const move = { type: "transform" as const, dx: 5, dy: -3 };
    const before = s;
    s = addOperation(s, move);
    expect(s.current.layers[3].ops).toEqual([move]);
    expect(s.current.layers[1].ops).toEqual([]); // linked but locked
    expect(s.current.layers[2].ops).toEqual([]); // not linked
    expect(s.current.layers[0].ops).toEqual([]);
    s = undo(s);
    expect(s.current).toEqual(before.current);
    // Non-transform ops never mirror.
    s = addOperation(s, { type: "invert" });
    expect(s.current.layers[3].ops).toEqual([{ type: "invert" }]);
    expect(s.current.layers[1].ops).toEqual([]);
  });

  it("normalizes the extended blend set and the locked flag from storage", () => {
    const e = normalizeEditPaths({
      version: 3,
      layers: [
        { name: "a", blend: "darken", locked: true, ops: [] },
        { name: "b", blend: "bogus", locked: "yes", ops: [] },
      ],
      active: 0,
    });
    expect(e.layers[0].blend).toBe("darken");
    expect(e.layers[0].locked).toBe(true);
    expect(e.layers[1].blend).toBe("normal");
    expect(e.layers[1].locked).toBeUndefined();
  });

  it("moves a layer within the stack, keeping the active layer by identity", () => {
    let s = initEditState();
    s = addLayer(s, "B");
    s = addLayer(s, "C"); // stack: [Background, B, C], active = 2 (C)
    const activeId = s.current.layers[2].id;
    s = moveLayer(s, 2, 0); // stack: [C, Background, B]
    expect(s.current.layers.map((l) => l.name)).toEqual(["C", "Background", "B"]);
    expect(s.current.layers[s.current.active].id).toBe(activeId);
    expect(moveLayer(s, 1, 1)).toBe(s);
    expect(moveLayer(s, -1, 0)).toBe(s);
    expect(moveLayer(s, 0, 9)).toBe(s);
    s = undo(s);
    expect(s.current.layers.map((l) => l.name)).toEqual(["Background", "B", "C"]);
  });

  it("removes a history step (undoable)", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = addOperation(s, { type: "feather", amount: 3 });
    s = removeOp(s, 0);
    expect(activeOps(s.current).map((op) => op.type)).toEqual(["feather"]);
    s = undo(s);
    expect(activeOps(s.current).map((op) => op.type)).toEqual(["brush", "feather"]);
    expect(removeOp(s, 99)).toBe(s); // out of range: no-op
  });

  it("toggles a step's disabled flag without dropping it from history", () => {
    let s = initEditState();
    s = addOperation(s, { type: "invert" });
    s = toggleOp(s, 0);
    expect(activeOps(s.current)[0].disabled).toBe(true);
    s = toggleOp(s, 0);
    expect(activeOps(s.current)[0].disabled).toBeUndefined();
    expect(toggleOp(s, 5)).toBe(s);
  });

  it("revises a queued operation's amount (undoable, ops-only)", () => {
    let s = initEditState();
    s = addOperation(s, { type: "feather", amount: 3 });
    s = addBrushStroke(s, stroke("s1"));
    s = updateOpAmount(s, 0, 8);
    expect(stackOperations(s.current)[0].amount).toBe(8);
    expect(updateOpAmount(s, 0, 8)).toBe(s); // unchanged value: no-op
    expect(updateOpAmount(s, 1, 8)).toBe(s); // brush step: no-op
    s = undo(s);
    expect(stackOperations(s.current)[0].amount).toBe(3);
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
    expect(stackPaths(s.current)[0].points).toEqual(moved);
    expect(updatePathAnchors(s, 0, moved.slice(0, 2))).toBe(s); // degenerate: no-op
    s = undo(s);
    expect(stackPaths(s.current)[0].points[0]).toEqual({ x: 0, y: 0 });
  });

  it("adds a layer above the stack, records edits onto it, and undoes", () => {
    let s = initEditState();
    s = addBrushStroke(s, stroke("s1"));
    s = addLayer(s);
    expect(s.current.layers).toHaveLength(2);
    expect(s.current.active).toBe(1);
    s = addOperation(s, { type: "invert" });
    expect(s.current.layers[0].ops.map((op) => op.type)).toEqual(["brush"]);
    expect(s.current.layers[1].ops.map((op) => op.type)).toEqual(["invert"]);
    s = undo(s);
    s = undo(s);
    expect(s.current.layers).toHaveLength(1);
    expect(s.current.active).toBe(0);
  });

  it("removes a layer (undoable) but never the last one", () => {
    let s = initEditState();
    expect(removeLayer(s, 0)).toBe(s); // last layer: no-op
    s = addLayer(s);
    s = removeLayer(s, 1);
    expect(s.current.layers).toHaveLength(1);
    expect(s.current.active).toBe(0);
    s = undo(s);
    expect(s.current.layers).toHaveLength(2);
  });

  it("selects the active layer without recording an undo step", () => {
    let s = initEditState();
    s = addLayer(s);
    const before = s;
    s = setActiveLayer(s, 0);
    expect(s.current.active).toBe(0);
    expect(s.past).toBe(before.past); // no new history entry
    expect(setActiveLayer(s, 9)).toBe(s); // out of range: no-op
  });

  it("toggles visibility and revises blend / opacity (undoable, clamped)", () => {
    let s = initEditState();
    s = addLayer(s);
    s = toggleLayerVisible(s, 1);
    expect(s.current.layers[1].visible).toBe(false);
    s = setLayerBlend(s, 1, "screen");
    expect(s.current.layers[1].blend).toBe("screen");
    expect(setLayerBlend(s, 1, "screen")).toBe(s); // unchanged: no-op
    s = setLayerOpacity(s, 1, 2);
    expect(s.current.layers[1].opacity).toBe(1); // clamped
    s = setLayerOpacity(s, 1, 0.4);
    expect(s.current.layers[1].opacity).toBe(0.4);
    s = undo(s);
    expect(s.current.layers[1].opacity).toBe(1);
  });

  it("assigns optional visual layer groups without reordering layers", () => {
    let s = initEditState();
    s = addLayer(s, "Top");
    s = setLayerGroups(s, [{ id: "g1", name: "Subject", color: "#5aa7ff" }]);
    s = setLayerGroup(s, 0, "g1");
    expect(s.current.layers.map((layer) => layer.name)).toEqual(["Background", "Top"]);
    expect(s.current.layers[0].groupId).toBe("g1");
    expect(s.current.layers[1].groupId).toBeUndefined();
    s = setLayerGroup(s, 0, null);
    expect(s.current.layers[0].groupId).toBeUndefined();
    s = setLayerGroup(s, 1, "missing");
    expect(s.current.layers[1].groupId).toBeUndefined();
    s = setLayerGroup(s, 1, "g1");
    s = setLayerGroups(s, []);
    expect(s.current.layerGroups).toEqual([]);
    expect(s.current.layers.map((layer) => layer.groupId)).toEqual([undefined, undefined]);
    expect(s.current.layers.map((layer) => layer.name)).toEqual(["Background", "Top"]);
  });

  it("appends new visual layer groups instead of replacing existing tags", () => {
    let s = initEditState();
    s = setLayerGroups(s, [{ id: "g1", name: "2", color: "#5aa7ff" }]);
    s = setLayerGroups(s, [
      ...s.current.layerGroups,
      { id: "g2", name: "我", color: "#59c98f" },
    ]);
    expect(s.current.layerGroups.map((group) => group.name)).toEqual(["2", "我"]);
  });

  it("seeds from an initial EditPaths (including a legacy version-1 value)", () => {
    const legacy = { version: 1, paths: [], brush_strokes: [stroke("s0")], matte_strokes: [], operations: [], points: [] };
    const s = initEditState(legacy);
    expect(editCount(s.current)).toBe(1);
    expect(canUndo(s)).toBe(false);
  });
});
