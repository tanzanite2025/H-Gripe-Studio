import { describe, expect, it } from "vitest";

import { canvasDocumentTitle, newCanvasDocumentId } from "./canvasDocument";

describe("canvasDocumentTitle", () => {
  it("uses the path base name across separators", () => {
    expect(canvasDocumentTitle("C:\\proj\\flows\\hero.json", "untitled")).toBe("hero.json");
    expect(canvasDocumentTitle("/home/a/flows/hero.json", "untitled")).toBe("hero.json");
    expect(canvasDocumentTitle("hero.json", "untitled")).toBe("hero.json");
  });

  it("falls back to the untitled label", () => {
    expect(canvasDocumentTitle(null, "untitled")).toBe("untitled");
    expect(canvasDocumentTitle("flows/", "untitled")).toBe("untitled");
  });
});

describe("newCanvasDocumentId", () => {
  it("generates distinct ids", () => {
    expect(newCanvasDocumentId()).not.toBe(newCanvasDocumentId());
  });
});
