// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useObservedElementSize } from "./useObservedElementSize";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useObservedElementSize", () => {
  it("reads the mounted size and follows ResizeObserver notifications", () => {
    let notify: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    });
    const element = { clientWidth: 640.4, clientHeight: 479.6 } as HTMLElement;
    const ref = { current: element };
    const { result } = renderHook(() => useObservedElementSize(ref));

    expect(result.current).toEqual({ w: 640, h: 480 });
    Object.assign(element, { clientWidth: 800, clientHeight: 600 });
    act(() => notify?.());
    expect(result.current).toEqual({ w: 800, h: 600 });
  });

  it("does not publish zero-sized measurements", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    const ref = { current: { clientWidth: 0, clientHeight: 0 } as HTMLElement };
    const { result } = renderHook(() => useObservedElementSize(ref));
    expect(result.current).toBeNull();
  });
});
