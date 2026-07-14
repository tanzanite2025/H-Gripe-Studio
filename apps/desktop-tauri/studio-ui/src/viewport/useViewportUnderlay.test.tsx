// @vitest-environment jsdom
// Pins the underlay hook's view-state contract against the mock transport:
// a view change re-renders through the open viewport (no re-open), `dims`
// stays the full-frame size across zoom/pan, and a host opened while zoomed
// (target flip) applies the requested view before its first frame.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerLayeredAsset } from "../bridge/viewport";
import type { MockViewportClient } from "../bridge/viewport/mock";
import type {
  ImageLayerScenePresentation,
  ViewportFrame,
  ViewportOverlayScene,
  ViewportTarget,
} from "../bridge/viewport/contracts";
import { installMockViewportClient, resetViewportClient } from "../bridge/viewport/testing";
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

function compositeTarget(documentKey: string, width = 640, height = 640): ViewportTarget {
  return {
    kind: "image_composite",
    resourceId: "res-composite-image",
    document: { documentKey },
    documentKey,
    documentWidth: width,
    documentHeight: height,
  };
}

function layerPresentation(
  sequence: number,
  moveDraft: { dx: number; dy: number } | null,
): ImageLayerScenePresentation {
  return {
    selectedLayerId: "layer-1",
    transactionId: "move-1",
    baseDocumentKey: "doc-a",
    sequence,
    moveDraft,
  };
}

let viewportClient: MockViewportClient;

beforeEach(() => {
  viewportClient = installMockViewportClient();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetViewportClient();
});

