import { describe, expect, it } from "vitest";
import {
  emptyImageEditorDocument,
  emptyPixelLayer,
  type ImageEditorDocument,
  type ImageEditorLayer,
} from "../../contracts/imageEditorDocument";
import { clampSelectedLayerMoveDelta } from "./layerMoveBounds";

function layer(
  id: string,
  placement: [number, number, number, number],
  options: { linked?: boolean; locked?: boolean; transform?: { dx?: number; dy?: number; scale?: number; rotate?: number } } = {},
): ImageEditorLayer {
  return {
    ...emptyPixelLayer(id),
    id,
    ...(options.linked ? { linked: true } : null),
    ...(options.locked ? { locked: true } : null),
    ops: [
      { type: "source_image", source: { path: `${id}.png`, width: 100, height: 100 }, placement },
      ...(options.transform ? [{ type: "transform" as const, ...options.transform }] : []),
    ],
  };
}

function documentWith(layers: ImageEditorLayer[]): ImageEditorDocument {
  return { ...emptyImageEditorDocument(), layers, active: 0 };
}

const dims = { w: 800, h: 800 };
const pasteboard = { x: -600, y: -600, w: 2000, h: 2000 };

describe("clampSelectedLayerMoveDelta", () => {
  it("clamps an ordinary placed layer to the logical pasteboard", () => {
    const document = documentWith([layer("selected", [0, 0, 800, 800])]);

    expect(clampSelectedLayerMoveDelta(document, dims, pasteboard, [1000, -1000])).toEqual([600, -600]);
  });

  it("uses the rotated committed AABB", () => {
    const document = documentWith([layer(
      "selected",
      [300, 350, 500, 450],
      { transform: { rotate: 90 } },
    )]);

    expect(clampSelectedLayerMoveDelta(
      document,
      dims,
      { x: 0, y: 0, w: 800, h: 800 },
      [-500, 500],
    )).toEqual([-350, 300]);
  });

  it("constrains the union of linked movable layers", () => {
    const linked = documentWith([
      layer("selected", [0, 0, 100, 100], { linked: true }),
      layer("peer", [900, 0, 1000, 100], { linked: true }),
      layer("locked-peer", [1000, 0, 1100, 100], { linked: true, locked: true }),
    ]);

    expect(clampSelectedLayerMoveDelta(
      linked,
      { w: 1000, h: 1000 },
      { x: 0, y: 0, w: 1000, h: 1000 },
      [100, 0],
    )).toEqual([0, 0]);
  });

  it("keeps an oversized layer covering the pasteboard while it moves", () => {
    const document = documentWith([layer("selected", [-50, 0, 1050, 100])]);
    const board = { x: 0, y: 0, w: 1000, h: 1000 };

    expect(clampSelectedLayerMoveDelta(document, { w: 1000, h: 1000 }, board, [100, 0])).toEqual([50, 0]);
    expect(clampSelectedLayerMoveDelta(document, { w: 1000, h: 1000 }, board, [-100, 0])).toEqual([-50, 0]);
  });

  it("rejects locked or non-source active layers", () => {
    const locked = documentWith([layer("selected", [0, 0, 100, 100], { locked: true })]);
    expect(clampSelectedLayerMoveDelta(locked, dims, pasteboard, [10, 10])).toBeNull();
    expect(clampSelectedLayerMoveDelta(emptyImageEditorDocument(), dims, pasteboard, [10, 10])).toBeNull();
  });
});
