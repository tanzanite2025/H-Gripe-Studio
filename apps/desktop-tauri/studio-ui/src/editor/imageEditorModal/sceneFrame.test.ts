import { describe, expect, it } from "vitest";
import { emptyImageEditorDocument } from "../../contracts/imageEditorDocument";
import { imageSceneFrame, identitySceneFrame, stableImageSceneFrame } from "./sceneFrame";

describe("imageSceneFrame", () => {
  it("keeps the document rect as the base scene frame", () => {
    const doc = emptyImageEditorDocument();

    expect(imageSceneFrame(doc, { w: 320, h: 200 }, null)).toEqual({
      x: 0,
      y: 0,
      w: 320,
      h: 200,
    });
  });

  it("expands when a placed layer extends outside the document", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "placed",
      name: "Placed",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/placed.png", width: 100, height: 100 },
          placement: [80, 160, 180, 260],
        },
      ],
    });

    expect(imageSceneFrame(doc, { w: 200, h: 200 }, null)).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 260,
    });
  });

  it("preserves negative pasteboard coordinates from transformed layers", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "moved",
      name: "Moved",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/moved.png", width: 120, height: 80 },
          placement: [20, 30, 140, 110],
        },
        { type: "transform", dx: -60, dy: -50, scale: 1, rotate: 0 },
      ],
    });

    expect(imageSceneFrame(doc, { w: 200, h: 160 }, null)).toEqual({
      x: -40,
      y: -20,
      w: 240,
      h: 180,
    });
  });

  it("can expand to the stage aspect without changing the document model", () => {
    const doc = emptyImageEditorDocument();

    expect(imageSceneFrame(doc, { w: 100, h: 100 }, { w: 200, h: 100 })).toEqual({
      x: -50,
      y: 0,
      w: 200,
      h: 100,
    });
  });
});

describe("identitySceneFrame", () => {
  it("normalizes dimensions to a non-empty origin-zero frame", () => {
    expect(identitySceneFrame({ w: 0, h: 10.4 })).toEqual({ x: 0, y: 0, w: 1, h: 10 });
  });

  it("falls back from non-finite dimensions", () => {
    expect(identitySceneFrame({ w: Number.NaN, h: Number.POSITIVE_INFINITY })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe("stableImageSceneFrame", () => {
  it("adds a modest pasteboard guard band around the document", () => {
    const doc = emptyImageEditorDocument();

    expect(stableImageSceneFrame(doc, { w: 200, h: 200 }, null)).toEqual({
      x: -48,
      y: -48,
      w: 296,
      h: 296,
    });
  });

  it("keeps the previous frame when content moves inside the guard band", () => {
    const doc = emptyImageEditorDocument();
    const previous = stableImageSceneFrame(doc, { w: 200, h: 200 }, null);
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "inside",
      name: "Inside",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/inside.png", width: 50, height: 50 },
          placement: [20, 20, 70, 70],
        },
      ],
    });

    expect(stableImageSceneFrame(doc, { w: 200, h: 200 }, null, previous)).toEqual(previous);
  });

  it("keeps the interaction frame fixed when content escapes the guard band", () => {
    const doc = emptyImageEditorDocument();
    const previous = stableImageSceneFrame(doc, { w: 200, h: 200 }, null);
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "outside",
      name: "Outside",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/outside.png", width: 30, height: 30 },
          placement: [210, 10, 240, 40],
        },
      ],
    });

    expect(stableImageSceneFrame(doc, { w: 200, h: 200 }, null, previous)).toEqual(previous);
  });

  it("ignores malformed layer placement instead of poisoning the frame", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "bad-placement",
      name: "Bad placement",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/bad.png", width: 100, height: 100 },
          placement: [Number.NaN, 0, Number.POSITIVE_INFINITY, 100],
        },
      ],
    });

    expect(stableImageSceneFrame(doc, { w: 200, h: 200 }, null)).toEqual({
      x: -48,
      y: -48,
      w: 296,
      h: 296,
    });
  });

  it("ignores malformed previous frames instead of carrying them forward", () => {
    const doc = emptyImageEditorDocument();

    expect(stableImageSceneFrame(doc, { w: 200, h: 200 }, null, {
      x: Number.NaN,
      y: 0,
      w: Number.POSITIVE_INFINITY,
      h: 200,
    })).toEqual({
      x: -48,
      y: -48,
      w: 296,
      h: 296,
    });
  });

  it("ignores pathological far-away content so the interaction frame cannot move", () => {
    const doc = emptyImageEditorDocument();
    doc.layers.push({
      ...emptyImageEditorDocument().layers[0],
      id: "far",
      name: "Far",
      ops: [
        {
          type: "source_image",
          source: { path: "C:/imgs/far.png", width: 32, height: 32 },
          placement: [100_000, 100_000, 100_032, 100_032],
        },
      ],
    });

    const frame = stableImageSceneFrame(doc, { w: 200, h: 200 }, null);
    expect(frame).toEqual({ x: -48, y: -48, w: 296, h: 296 });
  });
});
