import { describe, expect, it } from "vitest";
import {
  emptyImageDocument,
  emptyImageLayer,
  fromMaskDocument,
  maskBridgeGap,
  toMaskDocument,
  type ImageDocument,
} from "./imageDocument";
import {
  emptyAdjustmentLayer,
  emptyMaskDocument,
  emptyMaskLayer,
  type EditOp,
  type MaskDocument,
} from "../types/production";

function sampleMaskDocument(): MaskDocument {
  const doc = emptyMaskDocument();
  doc.layerGroups = [
    { id: "g1", name: "Subject", color: "#5aa7ff" },
    { id: "g2", name: "Light", color: "#59c98f" },
  ];
  doc.layers[0].groupId = "g1";
  doc.layers[0].ops = [
    { type: "brush", points: [[1, 2]], size: 12, mode: "add" } as unknown as EditOp,
    { type: "feather", amount: 3 } as EditOp,
  ];
  const top = emptyMaskLayer("Layer 1");
  top.blend = "multiply";
  top.opacity = 0.5;
  top.locked = true;
  top.linked = false;
  top.groupId = "g2";
  const adj = emptyAdjustmentLayer("levels", "Levels 1");
  adj.adjustment = { type: "levels", in_black: 10, gamma: 1.2 };
  doc.layers.push(top, adj);
  doc.active = 1;
  doc.canvas = { w: 800, h: 600, resample: "bicubic" };
  doc.points = [{ x: 5, y: 6, label: 1 }];
  return doc;
}

describe("imageDocument bridge", () => {
  it("round-trips a mask draft losslessly", () => {
    const mask = sampleMaskDocument();
    const image = fromMaskDocument(mask);
    expect(toMaskDocument(image)).toEqual(mask);
  });

  it("maps layer kinds across the bridge", () => {
    const image = fromMaskDocument(sampleMaskDocument());
    expect(image.layers.map((l) => l.layer.kind)).toEqual(["pixel", "pixel", "adjustment"]);
    expect(image.layers.map((l) => l.groupId)).toEqual(["g1", "g2", undefined]);
    expect(image.layerGroups.map((group) => group.name)).toEqual(["Subject", "Light"]);
    expect(image.active).toBe(1);
    expect(image.canvas).toEqual({ w: 800, h: 600, resample: "bicubic" });
    const adj = image.layers[2].layer;
    expect(adj.kind === "adjustment" && adj.adjustment?.type).toBe("levels");
  });

  it("refuses to lower documents MaskDocument cannot express", () => {
    const grouped: ImageDocument = {
      ...emptyImageDocument(),
      layers: [{ ...emptyImageLayer(), layer: { kind: "group", children: [] } }],
    };
    expect(toMaskDocument(grouped)).toBeNull();
    expect(maskBridgeGap(grouped)).toContain("layer group");

    const clipped: ImageDocument = {
      ...emptyImageDocument(),
      layers: [{ ...emptyImageLayer(), clipped: true }],
    };
    expect(toMaskDocument(clipped)).toBeNull();
    expect(maskBridgeGap(clipped)).toContain("clipping mask");

    const masked: ImageDocument = {
      ...emptyImageDocument(),
      layers: [{ ...emptyImageLayer(), mask: { path: "m.png" } }],
    };
    expect(toMaskDocument(masked)).toBeNull();
    expect(maskBridgeGap(masked)).toContain("baked layer mask");

    const gradeAdj: ImageDocument = {
      ...emptyImageDocument(),
      layers: [{ ...emptyImageLayer(), layer: { kind: "adjustment", ops: [{ type: "exposure", ev: 1 }] } }],
    };
    expect(toMaskDocument(gradeAdj)).toBeNull();
    expect(maskBridgeGap(gradeAdj)).toContain("grade ops");

    const overlayBlend: ImageDocument = {
      ...emptyImageDocument(),
      layers: [{ ...emptyImageLayer(), blend: "overlay" }],
    };
    expect(toMaskDocument(overlayBlend)).toBeNull();
    expect(maskBridgeGap(overlayBlend)).toContain('blend "overlay"');
  });

  it("reports no bridge gap for bridgeable documents", () => {
    expect(maskBridgeGap(fromMaskDocument(sampleMaskDocument()))).toBeNull();
  });

  it("empty documents bridge to empty documents", () => {
    const image = fromMaskDocument(emptyMaskDocument());
    expect(image.layers).toHaveLength(1);
    expect(image.layers[0].layer).toEqual({ kind: "pixel", edits: [] });
    const back = toMaskDocument(image);
    expect(back?.layers[0].kind).toBe("mask");
  });
});
