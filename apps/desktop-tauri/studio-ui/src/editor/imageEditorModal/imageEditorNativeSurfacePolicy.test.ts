import { describe, expect, it } from "vitest";
import { canPresentImageEditorNativeSurfaceWithScopedHole } from "./imageEditorNativeSurfacePolicy";

const base = {
  overlayOnly: false,
  view: { zoom: 1, panX: 0, panY: 0 },
  cropRegion: null,
  gradePreview: null,
  entering: false,
  closing: false,
};

describe("image editor native surface policy", () => {
  it("keeps native presentation off until the editor owns a scoped surface hole", () => {
    expect(canPresentImageEditorNativeSurfaceWithScopedHole(base)).toBe(false);
  });

  it("keeps unsupported presentation states off as well", () => {
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, overlayOnly: true })).toBe(false);
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, view: { ...base.view, rotate: 15 } })).toBe(false);
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, cropRegion: [0, 0, 10, 10] })).toBe(false);
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, gradePreview: { layers: [] } })).toBe(false);
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, entering: true })).toBe(false);
    expect(canPresentImageEditorNativeSurfaceWithScopedHole({ ...base, closing: true })).toBe(false);
  });
});
