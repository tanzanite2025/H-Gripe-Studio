import { describe, expect, it } from "vitest";
import { emptyImageEditorDocument } from "../contracts/imageEditorDocument";
import { imageCompositeTarget } from "./imageCompositeTarget";
import { imageLayerContentBounds, layerCompositeTransform } from "./imageLayerGeometry";
import {
  imageCompositeBackingPath,
  imageLayerDrawsSource,
  imageLayerHasSourceContent,
  layerSourceImageOp,
} from "./imageLayerSource";
import { addImageLayer, fitPlacement, initEditState } from "./imageEditorState";

describe("image composite module boundaries", () => {
  const placedSource = {
    type: "source_image" as const,
    placement: [0, 0, 20, 20] as [number, number, number, number],
  };

  it("keeps the image frame visible when a hidden layer has a visible placed source sibling", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].visible = false;
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [placedSource],
    });
    expect(imageLayerDrawsSource(doc.layers[0])).toBe(false);
    expect(imageLayerDrawsSource(doc.layers[1])).toBe(true);
  });

  it("keeps hidden source layers identifiable for thumbnails without drawing them", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "copy",
      name: "Background copy",
      visible: false,
      ops: [placedSource],
    });
    expect(imageLayerHasSourceContent(doc.layers[1])).toBe(true);
    expect(imageLayerDrawsSource(doc.layers[1])).toBe(false);
  });

  it("does not treat fully transparent source layers as visible frame content", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].visible = false;
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "copy",
      name: "Background copy",
      opacity: 0,
      ops: [placedSource],
    });
    expect(imageLayerHasSourceContent(doc.layers[1])).toBe(true);
    expect(imageLayerDrawsSource(doc.layers[1])).toBe(false);
  });

  it("requires an enabled source_image with explicit non-empty placement", () => {
    const layer = emptyImageEditorDocument().layers[0];
    expect(imageLayerHasSourceContent(layer)).toBe(false);
    expect(imageLayerHasSourceContent({ ...layer, ops: [{ type: "source_image" }] })).toBe(false);
    expect(imageLayerHasSourceContent({
      ...layer,
      ops: [{ type: "source_image", placement: [0, 0, 0, 20] }],
    })).toBe(false);
    expect(imageLayerHasSourceContent({
      ...layer,
      ops: [{ ...placedSource, disabled: true }],
    })).toBe(false);
    expect(imageLayerHasSourceContent({ ...layer, ops: [placedSource] })).toBe(true);
  });

  it("resolves image-layer content bounds only for explicit placed sources", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].ops = [placedSource];
    doc.layers[0].mask = { id: "mask-base", ops: [{ type: "rect", region: [2, 3, 12, 14] }] };
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [placedSource],
      mask: { id: "mask-copy", ops: [{ type: "rect", region: [4, 5, 16, 18] }] },
    });
    expect(imageLayerContentBounds(doc.layers[0], { w: 20, h: 20 })).toEqual([2, 3, 13, 15]);
    expect(imageLayerContentBounds(doc.layers[1], { w: 20, h: 20 })).toEqual([4, 5, 17, 19]);
  });

  it("keeps image-layer content bounds in pre-transform space", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "copy",
      name: "Background copy",
      ops: [placedSource, { type: "transform", dx: 8, dy: 0, scale: 1, rotate: 0 }],
      mask: { id: "mask-copy", ops: [{ type: "rect", region: [4, 5, 12, 15] }] },
    });
    expect(imageLayerContentBounds(doc.layers[1], { w: 20, h: 20 })).toEqual([4, 5, 13, 16]);
    expect(layerCompositeTransform(doc.layers[1])).toEqual({ dx: 8, dy: 0, scale: 1, rotate: 0 });
  });

  it("builds a stable image_composite viewport target", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].visible = false;
    const target = imageCompositeTarget("res-image", doc, { w: 320, h: 200 });
    expect(target).toMatchObject({
      kind: "image_composite",
      resourceId: "res-image",
      documentWidth: 320,
      documentHeight: 200,
      frameX: 0,
      frameY: 0,
      frameWidth: 320,
      frameHeight: 200,
    });
    if (target.kind !== "image_composite") throw new Error("expected image_composite target");
    expect(target.documentKey).toContain("\"visible\":false");
  });

  it("keeps document dimensions separate from the rendered scene frame", () => {
    const doc = emptyImageEditorDocument();
    const target = imageCompositeTarget("res-image", doc, { w: 320, h: 200 }, { x: -40, y: 0, w: 420, h: 260 });

    expect(target).toMatchObject({
      kind: "image_composite",
      documentWidth: 320,
      documentHeight: 200,
      frameX: -40,
      frameY: 0,
      frameWidth: 420,
      frameHeight: 260,
    });
    if (target.kind !== "image_composite") throw new Error("expected image_composite target");
    expect(target.documentKey).toContain("\"frame\":{\"x\":-40,\"y\":0,\"w\":420,\"h\":260}");
  });

  it("sanitizes non-finite composite dimensions and frame fields", () => {
    const doc = emptyImageEditorDocument();
    const target = imageCompositeTarget(
      "res-image",
      doc,
      { w: Number.NaN, h: Number.POSITIVE_INFINITY },
      { x: Number.NaN, y: Number.NEGATIVE_INFINITY, w: 0, h: Number.NaN },
    );

    expect(target).toMatchObject({
      kind: "image_composite",
      documentWidth: 1,
      documentHeight: 1,
      frameX: 0,
      frameY: 0,
      frameWidth: 1,
      frameHeight: 1,
    });
    if (target.kind !== "image_composite") throw new Error("expected image_composite target");
    expect(JSON.parse(target.documentKey).frame).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("contain-fits placements: small images centre 1:1, large images scale down", () => {
    expect(fitPlacement({ width: 800, height: 800 }, { w: 1600, h: 1200 })).toEqual([400, 200, 1200, 1000]);
    expect(fitPlacement({ width: 2000, height: 1000 }, { w: 1000, h: 1000 })).toEqual([0, 250, 1000, 750]);
  });

  it("adds a placed image layer that composites within its own bounds", () => {
    const state = addImageLayer(
      initEditState(emptyImageEditorDocument()),
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

  it("uses layer source images as the composite backing path when the opener path is absent", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].ops = [{
      type: "source_image",
      source: { path: "C:/imgs/base.png", width: 800, height: 600 },
      placement: [0, 0, 800, 600],
    }];

    expect(imageCompositeBackingPath(doc, null)).toBe("C:/imgs/base.png");
    expect(imageCompositeBackingPath(doc, "C:/imgs/opened.png")).toBe("C:/imgs/opened.png");
  });

  it("resolves the layer display transform from committed ops", () => {
    const doc = emptyImageEditorDocument();
    doc.layers[0].ops.push({ type: "transform", dx: 4, dy: 6, scale: 1, rotate: 0 });
    expect(layerCompositeTransform(doc.layers[0])).toEqual({
      dx: 4,
      dy: 6,
      scale: 1,
      rotate: 0,
    });
  });
});
