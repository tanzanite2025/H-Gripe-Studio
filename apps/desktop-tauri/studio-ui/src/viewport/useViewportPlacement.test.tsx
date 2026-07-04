// @vitest-environment jsdom
// Pins the placement hook's protocol against the mock transport (surface swap
// Phase S1): a mounted element reports its rect as `set_placement`, layout
// changes re-send only when the rect actually changed, and unmount hides the
// surface with `set_presented: false` instead of destroying it.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { measurePlacement, useViewportPlacement } from "./useViewportPlacement";
import { WgpuViewportHost } from "./WgpuViewportHost";

// jsdom has neither ResizeObserver nor rAF-per-frame semantics; stub both so
// the hook's observe/throttle wiring runs (callbacks fire via `schedule`).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let rect = { left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220 };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // Async so the hook's `frame` handle is assigned before the callback runs,
  // as with a real rAF.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(0), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rect = { left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220 };
});

function elementRef() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return { current: el };
}

describe("useViewportPlacement", () => {
  it("measures the element rect in logical CSS pixels with the current dpr", () => {
    const el = document.createElement("div");
    expect(measurePlacement(el, 2)).toEqual({ x: 10, y: 20, width: 300, height: 200, dpr: 2 });
  });

  it("sends the placement on mount and hides the surface on unmount", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    const commands: unknown[] = [];
    const originalCommand = host.command.bind(host);
    vi.spyOn(host, "command").mockImplementation(async (cmd) => {
      commands.push(cmd);
      return originalCommand(cmd);
    });

    const { unmount } = renderHook(() => useViewportPlacement(host, elementRef()));
    await waitFor(() => {
      expect(commands).toContainEqual({
        kind: "set_placement",
        placement: { x: 10, y: 20, width: 300, height: 200, dpr: window.devicePixelRatio || 1 },
      });
    });

    unmount();
    await waitFor(() => {
      expect(commands).toContainEqual({ kind: "set_presented", presented: false });
    });
    await host.close();
  });

  it("re-sends only when the rect actually changed", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    const commands: unknown[] = [];
    const originalCommand = host.command.bind(host);
    vi.spyOn(host, "command").mockImplementation(async (cmd) => {
      commands.push(cmd);
      return originalCommand(cmd);
    });

    const ref = elementRef();
    renderHook(() => useViewportPlacement(host, ref));
    await waitFor(() =>
      expect(commands.filter((c) => (c as { kind: string }).kind === "set_placement")).toHaveLength(1),
    );

    // Same rect: a scroll event schedules a re-measure but nothing is sent.
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 10));
    expect(commands.filter((c) => (c as { kind: string }).kind === "set_placement")).toHaveLength(1);

    // Changed rect: the new placement goes out.
    rect = { ...rect, left: 50, right: 350 };
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(commands.filter((c) => (c as { kind: string }).kind === "set_placement")).toHaveLength(2),
    );
    await host.close();
  });

  it("hides the surface while disabled and re-places when re-enabled", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    const commands: unknown[] = [];
    const originalCommand = host.command.bind(host);
    vi.spyOn(host, "command").mockImplementation(async (cmd) => {
      commands.push(cmd);
      return originalCommand(cmd);
    });

    const ref = elementRef();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useViewportPlacement(host, ref, enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(commands.filter((c) => (c as { kind: string }).kind === "set_placement")).toHaveLength(1),
    );

    // Disabling hides the surface (a state the surface cannot represent).
    rerender({ enabled: false });
    await waitFor(() => {
      expect(commands).toContainEqual({ kind: "set_presented", presented: false });
    });

    // Re-enabling resends the placement, which re-shows the surface.
    rerender({ enabled: true });
    await waitFor(() =>
      expect(commands.filter((c) => (c as { kind: string }).kind === "set_placement")).toHaveLength(2),
    );
    await host.close();
  });
});
