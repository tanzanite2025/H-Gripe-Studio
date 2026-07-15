import { describe, expect, it } from "vitest";

import { IMAGE_MEDIA_EXTS, isSupportedImagePath } from "./mediaFormats";

describe("image media format contract", () => {
  it("accepts every declared image extension case-insensitively", () => {
    for (const extension of IMAGE_MEDIA_EXTS) {
      expect(isSupportedImagePath(`C:/media/source.${extension.toUpperCase()}`)).toBe(true);
    }
  });

  it("rejects undeclared and extensionless paths", () => {
    expect(isSupportedImagePath("C:/media/source.exr")).toBe(false);
    expect(isSupportedImagePath("C:/media/source.qoi")).toBe(false);
    expect(isSupportedImagePath("C:/media/source")).toBe(false);
  });
});
