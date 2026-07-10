import { describe, expect, it } from "vitest";
import { emptyMaskDocument } from "../contracts/maskDocument";
import {
  imageCompositeTarget,
  imageDocumentFrameHidden,
  imageDocumentHasVisibleSource,
  imageDocumentNeedsComposite,
  imageLayerContentBounds,
  imageLayerDrawsSource,
  imageLayerHasSourceContent,
  layerCompositeTransform,
  withActiveLayerDraftTransform,
} from "./imageCompositeSource";

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

  it("keeps the image frame visible when the base is hidden but a source copy is visible", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].visible = false;
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }],
    });
    expect(imageLayerDrawsSource(doc.layers[0], 0)).toBe(false);
    expect(imageLayerDrawsSource(doc.layers[1], 1)).toBe(true);
    expect(imageDocumentHasVisibleSource(doc)).toBe(true);
    expect(imageDocumentFrameHidden(doc)).toBe(false);
  });

  it("keeps hidden source layers identifiable for thumbnails without drawing them", () => {
    const doc = emptyMaskDocument();
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      visible: false,
      ops: [{ type: "source_image" }],
    });
    expect(imageLayerHasSourceContent(doc.layers[1], 1)).toBe(true);
    expect(imageLayerDrawsSource(doc.layers[1], 1)).toBe(false);
  });

  it("does not treat fully transparent source layers as visible frame content", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].visible = false;
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      opacity: 0,
      ops: [{ type: "source_image" }],
    });
    expect(imageLayerHasSourceContent(doc.layers[1], 1)).toBe(true);
    expect(imageLayerDrawsSource(doc.layers[1], 1)).toBe(false);
    expect(imageDocumentFrameHidden(doc)).toBe(true);
  });

  it("hides the frame only after every source-backed layer is hidden or gone", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].visible = false;
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }],
    });
    expect(imageDocumentFrameHidden(doc)).toBe(false);
    doc.layers[1].visible = false;
    expect(imageDocumentFrameHidden(doc)).toBe(true);
    doc.layers.splice(1, 1);
    expect(imageDocumentFrameHidden(doc)).toBe(true);
  });

  it("resolves image-layer content bounds for implicit background and source copies", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].mask = { id: "mask-base", ops: [{ type: "rect", region: [2, 3, 12, 14] }] };
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }],
      mask: { id: "mask-copy", ops: [{ type: "rect", region: [4, 5, 16, 18] }] },
    });
    expect(imageLayerContentBounds(doc.layers[0], 0, { w: 20, h: 20 })).toEqual([2, 3, 13, 15]);
    expect(imageLayerContentBounds(doc.layers[1], 1, { w: 20, h: 20 })).toEqual([4, 5, 17, 19]);
  });

  it("keeps image-layer content bounds in pre-transform space", () => {
    const doc = emptyMaskDocument();
    doc.layers.push({
      ...emptyMaskDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [{ type: "source_image" }, { type: "transform", dx: 8, dy: 0, scale: 1, rotate: 0 }],
      mask: { id: "mask-copy", ops: [{ type: "rect", region: [4, 5, 12, 15] }] },
    });
    expect(imageLayerContentBounds(doc.layers[1], 1, { w: 20, h: 20 })).toEqual([4, 5, 13, 16]);
    expect(layerCompositeTransform(doc.layers[1])).toEqual({ dx: 8, dy: 0, scale: 1, rotate: 0 });
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

  it("resolves the layer display transform from committed ops plus live draft", () => {
    const doc = emptyMaskDocument();
    doc.layers[0].ops.push({ type: "transform", dx: 4, dy: 6, scale: 1, rotate: 0 });
    expect(layerCompositeTransform(doc.layers[0], [3, -2])).toEqual({
      dx: 7,
      dy: 4,
      scale: 1,
      rotate: 0,
    });
  });
});
