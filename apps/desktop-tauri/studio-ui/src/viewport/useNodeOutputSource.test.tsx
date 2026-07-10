// @vitest-environment jsdom
// Pins the preview-only node-output source contract: with a node id the hook
// registers the artifact and yields a `node_output` reference target the
// underlay presents without the resource registry; without one, the plain path
// stays the source.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockViewportClient } from "../bridge/viewport/mock";
import { installMockViewportClient, resetViewportClient } from "../bridge/viewport/testing";
import { useNodeOutputSource } from "./useNodeOutputSource";
import { useViewportUnderlay } from "./useViewportUnderlay";

// The resource registry is Tauri-only; stub it so path sources still resolve
// against the mock viewport transport (vitest runs outside Tauri).
vi.mock("../bridge/files", () => ({
  registerResource: vi.fn(async (path: string) => ({ id: `res-${path}`, path })),
}));

let viewportClient: MockViewportClient;

beforeEach(() => {
  viewportClient = installMockViewportClient();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetViewportClient();
});

describe("useNodeOutputSource", () => {
  it("registers the artifact and yields a node_output target", async () => {
    const { result, unmount } = renderHook(() => {
      const source = useNodeOutputSource("n1", "/tmp/out.png");
      return { source, underlay: useViewportUnderlay("image_edit", source, 640) };
    });
    await waitFor(() =>
      expect(result.current.source).toEqual({ kind: "node_output", nodeId: "n1" }),
    );
    await waitFor(() => expect(result.current.underlay.settled).toBe(true));
    expect(result.current.underlay.underlay).toMatch(/^data:image\//);
    unmount();
    await waitFor(() => expect(viewportClient.openViewportCount()).toBe(0));
  });

  it("stays a path source without a node id, and undefined without a path", () => {
    const { result: noNode } = renderHook(() => useNodeOutputSource(null, "/tmp/out.png"));
    expect(noNode.current).toBe("/tmp/out.png");
    const { result: noPath } = renderHook(() => useNodeOutputSource("n1", null));
    expect(noPath.current).toBeUndefined();
  });
});
