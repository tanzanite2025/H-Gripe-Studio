import { describe, expect, it } from "vitest";
import { emptyMaskDocument } from "../contracts/maskDocument";
import {
  imageCompositeTarget,
  imageLayerContentBounds,
  imageLayerDrawsSource,
  imageLayerHasSourceContent,
  layerCompositeTransform,
  layerSourceImageOp,
  withActiveLayerDraftTransform,
} from "./imageCompositeSource";
import { addImageLayer, fitPlacement, initEditState } from "./maskEdit";

describe("image composite viewport source", () => {
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

  it("contain-fits placements: small images centre 1:1, large images scale down", () => {
    expect(fitPlacement({ width: 800, height: 800 }, { w: 1600, h: 1200 })).toEqual([400, 200, 1200, 1000]);
    expect(fitPlacement({ width: 2000, height: 1000 }, { w: 1000, h: 1000 })).toEqual([0, 250, 1000, 750]);
  });

  it("adds a placed image layer that composites within its own bounds", () => {
    const state = addImageLayer(
      initEditState(emptyMaskDocument()),
      { path: "C:/imgs/photo.png", width: 800, height: 600 },
      { w: 1600, h: 1200 },
    );
    const doc = state.current;
    expect(doc.layers).toHaveLength(2);
    expect(doc.active).toBe(1);
    expect(doc.layers[1].name).toBe("photo.png");
    const op = layerSourceImageOp(doc.layers[1]);
    expect(op?.source).toEqual({ path: "C:/imgs/photo.png", width: 800, height: 600 });
    expect(op?.placement).toEqual([400, 300, 1200, 900]);
    // Legacy source copies never read as placed.
    expect(layerSourceImageOp({ ...doc.layers[1], ops: [{ type: "source_image" }] })).toBeNull();
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