describe("useViewportUnderlay view state", () => {
  it("renders the identity frame and settles", async () => {
    const { result, unmount } = renderHook(() =>
      useViewportUnderlay("image_edit", "a.png", 640),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.underlay).toMatch(/^data:image\//);
    expect(result.current.dims).toEqual({ w: 640, h: 640 });
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
    expect(viewportClient.openViewportCount()).toBe(1);
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
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
  });

  it("commits image scenes without retargeting or reopening the viewport", async () => {
    const commands: unknown[] = [];
    const originalOpen = WgpuViewportHost.open.bind(WgpuViewportHost);
    let renderCount = 0;
    let releaseSecondFrame!: () => void;
    const secondFrameGate = new Promise<void>((resolve) => {
      releaseSecondFrame = resolve;
    });
    const open = vi.spyOn(WgpuViewportHost, "open").mockImplementation(async (kind) => {
      const host = await originalOpen(kind);
      const originalRenderFrame = host.renderFrame.bind(host);
      vi.spyOn(host, "renderFrame").mockImplementation(async () => {
        renderCount += 1;
        if (renderCount === 2) {
          await secondFrameGate;
        }
        return originalRenderFrame();
      });
      return host;
    });
    const originalCommand = WgpuViewportHost.prototype.command;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      cmd,
    ) {
      commands.push(cmd);
      return originalCommand.call(this, cmd);
    });

    const { result, rerender, unmount } = renderHook(
      ({ documentKey }: { documentKey: string }) =>
        useViewportUnderlay("image_edit", compositeTarget(documentKey), 640),
      { initialProps: { documentKey: "doc-a" } },
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    const previousUnderlay = result.current.underlay;
    expect(previousUnderlay).toMatch(/^data:image\//);
    expect(commands.filter((command) => (
      typeof command === "object"
      && command !== null
      && "kind" in command
      && command.kind === "set_image_scene"
    ))).toHaveLength(0);
    expect(viewportClient.openViewportCount()).toBe(1);

    await act(async () => {
      rerender({ documentKey: "doc-b" });
    });
    expect(result.current.underlay).toBe(previousUnderlay);
    expect(result.current.targetSettled).toBe(true);
    expect(result.current.sceneSettled).toBe(false);
    releaseSecondFrame();
    await waitFor(() => expect(result.current.sceneSettled).toBe(true));
    expect(result.current.underlay).toMatch(/^data:image\//);
    expect(previousUnderlay).toMatch(/^data:image\//);
    expect(commands).toContainEqual({
      kind: "set_image_scene",
      scene: expect.objectContaining({ documentKey: "doc-b" }),
    });
    expect(commands.filter((command) => (
      typeof command === "object"
      && command !== null
      && "kind" in command
      && command.kind === "set_target"
    ))).toHaveLength(1);
    expect(commands.filter((command) => (
      typeof command === "object"
      && command !== null
      && "kind" in command
      && command.kind === "set_image_scene"
    ))).toHaveLength(1);
    expect(result.current.renderedSceneKey).toContain("doc-b");
    expect(open).toHaveBeenCalledTimes(1);
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
  });

  it("never exposes an initial composite superseded before its first frame settles", async () => {
    const originalOpen = WgpuViewportHost.open.bind(WgpuViewportHost);
    let openCount = 0;
    let firstFrameStarted!: () => void;
    let releaseFirstFrame!: () => void;
    const firstFrameStartedPromise = new Promise<void>((resolve) => {
      firstFrameStarted = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    vi.spyOn(WgpuViewportHost, "open").mockImplementation(async (kind) => {
      const host = await originalOpen(kind);
      openCount += 1;
      if (openCount === 1) {
        const originalRenderFrame = host.renderFrame.bind(host);
        vi.spyOn(host, "renderFrame").mockImplementation(async () => {
          const frame = originalRenderFrame();
          firstFrameStarted();
          await firstFrameGate;
          return frame;
        });
      }
      return host;
    });

    const { result, rerender, unmount } = renderHook(
      ({ documentKey }: { documentKey: string }) =>
        useViewportUnderlay("image_edit", compositeTarget(documentKey), 640),
      { initialProps: { documentKey: "doc-a" } },
    );
    await firstFrameStartedPromise;

    await act(async () => {
      rerender({ documentKey: "doc-b" });
    });
    expect(result.current.renderedSceneKey ?? "").not.toContain("doc-a");
    if (!result.current.targetSettled) {
      expect(result.current.underlay).toBeNull();
      expect(result.current.presented).toBe(false);
    }

    releaseFirstFrame();
    await waitFor(() => expect(result.current.sceneSettled).toBe(true));
    expect(result.current.renderedSceneKey).toContain("doc-b");
    expect(result.current.renderedSceneKey).not.toContain("doc-a");
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(1));
    expect(openCount).toBe(1);

    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
    expect(viewportClient.openViewportCount()).toBe(1);
    expect(result.current.underlay).toMatch(/^data:image\//);
    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
        selectedLayerFrame: null,
        documentKey: null,
        transactionId: null,
        sequence: null,
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
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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
      selectedLayerFrame: null,
      documentKey: null,
      transactionId: null,
      sequence: null,
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
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
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

  it("resizes an image-composite host in place", async () => {
    const open = vi.spyOn(WgpuViewportHost, "open");
    const commands: unknown[] = [];
    const originalCommand = WgpuViewportHost.prototype.command;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      command,
    ) {
      commands.push(command);
      return originalCommand.call(this, command);
    });
    const { result, rerender, unmount } = renderHook(
      ({ size }: { size: number }) =>
        useViewportUnderlay("image_edit", compositeTarget("doc-a"), size),
      { initialProps: { size: 640 } },
    );
    await waitFor(() => expect(result.current.targetSettled).toBe(true));

    await act(async () => {
      rerender({ size: 960 });
    });
    await waitFor(() => {
      expect(commands).toContainEqual({ kind: "resize", width: 960, height: 960 });
      expect(result.current.targetSettled).toBe(true);
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
  });

  it("applies target, resize, view and scene while an older render is in flight", async () => {
    const originalOpen = WgpuViewportHost.open.bind(WgpuViewportHost);
    const commands: unknown[] = [];
    let firstFrameStarted!: () => void;
    let releaseFirstFrame!: () => void;
    const started = new Promise<void>((resolve) => {
      firstFrameStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    const open = vi.spyOn(WgpuViewportHost, "open").mockImplementation(async (kind) => {
      const host = await originalOpen(kind);
      const originalRenderFrame = host.renderFrame.bind(host);
      let renderCount = 0;
      vi.spyOn(host, "renderFrame").mockImplementation(async () => {
        renderCount += 1;
        const frame = originalRenderFrame();
        if (renderCount === 1) {
          firstFrameStarted();
          await gate;
        }
        return frame;
      });
      return host;
    });
    const originalCommand = WgpuViewportHost.prototype.command;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      command,
    ) {
      commands.push(command);
      return originalCommand.call(this, command);
    });
    const zoomed: ViewportViewState = { zoom: 2, panX: 0.2, panY: 0.15 };
    const scene: ViewportOverlayScene = { phase: 3, items: [] };
    const { result, rerender, unmount } = renderHook(
      ({ documentKey, size, view, scene }: {
        documentKey: string;
        size: number;
        view: ViewportViewState;
        scene: ViewportOverlayScene | null;
      }) => useViewportUnderlay(
        "image_edit",
        compositeTarget(documentKey),
        size,
        view,
        null,
        null,
        true,
        scene,
      ),
      {
        initialProps: {
          documentKey: "doc-a",
          size: 640,
          view: IDENTITY_VIEW,
          scene: null as ViewportOverlayScene | null,
        },
      },
    );
    await started;

    await act(async () => {
      rerender({ documentKey: "doc-b", size: 960, view: zoomed, scene });
    });
    await waitFor(() => {
      expect(commands).toContainEqual({ kind: "resize", width: 960, height: 960 });
      expect(commands).toContainEqual({
        kind: "set_image_scene",
        scene: expect.objectContaining({ documentKey: "doc-b" }),
      });
      expect(commands).toContainEqual({ kind: "set_view", ...zoomed });
      expect(commands).toContainEqual({ kind: "set_overlay_scene", scene });
    });
    expect(result.current.targetSettled).toBe(false);

    await act(async () => {
      releaseFirstFrame();
      await gate;
    });
    await waitFor(() => expect(result.current.targetSettled).toBe(true));
    expect(result.current.renderedSceneKey).toContain("doc-b");
    expect(result.current.frameView).toEqual(zoomed);
    expect(open).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("publishes image pixels and selected-layer metadata from one unsuperseded snapshot", async () => {
    const originalOpen = WgpuViewportHost.open.bind(WgpuViewportHost);
    const commands: Parameters<WgpuViewportHost["command"]>[0][] = [];
    let appliedPresentation: ImageLayerScenePresentation | null = null;
    let secondFrameStarted!: () => void;
    let thirdFrameStarted!: () => void;
    let releaseSecondFrame!: () => void;
    let releaseThirdFrame!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondFrameStarted = resolve;
    });
    const thirdStarted = new Promise<void>((resolve) => {
      thirdFrameStarted = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecondFrame = resolve;
    });
    const thirdGate = new Promise<void>((resolve) => {
      releaseThirdFrame = resolve;
    });
    const open = vi.spyOn(WgpuViewportHost, "open").mockImplementation(async (kind) => {
      const host = await originalOpen(kind);
      const originalCommand = host.command.bind(host);
      vi.spyOn(host, "command").mockImplementation(async (command) => {
        await originalCommand(command);
        commands.push(command);
        if (command.kind === "present_image_layer_scene") {
          appliedPresentation = command.presentation;
        }
      });
      const originalRenderFrame = host.renderFrame.bind(host);
      let renderCount = 0;
      vi.spyOn(host, "renderFrame").mockImplementation(async (): Promise<ViewportFrame> => {
        renderCount += 1;
        const presentation = appliedPresentation;
        const frame = await originalRenderFrame();
        if (renderCount === 2) {
          secondFrameStarted();
          await secondGate;
        } else if (renderCount === 3) {
          thirdFrameStarted();
          await thirdGate;
        }
        const offset = (presentation?.sequence ?? 0) * 10;
        return {
          ...frame,
          documentKey: presentation?.baseDocumentKey ?? null,
          transactionId: presentation?.transactionId ?? null,
          sequence: presentation?.sequence ?? null,
          selectedLayerFrame: presentation
            ? {
                owner: "selected-layer-frame",
                shape: "axis-aligned-rect",
                layerId: presentation.selectedLayerId,
                rect: [offset, offset, offset + 100, offset + 80],
                sourceRect: [0, 0, 100, 80],
                source: "asset-frame",
              }
            : null,
        };
      });
      return host;
    });

    const { result, rerender, unmount } = renderHook(
      ({ presentation }: { presentation: ImageLayerScenePresentation }) =>
        useViewportUnderlay(
          "image_edit",
          compositeTarget("doc-a"),
          640,
          IDENTITY_VIEW,
          null,
          null,
          true,
          null,
          undefined,
          null,
          presentation,
        ),
      { initialProps: { presentation: layerPresentation(0, null) } },
    );
    await waitFor(() => expect(result.current.presentedImageLayerScene?.sequence).toBe(0));
    expect(result.current.selectedLayerFrame?.rect).toEqual([0, 0, 100, 80]);

    await act(async () => {
      rerender({ presentation: layerPresentation(1, { dx: 10, dy: 10 }) });
    });
    await secondStarted;
    expect(result.current.presentedImageLayerScene?.sequence).toBe(0);
    expect(result.current.selectedLayerFrame?.rect).toEqual([0, 0, 100, 80]);

    await act(async () => {
      rerender({ presentation: layerPresentation(2, { dx: 20, dy: 20 }) });
    });
    await waitFor(() => {
      expect(commands).toContainEqual({
        kind: "present_image_layer_scene",
        presentation: layerPresentation(2, { dx: 20, dy: 20 }),
      });
    });
    await act(async () => {
      releaseSecondFrame();
      await secondGate;
    });
    await thirdStarted;
    // Sequence 1 completed after sequence 2 was requested, so neither its
    // pixels nor its frame metadata may replace the last complete snapshot.
    expect(result.current.presentedImageLayerScene?.sequence).toBe(0);
    expect(result.current.selectedLayerFrame?.rect).toEqual([0, 0, 100, 80]);

    await act(async () => {
      releaseThirdFrame();
      await thirdGate;
    });
    await waitFor(() => expect(result.current.presentedImageLayerScene).toEqual({
      documentKey: "doc-a",
      transactionId: "move-1",
      sequence: 2,
    }));
    expect(result.current.selectedLayerFrame?.rect).toEqual([20, 20, 120, 100]);
    expect(commands.filter((command) => command.kind === "set_target")).toHaveLength(1);
    expect(commands.filter((command) => command.kind === "resize")).toHaveLength(1);
    expect(commands.filter((command) => command.kind === "set_image_scene")).toHaveLength(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
  });

  it("records image layer presentation as sent only after the command succeeds", async () => {
    const originalCommand = WgpuViewportHost.prototype.command;
    let moveAttempts = 0;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      command,
    ) {
      if (command.kind === "present_image_layer_scene" && command.presentation.sequence === 1) {
        moveAttempts += 1;
        if (moveAttempts === 1) throw new Error("injected image layer presentation failure");
      }
      return originalCommand.call(this, command);
    });
    const scene: ViewportOverlayScene = { phase: 1, items: [] };
    const { result, rerender, unmount } = renderHook(
      ({ presentation, scene }: {
        presentation: ImageLayerScenePresentation;
        scene: ViewportOverlayScene | null;
      }) => useViewportUnderlay(
        "image_edit",
        compositeTarget("doc-a"),
        640,
        IDENTITY_VIEW,
        null,
        null,
        true,
        scene,
        undefined,
        null,
        presentation,
      ),
      {
        initialProps: {
          presentation: layerPresentation(0, null),
          scene: null as ViewportOverlayScene | null,
        },
      },
    );
    await waitFor(() => expect(result.current.presentedImageLayerScene?.sequence).toBe(0));

    await act(async () => {
      rerender({
        presentation: layerPresentation(1, { dx: 10, dy: 5 }),
        scene: null,
      });
    });
    await waitFor(() => expect(moveAttempts).toBe(1));
    await waitFor(() => expect(result.current.targetSettled).toBe(true));
    expect(result.current.presentedImageLayerScene?.sequence).toBe(0);

    await act(async () => {
      rerender({
        presentation: layerPresentation(1, { dx: 10, dy: 5 }),
        scene,
      });
    });
    await waitFor(() => expect(moveAttempts).toBe(2));
    await waitFor(() => expect(result.current.presentedImageLayerScene?.sequence).toBe(1));
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
  });

  it("establishes a transaction baseline before a coalesced move preview", async () => {
    const presentations: ImageLayerScenePresentation[] = [];
    const originalCommand = WgpuViewportHost.prototype.command;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      command,
    ) {
      if (command.kind === "present_image_layer_scene") {
        presentations.push(command.presentation);
      }
      return originalCommand.call(this, command);
    });
    const { result, unmount } = renderHook(() => useViewportUnderlay(
      "image_edit",
      compositeTarget("doc-a"),
      640,
      IDENTITY_VIEW,
      null,
      null,
      true,
      null,
      undefined,
      null,
      layerPresentation(2, { dx: 20, dy: 10 }),
    ));

    await waitFor(() => expect(result.current.presentedImageLayerScene?.sequence).toBe(2));
    expect(presentations).toEqual([
      layerPresentation(0, null),
      layerPresentation(2, { dx: 20, dy: 10 }),
    ]);
    expect(viewportClient.openViewportCount()).toBe(1);
    unmount();
  });

  it("records a setter as sent only after the command succeeds", async () => {
    const originalCommand = WgpuViewportHost.prototype.command;
    let viewAttempts = 0;
    vi.spyOn(WgpuViewportHost.prototype, "command").mockImplementation(async function (
      this: WgpuViewportHost,
      command,
    ) {
      if (command.kind === "set_view") {
        viewAttempts += 1;
        if (viewAttempts === 1) throw new Error("injected set_view failure");
      }
      return originalCommand.call(this, command);
    });
    const zoomed: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    const scene: ViewportOverlayScene = { phase: 1, items: [] };
    const { result, rerender, unmount } = renderHook(
      ({ view, scene }: { view: ViewportViewState; scene: ViewportOverlayScene | null }) =>
        useViewportUnderlay(
          "image_edit",
          compositeTarget("doc-a"),
          640,
          view,
          null,
          null,
          true,
          scene,
        ),
      { initialProps: { view: IDENTITY_VIEW, scene: null as ViewportOverlayScene | null } },
    );
    await waitFor(() => expect(result.current.targetSettled).toBe(true));

    await act(async () => {
      rerender({ view: zoomed, scene: null });
    });
    await waitFor(() => expect(viewAttempts).toBe(1));
    await waitFor(() => expect(result.current.targetSettled).toBe(true));
    expect(result.current.frameView).toEqual(IDENTITY_VIEW);

    await act(async () => {
      rerender({ view: zoomed, scene });
    });
    await waitFor(() => expect(viewAttempts).toBe(2));
    await waitFor(() => expect(result.current.targetSettled).toBe(true));
    expect(result.current.frameView).toEqual(zoomed);
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
    expect(viewportClient.openViewportCount()).toBe(0);
    unmount();
  });
});
