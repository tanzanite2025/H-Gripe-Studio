// @vitest-environment jsdom
// Pins the underlay hook's view-state contract against the mock transport:
// a view change re-renders through the open viewport (no re-open), `dims`
// stays the full-frame size across zoom/pan, and a host opened while zoomed
// (target flip) applies the requested view before its first frame.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openMockViewportCount } from "../bridge/viewport";
import { useViewportUnderlay } from "./useViewportUnderlay";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";

// The resource registry is Tauri-only; stub it so the hook takes the open
// path against the mock viewport transport (vitest runs outside Tauri).
vi.mock("../bridge/files", () => ({
  registerResource: vi.fn(async (path: string) => ({ id: `res-${path}`, path })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useViewportUnderlay view state", () => {
  it("renders the identity frame and settles", async () => {
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay("image_edit", "a.png", 640),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.underlay).toMatch(/^data:image\//);
    expect(result.current.dims).toEqual({ w: 640, h: 640 });
    expect(openMockViewportCount()).toBe(1);
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("keeps dims stable across zoom/pan re-renders", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ view }: { view: ViewportViewState }) =>
        useViewportUnderlay("image_edit", "a.png", 640, view),
      { initialProps: { view: IDENTITY_VIEW } },
    );
    await waitFor(() => expect(result.current.dims).toEqual({ w: 640, h: 640 }));

    await act(async () => {
      rerender({ view: { zoom: 2, panX: 0.25, panY: 0.25 } });
    });
    // The frame is now the half-size view window, but `dims` stays the
    // full-frame size so overlay geometry keeps one image-pixel space.
    await waitFor(() => expect(result.current.dims).toEqual({ w: 640, h: 640 }));
    expect(openMockViewportCount()).toBe(1);
    unmount();
  });

  it("applies a non-identity view when opening a new host", async () => {
    const zoomed: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    const { result, rerender, unmount } = renderHook(
      ({ path }: { path: string }) => useViewportUnderlay("image_edit", path, 640, zoomed),
      { initialProps: { path: "a.png" } },
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    // The first frame is the 1/zoom window; dims scale back to full frame.
    expect(result.current.dims).toEqual({ w: 640, h: 640 });

    // Flipping the target re-opens a host; the zoomed view must follow.
    await act(async () => {
      rerender({ path: "b.png" });
    });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.dims).toEqual({ w: 640, h: 640 });
    expect(openMockViewportCount()).toBe(1);
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("stays null and settles outside the resource registry", async () => {
    const files = await import("../bridge/files");
    vi.mocked(files.registerResource).mockResolvedValueOnce(null);
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay("image_edit", "a.png", 640),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.underlay).toBeNull();
    expect(result.current.dims).toBeNull();
    expect(openMockViewportCount()).toBe(0);
    unmount();
  });
});
