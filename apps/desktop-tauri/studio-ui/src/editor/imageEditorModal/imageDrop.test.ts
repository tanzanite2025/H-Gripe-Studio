// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  isImageEditorDropOwner,
  isImageEditorStageDrop,
  resolveDroppedImageSources,
} from "./imageDrop";

describe("image editor native file drops", () => {
  it("claims the whole editor but imports only when the stage is hit", () => {
    const editor = document.createElement("div");
    editor.className = "image-editor";
    const toolbar = document.createElement("button");
    const stage = document.createElement("div");
    stage.className = "image-editor-stage";
    const canvas = document.createElement("canvas");
    stage.append(canvas);
    editor.append(toolbar, stage);

    expect(isImageEditorDropOwner(toolbar)).toBe(true);
    expect(isImageEditorStageDrop(toolbar)).toBe(false);
    expect(isImageEditorDropOwner(canvas)).toBe(true);
    expect(isImageEditorStageDrop(canvas)).toBe(true);
  });

  it("filters invalid files and preserves path order across async probes", async () => {
    const pending = new Map<string, (value: { width: number; height: number } | null) => void>();
    const result = resolveDroppedImageSources(
      ["C:/a.png", "C:/skip.exr", "C:/b.webp", "C:/c.tif", "C:/d.heic", "C:/empty.jpg"],
      (path) => new Promise((resolve) => pending.set(path, resolve)),
    );
    pending.get("C:/d.heic")?.({ width: 40, height: 30 });
    pending.get("C:/c.tif")?.({ width: 30, height: 20 });
    pending.get("C:/b.webp")?.({ width: 20, height: 10 });
    pending.get("C:/empty.jpg")?.({ width: 0, height: 10 });
    pending.get("C:/a.png")?.({ width: 80, height: 60 });

    await expect(result).resolves.toEqual([
      { path: "C:/a.png", width: 80, height: 60 },
      { path: "C:/b.webp", width: 20, height: 10 },
      { path: "C:/c.tif", width: 30, height: 20 },
      { path: "C:/d.heic", width: 40, height: 30 },
    ]);
  });
});
