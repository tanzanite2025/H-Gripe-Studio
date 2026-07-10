// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPolygonSelection } from "./selection";
import { useSelectionController } from "./useSelectionController";

describe("useSelectionController", () => {
  it("commits a draft into active selection and clears the draft", () => {
    const { result } = renderHook(() => useSelectionController());
    const draft = createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "pen");

    act(() => result.current.setSelectionDraft(draft));
    act(() => {
      expect(result.current.commitDraft()).toBe(true);
    });

    expect(result.current.selectionDraft).toBeNull();
    expect(result.current.activeSelection).toMatchObject({
      region: [10, 10, 70, 50],
      source: "pen",
      antiAlias: true,
    });
  });

  it("resizes the visible active selection without creating a draft", () => {
    const { result } = renderHook(() => useSelectionController());
    const draft = createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "pen");

    act(() => result.current.commitDraft(draft));
    act(() => result.current.resizeVisibleSelection([20, 30, 120, 90], true));

    expect(result.current.selectionDraft).toBeNull();
    expect(result.current.activeSelection).toMatchObject({
      region: [20, 30, 120, 90],
      ellipse: true,
      source: "pen",
    });
    expect(result.current.activeSelection).not.toHaveProperty("polygon");
  });

  it("clears only the active selection when requested", () => {
    const { result } = renderHook(() => useSelectionController());

    expect(result.current.clearActiveSelection()).toBe(false);
    act(() => result.current.commitDraft(createPolygonSelection([[0, 0], [10, 0], [0, 10]])));
    act(() => {
      expect(result.current.clearActiveSelection()).toBe(true);
    });

    expect(result.current.activeSelection).toBeNull();
    expect(result.current.selectionDraft).toBeNull();
  });
});
