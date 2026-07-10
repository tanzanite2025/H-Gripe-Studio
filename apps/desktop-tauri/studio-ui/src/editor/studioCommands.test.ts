import { describe, expect, it } from "vitest";
import {
  emptyLayerMask,
  emptyMaskDocument,
  emptyMaskLayer,
  type MaskDocument,
} from "../contracts/maskDocument";
import { availableCommands, getCommandCapability } from "./studioCommands";
import type { StudioTarget } from "./studioTarget";

function docWithTwoLayers(): MaskDocument {
  const doc = emptyMaskDocument();
  doc.layers[0] = { ...doc.layers[0], id: "layer-base" };
  doc.layers.push({ ...emptyMaskLayer("Layer 1"), id: "layer-1" });
  doc.active = 1;
  return doc;
}

const pixelTarget: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-1" };

describe("studio command capabilities", () => {
  it("enables pixel-layer commands only for editable pixel targets", () => {
    const doc = docWithTwoLayers();

    expect(getCommandCapability("layer.invert", { doc, target: pixelTarget }).enabled).toBe(true);
    expect(getCommandCapability("layer.addMask", { doc, target: pixelTarget }).enabled).toBe(true);
    expect(getCommandCapability("target.transform", { doc, target: pixelTarget }).enabled).toBe(true);

    doc.layers[1] = { ...doc.layers[1], locked: true };

    expect(getCommandCapability("layer.invert", { doc, target: pixelTarget })).toMatchObject({
      enabled: false,
      reason: "target is not an editable pixel layer",
    });
  });

  it("does not allow adding a second mask to the same layer", () => {
    const doc = docWithTwoLayers();
    doc.layers[1] = { ...doc.layers[1], mask: { ...emptyLayerMask(), id: "mask-1" } };

    expect(getCommandCapability("layer.addMask", { doc, target: pixelTarget })).toMatchObject({
      enabled: false,
      reason: "layer already has a mask",
    });
  });

  it("routes delete and mask commands through the layer-mask target", () => {
    const doc = docWithTwoLayers();
    doc.layers[1] = { ...doc.layers[1], mask: { ...emptyLayerMask(), id: "mask-1" } };
    const maskTarget: StudioTarget = { kind: "layer_mask", canvasId: "canvas", documentId: "doc", layerId: "layer-1", maskId: "mask-1" };

    expect(getCommandCapability("mask.invert", { doc, target: maskTarget }).enabled).toBe(true);
    expect(getCommandCapability("mask.disable", { doc, target: maskTarget }).enabled).toBe(true);
    expect(getCommandCapability("target.transform", { doc, target: maskTarget }).enabled).toBe(false);
    expect(getCommandCapability("target.delete", { doc, target: maskTarget })).toMatchObject({ enabled: true, danger: true });
  });

  it("allows deleting the final unlocked layer and adding from an empty document", () => {
    const doc = emptyMaskDocument();
    doc.layers[0] = { ...doc.layers[0], id: "layer-base" };
    const target: StudioTarget = { kind: "pixel_layer", canvasId: "canvas", documentId: "doc", layerId: "layer-base" };
    expect(getCommandCapability("target.delete", { doc, target }).enabled).toBe(true);

    doc.layers = [];
    doc.active = -1;
    const documentTarget: StudioTarget = { kind: "document", canvasId: "canvas", documentId: "doc" };
    expect(getCommandCapability("layer.add", { doc, target: documentTarget }).enabled).toBe(true);
    expect(getCommandCapability("target.delete", { doc, target: documentTarget }).enabled).toBe(false);
  });

  it("keeps selection commands target-specific", () => {
    const doc = docWithTwoLayers();
    const selectionTarget: StudioTarget = { kind: "selection", canvasId: "canvas", documentId: "doc", selectionId: "sel-1" };

    expect(getCommandCapability("selection.invert", { doc, target: selectionTarget }).enabled).toBe(true);
    expect(getCommandCapability("selection.deselect", { doc, target: selectionTarget }).enabled).toBe(true);
    expect(getCommandCapability("selection.feather", { doc, target: pixelTarget }).enabled).toBe(false);
  });

  it("filters available commands from one resolver", () => {
    const doc = docWithTwoLayers();

    expect(availableCommands(["layer.invert", "layer.addMask", "selection.invert"], { doc, target: pixelTarget })).toEqual([
      "layer.invert",
      "layer.addMask",
    ]);
  });
});
