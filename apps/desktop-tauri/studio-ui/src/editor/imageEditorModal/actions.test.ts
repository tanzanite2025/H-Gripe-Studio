import { describe, expect, it } from "vitest";
import { emptyImageEditorDocument } from "../../contracts/imageEditorDocument";
import { initEditState, undo } from "../imageEditorState";
import { imageEditorReducer } from "./actions";

describe("imageEditorReducer Layer Via Copy", () => {
  it("commits the prepared compact layer as one history transaction", () => {
    const state = initEditState(emptyImageEditorDocument());
    const baseDocument = state.current;
    const next = imageEditorReducer(state, {
      type: "layer_via_copy_commit",
      baseDocument,
      sourceLayerId: baseDocument.layers[0].id,
      materialized: {
        source: { path: "C:/copies/copy.png", width: 4, height: 2 },
        placement: [20, 30, 24, 32],
      },
    });

    expect(next.past).toHaveLength(1);
    expect(next.current.layers).toHaveLength(2);
    expect(next.current.layers[1].ops).toEqual([{
      type: "source_image",
      source: { path: "C:/copies/copy.png", width: 4, height: 2 },
      placement: [20, 30, 24, 32],
    }]);
  });
});

describe("imageEditorReducer dropped image batch", () => {
  it("adds ordered placed layers as one undoable transaction", () => {
    const state = initEditState(emptyImageEditorDocument());
    const next = imageEditorReducer(state, {
      type: "layer_add_images",
      sources: [
        { path: "C:/images/a.png", width: 80, height: 60 },
        { path: "C:/images/b.png", width: 20, height: 10 },
      ],
      canvas: { w: 100, h: 100 },
    });

    expect(next.past).toHaveLength(1);
    expect(next.current.layers.slice(1).map((layer) => layer.name)).toEqual(["a.png", "b.png"]);
    expect(next.current.layers[1].ops[0]).toMatchObject({ placement: [10, 20, 90, 80] });
    expect(undo(next).current.layers).toHaveLength(1);
  });
});
