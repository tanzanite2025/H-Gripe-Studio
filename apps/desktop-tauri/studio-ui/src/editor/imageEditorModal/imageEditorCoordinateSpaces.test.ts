import { describe, expect, it } from "vitest";
import {
  IMAGE_EDITOR_PASTEBOARD_FACTOR,
  imageEditorCoordinateSpaces,
  imageEditorDocumentFrame,
  imageEditorLogicalPasteboard,
} from "./imageEditorCoordinateSpaces";

describe("imageEditorCoordinateSpaces", () => {
  it("defines the 2.5x logical pasteboard centered on the document", () => {
    expect(IMAGE_EDITOR_PASTEBOARD_FACTOR).toBe(2.5);
    expect(imageEditorLogicalPasteboard({ w: 800, h: 800 })).toEqual({
      x: -600,
      y: -600,
      w: 2000,
      h: 2000,
    });
  });

  it("depends only on normalized document dimensions", () => {
    const expected = imageEditorCoordinateSpaces({ w: 800, h: 600 });

    expect(imageEditorCoordinateSpaces({ w: 800.2, h: 600.3 })).toEqual(expected);
    expect(expected).toEqual({
      renderFrame: { x: 0, y: 0, w: 800, h: 600 },
      logicalPasteboard: { x: -600, y: -450, w: 2000, h: 1500 },
    });
  });

  it("keeps the current render frame at document size", () => {
    expect(imageEditorDocumentFrame({ w: 800, h: 800 })).toEqual({
      x: 0,
      y: 0,
      w: 800,
      h: 800,
    });
  });

  it("normalizes empty and non-finite dimensions", () => {
    expect(imageEditorCoordinateSpaces({ w: Number.NaN, h: 0 })).toEqual({
      renderFrame: { x: 0, y: 0, w: 1, h: 1 },
      logicalPasteboard: { x: -0.75, y: -0.75, w: 2.5, h: 2.5 },
    });
  });
});
