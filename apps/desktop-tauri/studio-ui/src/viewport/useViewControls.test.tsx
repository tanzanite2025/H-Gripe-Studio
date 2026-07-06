// @vitest-environment jsdom
// Pins the shared stage interaction contract: wheel zoom accepts the delta on
// either axis (Alt+wheel reports it on X on some platforms) and
// `useSettledView` debounces a moving view until it stops.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettledView, useViewControls } from "./useViewControls";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";

describe("useViewControls wheel zoom", () => {
  const wheel = (over: Partial<React.WheelEvent>): React.WheelEvent =>
    ({ deltaX: 0, deltaY: 0, clientX: 0, clientY: 0, ...over }) as React.WheelEvent;

  it("zooms on a plain wheel (delta on Y)", () => {
    const { result } = renderHook(() => useViewControls());
    act(() => result.current.stageProps.onWheel(wheel({ deltaY: -100 })));
    expect(result.current.view.zoom).toBeGreaterThan(1);
  });

  it("zooms on Alt+wheel (delta reported on X)", () => {
    const { result } = renderHook(() => useViewControls());
    act(() => result.current.stageProps.onWheel(wheel({ deltaX: -100 })));
    expect(result.current.view.zoom).toBeGreaterThan(1);
    act(() => result.current.stageProps.onWheel(wheel({ deltaX: 100 })));
    expect(result.current.view.zoom).toBe(1);
  });

  it("ignores a zero-delta wheel", () => {
    const { result } = renderHook(() => useViewControls());
    const before = result.current.view;
    act(() => result.current.stageProps.onWheel(wheel({})));
    expect(result.current.view).toBe(before);
  });
});

describe("useSettledView", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the previous view while it keeps moving, then settles", () => {
    const { result, rerender } = renderHook(
      ({ view }: { view: ViewportViewState }) => useSettledView(view, 120),
      { initialProps: { view: IDENTITY_VIEW } },
    );
    const a: ViewportViewState = { zoom: 2, panX: 0.25, panY: 0.25 };
    const b: ViewportViewState = { zoom: 4, panX: 0.375, panY: 0.375 };
    rerender({ view: a });
    act(() => vi.advanceTimersByTime(60));
    expect(result.current).toEqual(IDENTITY_VIEW);
    // A change within the window restarts the debounce…
    rerender({ view: b });
    act(() => vi.advanceTimersByTime(60));
    expect(result.current).toEqual(IDENTITY_VIEW);
    // …and only the final view lands after it.
    act(() => vi.advanceTimersByTime(120));
    expect(result.current).toEqual(b);
  });
});
