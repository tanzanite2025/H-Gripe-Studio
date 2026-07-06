import { describe, expect, it } from "vitest";
import { isLodActive, LOD_MID_ZOOM_THRESHOLD, LOD_ZOOM_THRESHOLD, lodLevel } from "./lod";

describe("isLodActive", () => {
  it("is active (collapsed) below the threshold", () => {
    expect(isLodActive(LOD_ZOOM_THRESHOLD - 0.1)).toBe(true);
    expect(isLodActive(0.2)).toBe(true);
  });

  it("is inactive at or above the threshold", () => {
    expect(isLodActive(LOD_ZOOM_THRESHOLD)).toBe(false);
    expect(isLodActive(1)).toBe(false);
    expect(isLodActive(2)).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isLodActive(0.8, 0.9)).toBe(true);
    expect(isLodActive(0.8, 0.5)).toBe(false);
  });
});

describe("lodLevel", () => {
  it("collapses below the collapse threshold", () => {
    expect(lodLevel(LOD_ZOOM_THRESHOLD - 0.01)).toBe("collapsed");
    expect(lodLevel(0.2)).toBe("collapsed");
  });

  it("is mid between the collapse and mid thresholds", () => {
    expect(lodLevel(LOD_ZOOM_THRESHOLD)).toBe("mid");
    expect(lodLevel(LOD_MID_ZOOM_THRESHOLD - 0.01)).toBe("mid");
  });

  it("is full at or above the mid threshold", () => {
    expect(lodLevel(LOD_MID_ZOOM_THRESHOLD)).toBe("full");
    expect(lodLevel(1)).toBe("full");
    expect(lodLevel(2)).toBe("full");
  });
});
