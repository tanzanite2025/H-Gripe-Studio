import { describe, expect, it } from "vitest";
import { emptyLayerMask, emptyImageEditorDocument, type ImageEditorDocument } from "../contracts/imageEditorDocument";
import { type EditPath } from "../contracts/imageEditOps";
import {
  pathBounds,
  resolveActiveTarget,
  resolveTargetBounds,
  transformLayerTargetBounds,
  transformRect,
  type SelectionTarget,
  type StudioDocumentRef,
} from "./studioTarget";

const ref: StudioDocumentRef = { canvasId: "canvas-1", documentId: "doc-1" };
const dims = { w: 100, h: 80 };

function docWithLayer(): ImageEditorDocument {
  const doc = emptyImageEditorDocument();
  doc.layers[0] = { ...doc.layers[0], id: "layer-base", name: "Base" };
  return doc;
}

describe("studio target bounds", () => {
  it("resolves the document's explicit pixel or mask active target", () => {
    const doc = docWithLayer();
    expect(resolveActiveTarget(doc, ref)).toEqual({ kind: "pixel_layer", ...ref, layerId: "layer-base" });

    const mask = { ...emptyLayerMask(), id: "mask-base" };
    doc.layers[0] = { ...doc.layers[0], mask };
    doc.activeTarget = "mask";

    expect(resolveActiveTarget(doc, ref)).toEqual({ kind: "layer_mask", ...ref, layerId: "layer-base", maskId: "mask-base" });
  });

  it("resolves an empty layer stack to the document target", () => {
    const doc = docWithLayer();
    doc.layers = [];
    doc.active = -1;
    expect(resolveActiveTarget(doc, ref)).toEqual({ kind: "document", ...ref });
  });

  it("returns a full layer frame unless explicit content bounds exist", () => {
    const doc = docWithLayer();
    const target = { kind: "pixel_layer" as const, ...ref, layerId: "layer-base" };

    expect(resolveTargetBounds(doc, target, { dims })).toEqual({ kind: "layer_frame", rect: [0, 0, 100, 80], layerId: "layer-base" });
    expect(resolveTargetBounds(doc, target, { dims, layerContentBounds: { "layer-base": [90, 70, 20, 10] } })).toEqual({
      kind: "content",
      rect: [20, 10, 90, 70],
      layerId: "layer-base",
      source: "override",
    });
  });

  it("resolves layer mask bounds separately from pixel content", () => {
    const doc = docWithLayer();
    doc.layers[0] = { ...doc.layers[0], mask: { ...emptyLayerMask(), id: "mask-base" } };
    const target = { kind: "layer_mask" as const, ...ref, layerId: "layer-base", maskId: "mask-base" };

    expect(resolveTargetBounds(doc, target, { dims })).toEqual({ kind: "mask", rect: [0, 0, 100, 80], layerId: "layer-base", maskId: "mask-base" });
    expect(resolveTargetBounds(doc, target, { dims, layerMaskBounds: { "mask-base": [-5, 4, 40, 90] } })).toEqual({
      kind: "mask",
      rect: [0, 4, 40, 80],
      layerId: "layer-base",
      maskId: "mask-base",
    });
  });

  it("resolves selection and path bounds without DOM state", () => {
    const doc = docWithLayer();
    const selection: SelectionTarget = { id: "sel-1", source: "marquee", bounds: [-10, 5, 25, 90] };
    const path: EditPath = {
      id: "path-1",
      mode: "add",
      tool: "pen",
      closed: true,
      points: [
        { x: 10, y: 10, out: [70, 4] },
        { x: 30, y: 50, in: [20, 75] },
      ],
    };

    expect(resolveTargetBounds(doc, { kind: "selection", ...ref, selectionId: "sel-1" }, { dims, selections: [selection] })).toEqual({
      kind: "selection",
      rect: [0, 5, 25, 80],
      selectionId: "sel-1",
    });
    expect(pathBounds(path, dims)).toEqual([10, 4, 70, 75]);
    expect(resolveTargetBounds(doc, { kind: "path", ...ref, pathId: "path-1" }, { dims, paths: [path] })).toEqual({
      kind: "path",
      rect: [10, 4, 70, 75],
      pathId: "path-1",
    });
  });

  it("resolves node output bounds by node-port key", () => {
    const doc = docWithLayer();

    expect(
      resolveTargetBounds(doc, { kind: "node_output", canvasId: "canvas-1", nodeId: "node-1", portId: "image" }, {
        dims,
        nodeOutputBounds: { "node-1:image": [4, 6, 60, 70] },
      }),
    ).toEqual({ kind: "node_output", rect: [4, 6, 60, 70], nodeId: "node-1", portId: "image" });
  });

  it("transforms only layer-bound display bounds", () => {
    const transform = { dx: 5, dy: -3, scale: 1, rotate: 0 };

    expect(transformRect([10, 12, 30, 32], transform, dims)).toEqual([15, 9, 35, 29]);
    expect(transformLayerTargetBounds({ kind: "layer_frame", rect: [10, 12, 30, 32], layerId: "layer-base" }, transform, dims)).toEqual({
      kind: "layer_frame",
      rect: [15, 9, 35, 29],
      layerId: "layer-base",
    });
    expect(transformLayerTargetBounds({ kind: "selection", rect: [10, 12, 30, 32], selectionId: "sel-1" }, transform, dims)).toEqual({
      kind: "selection",
      rect: [10, 12, 30, 32],
      selectionId: "sel-1",
    });
  });
});
