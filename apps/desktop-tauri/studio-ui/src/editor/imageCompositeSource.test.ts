import { describe, expect, it } from "vitest";
import { emptyMaskDocument } from "../types/production";
import { imageCompositeTarget, imageDocumentNeedsComposite, withActiveLayerDraftTransform } from "./imageCompositeSource";

describe("image composite viewport source", () => {
  it("keeps a plain background image on the light underlay path", () => {
    expect(imageDocumentNeedsComposite(emptyMaskDocument())).toBe(false);
  });

  it("uses the composite target when the background is hidden", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].visible = false;
    expect(imageDocumentNeedsComposite(doc)).toBe(true);
  });

  it("uses the composite target for source-backed copied layers", () => {
    const doc = emptyMaskDocument();
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }],
    });
    expect(imageDocumentNeedsComposite(doc)).toBe(true);
  });

  it("builds a stable image_composite viewport target", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].visible = false;
    const target = imageCompositeTarget("res-image", doc, { w: 320, h: 200 });
    expect(target).toMatchObject({
      kind: "image_composite",
      resourceId: "res-image",
      documentWidth: 320,
      documentHeight: 200,
    });
    if (target.kind !== "image_composite") throw new Error("expected image_composite target");
    expect(target.documentKey).toContain("\"visible\":false");
  });

  it("adds live move draft transforms only to the active pixel layer", () => {
    const doc = emptyMaskDocument();
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }],
    });
    doc.active = 1;
    const preview = withActiveLayerDraftTransform(doc, [8, -3]);
    expect(doc.layers[1].ops).toEqual([{ type: "source_image" }]);
    expect(preview.layers[0].ops).toEqual([]);
    expect(preview.layers[1].ops).toEqual([{ type: "source_image" }, { type: "transform", dx: 8, dy: -3 }]);
  });
});
