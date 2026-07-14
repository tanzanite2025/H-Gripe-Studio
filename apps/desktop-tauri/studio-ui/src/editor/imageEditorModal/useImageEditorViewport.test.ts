import { describe, expect, it } from "vitest";
import { emptyImageEditorDocument } from "../../contracts/imageEditorDocument";
import { imageCompositeTarget } from "../imageCompositeTarget";
import { imageEditorCoordinateSpaces } from "./imageEditorCoordinateSpaces";

describe("image editor viewport target coordinates", () => {
  it("uses the logical pasteboard as the retained composite scene frame", () => {
    const doc = emptyImageEditorDocument();
    const { logicalPasteboard } = imageEditorCoordinateSpaces({ w: 800, h: 800 });
    const target = imageCompositeTarget("resource-a", doc, { w: 800, h: 800 }, logicalPasteboard);

    expect(logicalPasteboard).toEqual({ x: -600, y: -600, w: 2000, h: 2000 });
    expect(target).toMatchObject({
      kind: "image_composite",
      documentWidth: 800,
      documentHeight: 800,
      frameX: logicalPasteboard.x,
      frameY: logicalPasteboard.y,
      frameWidth: logicalPasteboard.w,
      frameHeight: logicalPasteboard.h,
    });
  });
});
