import { describe, expect, it } from "vitest";
import { emptyMaskDocument, type MaskDocument } from "../../types/production";
import { buildViewportOverlayScene } from "./stageScene";

function docWithPath(): MaskDocument {
  const doc = emptyMaskDocument();
  doc.layers[0].ops.push({
    type: "path",
    id: "p1",
    mode: "add",
    tool: "pen",
    closed: true,
    points: [
      { x: 10, y: 10 },
      { x: 80, y: 10 },
      { x: 80, y: 80 },
      { x: 10, y: 80 },
    ],
  });
  return doc;
}

describe("buildViewportOverlayScene", () => {
  it("does not show committed mask geometry in the image workspace", () => {
    const scene = buildViewportOverlayScene({
      workspace: "image",
      frameDims: { w: 100, h: 100 },
      previewing: false,
      doc: docWithPath(),
      editingPath: null,
      lastMarquee: null,
      antsPhase: 0,
      toolId: "move",
      rulerLine: null,
      colorSamples: [],
    });

    expect(scene).toBeNull();
  });

  it("keeps active polygon lasso selections on the edit canvas, not the host overlay", () => {
    const scene = buildViewportOverlayScene({
      workspace: "image",
      frameDims: { w: 100, h: 100 },
      previewing: false,
      doc: emptyMaskDocument(),
      editingPath: null,
      lastMarquee: {
        region: [10, 10, 80, 80],
        ellipse: false,
        polygon: [
          [10, 10],
          [80, 10],
          [70, 80],
          [20, 70],
        ],
      },
      antsPhase: 6,
      toolId: "polygon_lasso",
      rulerLine: null,
      colorSamples: [],
    });

    expect(scene).toBeNull();
  });

  it("keeps committed mask geometry visible in the mask workspace", () => {
    const scene = buildViewportOverlayScene({
      workspace: "mask",
      frameDims: { w: 100, h: 100 },
      previewing: false,
      doc: docWithPath(),
      editingPath: null,
      lastMarquee: null,
      antsPhase: 0,
      toolId: "move",
      rulerLine: null,
      colorSamples: [],
    });

    expect(scene?.items.some((item) => item.kind === "polygon")).toBe(true);
  });
});
