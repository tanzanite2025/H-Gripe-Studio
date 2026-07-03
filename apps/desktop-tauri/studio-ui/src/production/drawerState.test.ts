// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  isDrawerMode,
  isDrawerTab,
  loadDrawerMode,
  loadDrawerTab,
  saveDrawerMode,
  saveDrawerTab,
  toggleDrawer,
} from "./drawerState";

beforeEach(() => {
  localStorage.clear();
});

describe("production drawer shell state", () => {
  it("validates modes and tabs", () => {
    expect(isDrawerMode("collapsed")).toBe(true);
    expect(isDrawerMode("half")).toBe(true);
    expect(isDrawerMode("full")).toBe(true);
    expect(isDrawerMode("open")).toBe(false);
    expect(isDrawerTab("edit")).toBe(true);
    expect(isDrawerTab("grade")).toBe(true);
    expect(isDrawerTab("export")).toBe(false);
  });

  it("toggles between the rail and the last expanded height", () => {
    expect(toggleDrawer("collapsed")).toBe("half");
    expect(toggleDrawer("collapsed", "full")).toBe("full");
    expect(toggleDrawer("collapsed", "collapsed")).toBe("half");
    expect(toggleDrawer("half")).toBe("collapsed");
    expect(toggleDrawer("full")).toBe("collapsed");
  });

  it("persists and restores mode and tab, defaulting on garbage", () => {
    expect(loadDrawerMode()).toBe("collapsed");
    expect(loadDrawerTab()).toBe("edit");
    saveDrawerMode("full");
    saveDrawerTab("grade");
    expect(loadDrawerMode()).toBe("full");
    expect(loadDrawerTab()).toBe("grade");
    localStorage.setItem("hgripe.studio.productionDrawer.mode.v1", "sideways");
    localStorage.setItem("hgripe.studio.productionDrawer.tab.v1", "export");
    expect(loadDrawerMode()).toBe("collapsed");
    expect(loadDrawerTab()).toBe("edit");
  });
});
