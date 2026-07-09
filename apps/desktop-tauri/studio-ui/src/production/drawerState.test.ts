// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  isDrawerMode,
  loadDrawerMode,
  saveDrawerMode,
  toggleDrawer,
} from "./drawerState";

beforeEach(() => {
  localStorage.clear();
});

describe("production drawer shell state", () => {
  it("validates modes", () => {
    expect(isDrawerMode("collapsed")).toBe(true);
    expect(isDrawerMode("open")).toBe(true);
    expect(isDrawerMode("half")).toBe(false);
    expect(isDrawerMode("full")).toBe(false);
    expect(isDrawerMode("sideways")).toBe(false);
  });

  it("toggles between the rail and the single expanded state", () => {
    expect(toggleDrawer("collapsed")).toBe("open");
    expect(toggleDrawer("open")).toBe("collapsed");
  });

  it("migrates legacy two-stage modes to open", () => {
    localStorage.setItem("hgripe.studio.productionDrawer.mode.v1", "half");
    expect(loadDrawerMode()).toBe("open");
    localStorage.setItem("hgripe.studio.productionDrawer.mode.v1", "full");
    expect(loadDrawerMode()).toBe("open");
  });

  it("persists and restores the mode, defaulting on garbage", () => {
    expect(loadDrawerMode()).toBe("collapsed");
    saveDrawerMode("open");
    expect(loadDrawerMode()).toBe("open");
    localStorage.setItem("hgripe.studio.productionDrawer.mode.v1", "sideways");
    expect(loadDrawerMode()).toBe("collapsed");
  });
});
