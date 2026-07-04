// @vitest-environment jsdom
// Pins the video preview hook's coalescing contract against the mock
// transport: one lazily-opened viewport per hook, a burst of scrub positions
// renders only the newest (latest-wins, depth-one queue), no-op grade/view
// sets are skipped, null clears the frame, and unmount closes the host.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as viewportBridge from "../bridge/viewport";
import { openMockViewportCount } from "../bridge/viewport";
import { useVideoPreview } from "./useVideoPreview";

// The resource registry is Tauri-only; stub it so the hook takes the render
// path against the mock viewport transport (vitest runs outside Tauri).
vi.mock("../bridge/files", () => ({
  registerResource: vi.fn(async (path: string) => ({ id: `res-${path}`, path })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const still = (path: string) =>
  ({ kind: "image", path, clipId: `clip-${path}` }) as never;

describe("useVideoPreview coalescing", () => {
  it("opens one viewport lazily and renders the requested frame", async () => {
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    // Never at mount: the viewport opens on the first frame request.
    expect(openMockViewportCount()).toBe(0);

    act(() => {
      result.current.showFrame({ target: still("a.png"), gradeDoc: null });
    });
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(result.current.state.frame).toMatch(/^data:image\//);
    expect(result.current.state.backend?.actual).toBe("cpu");
    expect(openMockViewportCount()).toBe(1);

    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("passes video_clip reference targets through without the resource registry", async () => {
    await viewportBridge.registerTimeline("tl-1", [
      { clipId: "clip_a", kind: "video", path: "/tmp/a.mp4", startSec: 0, durationSec: 2 },
    ]);
    const files = await import("../bridge/files");
    vi.mocked(files.registerResource).mockClear();
    const setTarget = vi.spyOn(viewportBridge, "setViewportTarget");
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    act(() => {
      result.current.showFrame({
        target: { kind: "video_clip", timelineId: "tl-1", clipId: "clip_a", timeSec: 0.5 },
        gradeDoc: null,
      });
    });
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(result.current.state.frame).toMatch(/^data:image\//);
    expect(files.registerResource).not.toHaveBeenCalled();
    expect(setTarget).toHaveBeenLastCalledWith(expect.any(String), {
      kind: "video_clip",
      timelineId: "tl-1",
      clipId: "clip_a",
      timeSec: 0.5,
    });
    unmount();
    await waitFor(() => expect(openMockViewportCount()).toBe(0));
  });

  it("collapses a burst of requests to the newest (latest-wins)", async () => {
    const setTarget = vi.spyOn(viewportBridge, "setViewportTarget");
    const { result, unmount } = renderHook(() => useVideoPreview(320));

    // One in-flight render plus a depth-one queue: the middle requests of a
    // burst are replaced before they ever reach the transport.
    act(() => {
      for (const p of ["t0.png", "t1.png", "t2.png", "t3.png"]) {
        result.current.showFrame({ target: still(p), gradeDoc: null });
      }
    });
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    const targets = setTarget.mock.calls.map(
      ([, target]) => (target as { resourceId: string }).resourceId,
    );
    expect(targets[targets.length - 1]).toBe("res-t3.png");
    expect(targets).not.toContain("res-t1.png");
    expect(targets).not.toContain("res-t2.png");
    unmount();
  });

  it("skips no-op grade and view sets across renders", async () => {
    const setGrade = vi.spyOn(viewportBridge, "setViewportGrade");
    const setView = vi.spyOn(viewportBridge, "setViewportView");
    const { result, unmount } = renderHook(() => useVideoPreview(320));

    const request = {
      target: still("a.png"),
      gradeDoc: `{"layers":[]}`,
      view: { zoom: 2, panX: 0.25, panY: 0.25 },
    };
    act(() => result.current.showFrame(request));
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(setGrade).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenCalledTimes(1);

    // Same doc and view again: neither command is re-sent.
    act(() => result.current.showFrame({ ...request }));
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(setGrade).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("clears the frame on a null request (gap under the playhead)", async () => {
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    act(() => result.current.showFrame({ target: still("a.png"), gradeDoc: null }));
    await waitFor(() => expect(result.current.state.frame).not.toBeNull());

    act(() => result.current.showFrame(null));
    await waitFor(() => expect(result.current.state.frame).toBeNull());
    expect(result.current.state.pending).toBe(false);
    expect(result.current.state.error).toBeNull();
    unmount();
  });

  it("hides the surface on a gap and re-shows it before the next frame", async () => {
    const setPresented = vi.spyOn(viewportBridge, "setViewportPresented");
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    act(() => result.current.showFrame({ target: still("a.png"), gradeDoc: null }));
    await waitFor(() => expect(result.current.state.frame).not.toBeNull());
    expect(setPresented).not.toHaveBeenCalled();

    act(() => result.current.showFrame(null));
    await waitFor(() => expect(result.current.state.frame).toBeNull());
    expect(setPresented).toHaveBeenLastCalledWith(expect.any(String), false);

    act(() => result.current.showFrame({ target: still("b.png"), gradeDoc: null }));
    await waitFor(() => expect(result.current.state.frame).not.toBeNull());
    expect(setPresented).toHaveBeenLastCalledWith(expect.any(String), true);
    unmount();
  });

  it("reports a natively presented frame without a frame url", async () => {
    vi.spyOn(viewportBridge, "renderViewportFrame").mockResolvedValue({
      data_url: "",
      width: 640,
      height: 360,
      backend: { requested: "auto", actual: "wgpu" },
      presented: true,
    });
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    act(() => result.current.showFrame({ target: still("a.png"), gradeDoc: null }));
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(result.current.state.presented).toBe(true);
    expect(result.current.state.frame).toBeNull();
    expect(result.current.state.backend?.actual).toBe("wgpu");
    unmount();
  });

  it("stays empty and settles outside the resource registry", async () => {
    const files = await import("../bridge/files");
    vi.mocked(files.registerResource).mockResolvedValueOnce(null as never);
    const { result, unmount } = renderHook(() => useVideoPreview(320));
    act(() => result.current.showFrame({ target: still("a.png"), gradeDoc: null }));
    await waitFor(() => expect(result.current.state.pending).toBe(false));
    expect(result.current.state.frame).toBeNull();
    expect(result.current.state.error).toBeNull();
    unmount();
  });
});
