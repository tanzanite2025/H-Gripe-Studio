import { describe, expect, it } from "vitest";
import {
  emptyImageEditorDocument,
  emptyLayerMask,
  emptyPixelLayer,
  type ImageEditorDocument,
} from "../contracts/imageEditorDocument";
import {
  duplicateActiveLayerInDocument,
  insertMaterializedLayerViaCopyInDocument,
} from "./imageEditorLayerDuplication";

function sourceDocument(): ImageEditorDocument {
  const source = {
    ...emptyPixelLayer("Photo"),
    ops: [
      {
        type: "source_image",
        source: { path: "C:/photo.png", width: 80, height: 60 },
        placement: [10, 20, 90, 80] as [number, number, number, number],
      },
      { type: "transform", dx: 4, dy: 7 },
    ],
    mask: {
      ...emptyLayerMask(),
      ops: [{ type: "invert" }],
    },
  };
  return {
    ...emptyImageEditorDocument(),
    layers: [source],
    active: 0,
  };
}

describe("duplicateActiveLayerInDocument", () => {
  it("builds an overlapping ordinary duplicate without mutating the source document", () => {
    const document = sourceDocument();
    const next = duplicateActiveLayerInDocument(document);

    expect(next).not.toBe(document);
    expect(next.layers).toHaveLength(2);
    expect(next.active).toBe(1);
    expect(next.layers[0]).toBe(document.layers[0]);
    expect(next.layers[1].id).not.toBe(document.layers[0].id);
    expect(next.layers[1].name).toBe("Photo copy");
    expect(next.layers[1].ops).toEqual(document.layers[0].ops);
    expect(next.layers[1].ops).not.toBe(document.layers[0].ops);
    expect(next.layers[1].mask?.id).not.toBe(document.layers[0].mask?.id);
    expect(next.layers[1].mask?.ops).toEqual(document.layers[0].mask?.ops);
  });

  it("never invents source content or placement for an implicit empty base", () => {
    const document = emptyImageEditorDocument();
    const next = duplicateActiveLayerInDocument(document);

    expect(next.layers[0].ops).toEqual([]);
    expect(next.layers[1].ops).toEqual([]);
  });

  it("is a no-op when the document has no active layer", () => {
    const document = { ...emptyImageEditorDocument(), layers: [], active: -1 };
    expect(duplicateActiveLayerInDocument(document)).toBe(document);
  });

  it("inserts a Rust-materialized compact copy without replaying source state", () => {
    const document = sourceDocument();
    document.layers[0] = { ...document.layers[0], blend: "multiply", opacity: 0.35 };
    const next = insertMaterializedLayerViaCopyInDocument(document, document.layers[0].id, {
      source: { path: "C:/copies/copy.png", width: 4, height: 2 },
      placement: [20, 30, 24, 32],
    });

    expect(next.layers[1]).toMatchObject({
      name: "Photo copy",
      kind: "pixel",
      blend: "multiply",
      opacity: 1,
      visible: true,
      ops: [{
        type: "source_image",
        source: { path: "C:/copies/copy.png", width: 4, height: 2 },
        placement: [20, 30, 24, 32],
      }],
    });
    expect(next.layers[1].mask).toBeUndefined();
    expect(next.layers[1].ops.every((op) => op.clip == null && op.type !== "transform")).toBe(true);
  });

  it("does not invent a copy when Rust materialization is invalid or stale", () => {
    const document = sourceDocument();
    expect(insertMaterializedLayerViaCopyInDocument(document, "missing", {
      source: { path: "C:/copies/copy.png", width: 4, height: 2 },
      placement: [20, 30, 24, 32],
    })).toBe(document);
    expect(insertMaterializedLayerViaCopyInDocument(document, document.layers[0].id, {
      source: { path: "", width: 4, height: 2 },
      placement: [20, 30, 24, 32],
    })).toBe(document);
  });
});
