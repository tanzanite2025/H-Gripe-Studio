// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clampToViewport,
  isDragGesture,
  loadButtonPos,
  loadDockPos,
  saveButtonPos,
  saveDockPos,
} from "./floatingButton";

describe("clampToViewport", () => {
  it("keeps an in-bounds position unchanged", () => {
    expect(clampToViewport({ x: 100, y: 50 }, 40, 800, 600)).toEqual({ x: 100, y: 50 });
  });

  it("clamps negative and overflowing coordinates", () => {
    expect(clampToViewport({ x: -20, y: -5 }, 40, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(clampToViewport({ x: 900, y: 700 }, 40, 800, 600)).toEqual({ x: 760, y: 560 });
  });

  it("never goes negative when the viewport is smaller than the button", () => {
    expect(clampToViewport({ x: 50, y: 50 }, 100, 60, 60)).toEqual({ x: 0, y: 0 });
  });
});

describe("isDragGesture", () => {
  it("treats small movement as a click", () => {
    expect(isDragGesture(10, 10, 12, 12)).toBe(false);
  });
  it("treats movement past the threshold as a drag", () => {
    expect(isDragGesture(10, 10, 20, 10)).toBe(true);
  });
});

describe("position persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips button and dock positions independently", () => {
    expect(loadButtonPos()).toBeNull();
    saveButtonPos({ x: 5, y: 6 });
    saveDockPos({ x: 7, y: 8 });
    expect(loadButtonPos()).toEqual({ x: 5, y: 6 });
    expect(loadDockPos()).toEqual({ x: 7, y: 8 });
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem("hgripe.studio.promptAssistant.buttonPos.v1", "not json");
    expect(loadButtonPos()).toBeNull();
    localStorage.setItem("hgripe.studio.promptAssistant.dockPos.v1", JSON.stringify({ x: "a" }));
    expect(loadDockPos()).toBeNull();
  });
});
