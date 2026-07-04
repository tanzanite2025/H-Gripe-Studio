import { describe, expect, it } from "vitest";

import { clampView, IDENTITY_VIEW, isIdentityView, panView, zoomView, zoomViewAt } from "./view";

describe("viewport view math", () => {
  it("clamps zoom to [1, 8] and keeps the window inside the frame", () => {
    expect(clampView({ zoom: 0.5, panX: -1, panY: 2 })).toEqual(IDENTITY_VIEW);
    expect(clampView({ zoom: 16, panX: 1, panY: 1 })).toEqual({
      zoom: 8,
      panX: 1 - 1 / 8,
      panY: 1 - 1 / 8,
    });
  });

  it("zooms about the window center", () => {
    const zoomed = zoomView(IDENTITY_VIEW, 2);
    // Full frame center (0.5, 0.5) stays centered: window is 1/2 wide at 2x.
    expect(zoomed).toEqual({ zoom: 2, panX: 0.25, panY: 0.25 });
    // Zooming back out returns to the identity view.
    expect(zoomView(zoomed, 0.5)).toEqual(IDENTITY_VIEW);
  });

  it("zooms about an anchor point, keeping it fixed", () => {
    // Anchor at the frame's top-left corner: it stays at the window's corner.
    expect(zoomViewAt(IDENTITY_VIEW, 2, 0, 0)).toEqual({ zoom: 2, panX: 0, panY: 0 });
    // Anchor at (0.25, 0.75) of the window: frame point (0.25, 0.75) is kept
    // under the cursor after the 2x zoom.
    const zoomed = zoomViewAt(IDENTITY_VIEW, 2, 0.25, 0.75);
    expect(zoomed).toEqual({ zoom: 2, panX: 0.125, panY: 0.375 });
    expect(zoomed.panX + 0.25 / zoomed.zoom).toBeCloseTo(0.25);
    expect(zoomed.panY + 0.75 / zoomed.zoom).toBeCloseTo(0.75);
    // Zooming out to 1x clamps back to the identity view.
    expect(zoomViewAt(zoomed, 0.5, 0.9, 0.9)).toEqual(IDENTITY_VIEW);
  });

  it("pans by drag pixels scaled to the visible window", () => {
    const view = { zoom: 2, panX: 0.25, panY: 0.25 };
    // Dragging left by half the stage moves the window right by half its width.
    expect(panView(view, -100, 0, 200, 200)).toEqual({ zoom: 2, panX: 0.5, panY: 0.25 });
    // Pan clamps at the frame edge.
    expect(panView(view, -10000, 10000, 200, 200)).toEqual({ zoom: 2, panX: 0.5, panY: 0 });
    // A zero-sized stage is a no-op, not a division by zero.
    expect(panView(view, 10, 10, 0, 0)).toEqual(view);
  });

  it("identifies the identity view", () => {
    expect(isIdentityView(IDENTITY_VIEW)).toBe(true);
    expect(isIdentityView({ zoom: 2, panX: 0, panY: 0 })).toBe(false);
  });
});
