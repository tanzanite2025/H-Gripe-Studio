// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  probeImageDims: vi.fn(),
  registerResource: vi.fn(),
}));

vi.mock("../../bridge/files", () => files);

import { useRegisteredImageResource } from "./useRegisteredImageResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  files.probeImageDims.mockReset();
  files.registerResource.mockReset();
});

afterEach(cleanup);

describe("useRegisteredImageResource", () => {
  it("keeps an empty path empty without registering or probing", () => {
    const { result } = renderHook(() => useRegisteredImageResource(null));

    expect(result.current).toEqual({ resourceId: null, dimensions: null });
    expect(files.registerResource).not.toHaveBeenCalled();
    expect(files.probeImageDims).not.toHaveBeenCalled();
  });

  it("uses dimensions returned by resource registration without probing", async () => {
    files.registerResource.mockResolvedValue({
      id: "resource-a",
      path: "image-a.png",
      width: 640,
      height: 480,
    });

    const { result } = renderHook(() => useRegisteredImageResource("image-a.png"));
    await waitFor(() => {
      expect(result.current).toEqual({
        resourceId: "resource-a",
        dimensions: { w: 640, h: 480 },
      });
    });
    expect(files.probeImageDims).not.toHaveBeenCalled();
  });

  it("probes dimensions when the registered resource does not include them", async () => {
    files.registerResource.mockResolvedValue({ id: "resource-a", path: "image-a.png" });
    files.probeImageDims.mockResolvedValue({ width: 800, height: 600 });

    const { result } = renderHook(() => useRegisteredImageResource("image-a.png"));
    await waitFor(() => {
      expect(result.current).toEqual({
        resourceId: "resource-a",
        dimensions: { w: 800, h: 600 },
      });
    });
    expect(files.registerResource).toHaveBeenCalledWith("image-a.png");
    expect(files.probeImageDims).toHaveBeenCalledWith("image-a.png");
    expect(files.registerResource.mock.invocationCallOrder[0]).toBeLessThan(
      files.probeImageDims.mock.invocationCallOrder[0],
    );
  });

  it("clears a previous path and ignores its cancelled probe after switching", async () => {
    const firstProbe = deferred<{ width: number; height: number } | null>();
    files.registerResource.mockImplementation(async (path: string) => (
      path === "image-a.png"
        ? { id: "resource-a", path }
        : { id: "resource-b", path, width: 320, height: 240 }
    ));
    files.probeImageDims.mockImplementation(() => firstProbe.promise);

    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) => useRegisteredImageResource(path),
      { initialProps: { path: "image-a.png" } },
    );
    await waitFor(() => {
      expect(result.current).toEqual({ resourceId: "resource-a", dimensions: null });
    });

    rerender({ path: "image-b.png" });
    expect(result.current).toEqual({ resourceId: null, dimensions: null });
    await waitFor(() => {
      expect(result.current).toEqual({
        resourceId: "resource-b",
        dimensions: { w: 320, h: 240 },
      });
    });

    await act(async () => {
      firstProbe.resolve({ width: 999, height: 777 });
      await firstProbe.promise;
    });
    expect(result.current).toEqual({
      resourceId: "resource-b",
      dimensions: { w: 320, h: 240 },
    });
  });
});
