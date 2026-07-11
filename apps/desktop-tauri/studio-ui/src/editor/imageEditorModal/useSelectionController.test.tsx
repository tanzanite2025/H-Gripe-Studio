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

  it("cancels a draft without changing the active selection", () => {
    const { result } = renderHook(() => useSelectionController());
    const activeDraft = createPolygonSelection([
      [10, 10],
      [70, 10],
      [40, 50],
    ], "pen");
    const pendingDraft = createPolygonSelection([
      [20, 20],
      [80, 20],
      [50, 70],
    ], "polygon_lasso");

    act(() => result.current.commitDraft(activeDraft));
    act(() => result.current.setSelectionDraft(pendingDraft));
    act(() => {
      expect(result.current.cancelDraft()).toBe(true);
    });

    expect(result.current.selectionDraft).toBeNull();
    expect(result.current.activeSelection).toMatchObject({
      source: "pen",
      region: [10, 10, 70, 50],
    });
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
