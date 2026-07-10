import { describe, expect, it } from "vitest";
import {
  emptyAdjustmentLayer,
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

  it("keeps selection and path commands target-specific", () => {
    const doc = docWithTwoLayers();
    const selectionTarget: StudioTarget = { kind: "selection", canvasId: "canvas", documentId: "doc", selectionId: "sel-1" };
    const pathTarget: StudioTarget = { kind: "path", canvasId: "canvas", documentId: "doc", pathId: "path-1" };

    expect(getCommandCapability("selection.toMask", { doc, target: selectionTarget }).enabled).toBe(true);
    expect(getCommandCapability("path.makeSelection", { doc, target: pathTarget }).enabled).toBe(true);
    expect(getCommandCapability("path.makeSelection", { doc, target: selectionTarget }).enabled).toBe(false);
  });

  it("requires an editable pixel target and backend for AI commands", () => {
    const doc = docWithTwoLayers();

    expect(getCommandCapability("ai.removeBackground", { doc, target: pixelTarget }).enabled).toBe(false);
    expect(getCommandCapability("ai.removeBackground", { doc, target: pixelTarget, backendAvailable: true })).toMatchObject({
      enabled: true,
      requiresPreview: true,
    });

    doc.layers[1] = { ...emptyAdjustmentLayer("brightness_contrast", "Brightness"), id: "layer-1" };

    expect(getCommandCapability("ai.selectSubject", { doc, target: pixelTarget, backendAvailable: true }).enabled).toBe(false);
  });

  it("filters available commands from one resolver", () => {
    const doc = docWithTwoLayers();

    expect(availableCommands(["layer.invert", "layer.addMask", "path.makeSelection"], { doc, target: pixelTarget })).toEqual([
      "layer.invert",
      "layer.addMask",
    ]);
  });
});
