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
    expect(isDrawerMode("half")).toBe(true);
    expect(isDrawerMode("full")).toBe(true);
    expect(isDrawerMode("open")).toBe(false);
  });

  it("toggles between the rail and the last expanded height", () => {
    expect(toggleDrawer("collapsed")).toBe("half");
    expect(toggleDrawer("collapsed", "full")).toBe("full");
    expect(toggleDrawer("collapsed", "collapsed")).toBe("half");
    expect(toggleDrawer("half")).toBe("collapsed");
    expect(toggleDrawer("full")).toBe("collapsed");
  });

  it("persists and restores the mode, defaulting on garbage", () => {
    expect(loadDrawerMode()).toBe("collapsed");
    saveDrawerMode("full");
    expect(loadDrawerMode()).toBe("full");
    localStorage.setItem("hgripe.studio.productionDrawer.mode.v1", "sideways");
    expect(loadDrawerMode()).toBe("collapsed");
  });
});
