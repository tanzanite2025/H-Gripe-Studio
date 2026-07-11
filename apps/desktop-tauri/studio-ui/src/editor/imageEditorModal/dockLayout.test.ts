import { describe, expect, it } from "vitest";
import {
  moveTab,
  reconcileLayout,
  selectTab,
  setRailWidth,
  RAIL_MAX,
  RAIL_MIN,
  type DockLayoutState,
} from "./dockLayout";

const base: DockLayoutState = {
  groups: [
    { tabs: ["options", "properties", "info"], active: "options" },
    { tabs: ["layers", "history"], active: "layers" },
  ],
  railWidth: 240,
};

describe("selectTab", () => {
  it("activates the tab in its own group only", () => {
    const next = selectTab(base, "info");
    expect(next.groups[0].active).toBe("info");
    expect(next.groups[1].active).toBe("layers");
  });
});

describe("moveTab", () => {
  it("reorders within a group", () => {
    const next = moveTab(base, "info", 0, 0);
    expect(next.groups[0].tabs).toEqual(["info", "options", "properties"]);
    expect(next.groups[0].active).toBe("info");
  });

  it("adjusts the index when moving right within the same group", () => {
    const next = moveTab(base, "options", 0, 2);
    expect(next.groups[0].tabs).toEqual(["properties", "options", "info"]);
  });

  it("re-docks into another group and activates there", () => {
    const next = moveTab(base, "history", 0, 1);
    expect(next.groups[0].tabs).toEqual(["options", "history", "properties", "info"]);
    expect(next.groups[0].active).toBe("history");
    expect(next.groups[1].tabs).toEqual(["layers"]);
  });

  it("drops a group emptied by the move", () => {
    const afterOne = moveTab(base, "layers", 0, 0);
    const afterTwo = moveTab(afterOne, "history", 0, 0);
    expect(afterTwo.groups).toHaveLength(1);
    expect(afterTwo.groups[0].tabs).toEqual(["history", "layers", "options", "properties", "info"]);
  });

  it("repairs the source group's active tab when it moved away", () => {
    const next = moveTab(base, "layers", 0, 0);
    expect(next.groups[1].active).toBe("history");
  });

  it("ignores unknown tabs and bad group indices", () => {
    expect(moveTab(base, "nope", 0, 0)).toBe(base);
    expect(moveTab(base, "layers", 5, 0)).toBe(base);
  });
});

describe("setRailWidth", () => {
  it("clamps to the allowed range", () => {
    expect(setRailWidth(base, 10).railWidth).toBe(RAIL_MIN);
    expect(setRailWidth(base, 10_000).railWidth).toBe(RAIL_MAX);
    expect(setRailWidth(base, 300).railWidth).toBe(300);
  });
});

describe("reconcileLayout", () => {
  it("returns defaults for garbage", () => {
    expect(reconcileLayout(null, base)).toBe(base);
    expect(reconcileLayout({ groups: "x" }, base)).toBe(base);
  });

  it("drops unknown ids and re-adds missing panels to their default group", () => {
    const stored = {
      groups: [
        { tabs: ["layers", "bogus"], active: "layers" },
        { tabs: ["options"], active: "options" },
      ],
      railWidth: 300,
    };
    const next = reconcileLayout(stored, base);
    expect(next.groups[0].tabs).toContain("layers");
    expect(next.groups.flatMap((g) => g.tabs).sort()).toEqual(
      ["history", "info", "layers", "options", "properties"].sort(),
    );
    expect(next.groups.flatMap((g) => g.tabs)).not.toContain("bogus");
    expect(next.railWidth).toBe(300);
  });

  it("repairs a stored active id that no longer exists", () => {
    const stored = { groups: [{ tabs: ["layers"], active: "bogus" }], railWidth: 240 };
    const next = reconcileLayout(stored, base);
    expect(next.groups[0].active).toBe("layers");
  });

  it("dedupes a tab stored in two groups", () => {
    const stored = {
      groups: [
        { tabs: ["layers"], active: "layers" },
        { tabs: ["layers", "history"], active: "history" },
      ],
      railWidth: 240,
    };
    const next = reconcileLayout(stored, base);
    expect(next.groups.flatMap((g) => g.tabs).filter((id) => id === "layers")).toHaveLength(1);
  });
});
