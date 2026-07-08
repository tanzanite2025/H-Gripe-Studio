// @vitest-environment jsdom
// Pins the underlay hook's view-state contract against the mock transport:
// a view change re-renders through the open viewport (no re-open), `dims`
// stays the full-frame size across zoom/pan, and a host opened while zoomed
// (target flip) applies the requested view before its first frame.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openMockViewportCount, registerLayeredAsset } from "../bridge/viewport";
import { useViewportUnderlay } from "./useViewportUnderlay";
import { WgpuViewportHost } from "./WgpuViewportHost";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";

// The resource registry is Tauri-only; stub it so the hook takes the open
// path against the mock viewport transport (vitest runs outside Tauri).
vi.mock("../bridge/files", () => ({
  registerResource: vi.fn(async (path: string) => ({ id: `res-${path}`, path })),
}));

function stubRect(el: HTMLElement, width = 640, height = 640) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

    expect(result.current.frameView).toEqual(IDENTITY_VIEW);

    const zoomed: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    await act(async () => {
      rerender({ view: zoomed });
    });
    // The frame is now the half-size view window, but `dims` stays the
    // full-frame size so overlay geometry keeps one image-pixel space;
    // `frameView` reports the window the presented frame was rendered for.
    await waitFor(() => expect(result.current.frameView).toEqual(zoomed));
    expect(result.current.dims).toEqual({ w: 640, h: 640 });
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

  it("renders a target source directly, without the resource registry", async () => {
    await registerLayeredAsset("layered-n1", [
      { layerId: "layer_subject", rgbaPath: "/tmp/subject.png" },
    ]);
    const files = await import("../bridge/files");
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay(
        "image_edit",
        { kind: "image_layer", assetId: "layered-n1", layerId: "layer_subject" },
        640,
      ),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.underlay).toMatch(/^data:image\//);
    expect(result.current.dims).toEqual({ w: 640, h: 640 });
    // Reference targets skip path registration entirely.
    expect(files.registerResource).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("settles null on an unregistered image_layer target", async () => {
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay(
        "image_edit",
        { kind: "image_layer", assetId: "layered-missing", layerId: "layer_x" },
        640,
      ),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.underlay).toBeNull();
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("exposes the open host and re-renders on a presentability flip", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useViewportUnderlay("image_edit", "a.png", 640, IDENTITY_VIEW, null, null, enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.host).not.toBeNull());
    const host = result.current.host as NonNullable<typeof result.current.host>;
    const commands: unknown[] = [];
    const originalCommand = host.command.bind(host);
    vi.spyOn(host, "command").mockImplementation(async (cmd) => {
      commands.push(cmd);
      return originalCommand(cmd);
    });

    // Disabling presentation hides the surface, then re-renders through the
    // same open host so the frame falls back to the PNG transport.
    await act(async () => {
      rerender({ enabled: false });
    });
    await waitFor(() =>
      expect(commands).toContainEqual({ kind: "set_presented", presented: false }),
    );
    expect(openMockViewportCount()).toBe(1);
    expect(result.current.underlay).toMatch(/^data:image\//);
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("places the surface before the first frame so WGPU does not force a second render", async () => {
    // Placement tracking needs layout plumbing jsdom lacks.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });

    // The surface takes the placement; frames rendered after it present.
    let placed = false;
    vi.spyOn(WgpuViewportHost.prototype, "place").mockImplementation(async () => {
      placed = true;
      return { presented: true };
    });
    const renderFrame = vi
      .spyOn(WgpuViewportHost.prototype, "renderFrame")
      .mockImplementation(async () => ({
        data_url: placed ? "" : "data:image/png;base64,",
        width: 640,
        height: 640,
        backend: { requested: "auto" as const, actual: placed ? ("wgpu" as const) : ("cpu" as const) },
        presented: placed,
      }));

    const el = document.createElement("div");
    stubRect(el);
    document.body.appendChild(el);
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay("image_edit", "a.png", 640, IDENTITY_VIEW, null, { current: el }),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    await waitFor(() => expect(result.current.presented).toBe(true));
    expect(result.current.underlay).toBeNull();
    expect(result.current.backend?.actual).toBe("wgpu");
    expect(renderFrame).toHaveBeenCalledTimes(1);
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("re-presents a live view change as a GPU crop when a frame is on the surface", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });
    let placed = false;
    vi.spyOn(WgpuViewportHost.prototype, "place").mockImplementation(async () => {
      placed = true;
      return { presented: true };
    });
    vi.spyOn(WgpuViewportHost.prototype, "renderFrame").mockImplementation(async () => ({
      data_url: placed ? "" : "data:image/png;base64,",
      width: 640,
      height: 640,
      backend: { requested: "auto" as const, actual: placed ? ("wgpu" as const) : ("cpu" as const) },
      presented: placed,
    }));
    const presentView = vi
      .spyOn(WgpuViewportHost.prototype, "presentView")
      .mockResolvedValue(true);

    const el = document.createElement("div");
    stubRect(el);
    document.body.appendChild(el);
    const { result, rerender, unmount } = renderHook(
      ({ liveView }: { liveView: ViewportViewState | null }) =>
        useViewportUnderlay(
          "image_edit", "a.png", 640, IDENTITY_VIEW, null, { current: el },
          true, null, undefined, liveView,
        ),
      { initialProps: { liveView: null as ViewportViewState | null } },
    );
    await waitFor(() => expect(result.current.presented).toBe(true));

    const zoomed: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    await act(async () => {
      rerender({ liveView: zoomed });
    });
    // The fast path presents the crop and moves `frameView` — no render.
    await waitFor(() => expect(presentView).toHaveBeenCalledWith(zoomed));
    await waitFor(() => expect(result.current.frameView).toEqual(zoomed));
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("skips the live-view fast path while no frame is on the surface", async () => {
    const presentView = vi.spyOn(WgpuViewportHost.prototype, "presentView");
    const zoomed: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    const { result, rerender, unmount } = renderHook(
      ({ liveView }: { liveView: ViewportViewState | null }) =>
        useViewportUnderlay(
          "image_edit", "a.png", 640, IDENTITY_VIEW, null, null,
          true, null, undefined, liveView,
        ),
      { initialProps: { liveView: null as ViewportViewState | null } },
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    await act(async () => {
      rerender({ liveView: zoomed });
    });
    // PNG transport: the CSS transform carries the motion; no host call.
    expect(presentView).not.toHaveBeenCalled();
    expect(result.current.frameView).toEqual(IDENTITY_VIEW);
    unmount();
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
