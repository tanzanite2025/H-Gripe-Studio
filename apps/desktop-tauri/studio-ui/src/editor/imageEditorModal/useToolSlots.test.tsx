// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useToolSlots } from "./useToolSlots";

describe("useToolSlots", () => {
  it("selects tools and remembers the active face for multi-tool slots", () => {
    const onBeforeSelect = vi.fn();
    const { result } = renderHook(() => useToolSlots({ initialToolId: "move", onBeforeSelect }));

    act(() => result.current.selectTool("ellipse"));

    expect(result.current.toolId).toBe("ellipse");
    expect(result.current.slotFaces.marquee).toBe("ellipse");
    expect(onBeforeSelect).toHaveBeenCalledWith("ellipse");
  });

  it("selects the remembered ready face when a slot is activated", () => {
    const { result } = renderHook(() => useToolSlots({
      initialToolId: "move",
      onBeforeSelect: () => {},
    }));

    act(() => result.current.setSlotFace("marquee", "ellipse"));
    act(() => result.current.selectSlot("marquee"));

    expect(result.current.toolId).toBe("ellipse");
  });

  it("cycles through ready variants in slot order", () => {
    const { result } = renderHook(() => useToolSlots({
      initialToolId: "rect",
      onBeforeSelect: () => {},
    }));

    act(() => result.current.cycleSlot("marquee"));

    expect(result.current.toolId).toBe("ellipse");
  });
});
