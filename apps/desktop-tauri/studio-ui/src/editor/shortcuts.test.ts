// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  canonicalCombo,
  comboLabel,
  comboMatchesEvent,
  dispatchShortcut,
  findConflicts,
  parseCombo,
  useShortcutScope,
  type ShortcutBinding,
} from "./shortcuts";
import { MASK_EDIT_SHORTCUTS } from "./maskShortcuts";
import { MASK_SHORTCUT_ZH } from "./maskShortcutsI18n";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("combo parsing / matching", () => {
  it("parses order- and case-insensitively", () => {
    expect(parseCombo("Ctrl+Shift+Z")).toEqual({ ctrl: true, shift: true, alt: false, key: "z" });
    expect(canonicalCombo("shift+ctrl+Z")).toBe("ctrl+shift+z");
    expect(canonicalCombo("[")).toBe("[");
  });

  it("matches events, treating meta as ctrl (macOS ⌘)", () => {
    const combo = parseCombo("ctrl+z");
    expect(comboMatchesEvent(combo, key({ key: "z", ctrlKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: "z", metaKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: "z" }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("renders human-readable labels", () => {
    expect(comboLabel("ctrl+shift+i")).toBe("Ctrl+Shift+I");
    expect(comboLabel("[")).toBe("[");
  });
});

describe("conflict detection", () => {
  it("flags duplicate combos in one scope", () => {
    const bindings: ShortcutBinding[] = [
      { id: "a", combo: "b", status: "ready", hint: "" },
      { id: "b", combo: "B", status: "planned", hint: "" },
    ];
    expect(findConflicts(bindings)).toHaveLength(1);
  });

  // The CI guard: any new mask-edit binding reusing a taken combo fails here.
  it("mask-edit scope has no conflicts", () => {
    expect(findConflicts(MASK_EDIT_SHORTCUTS)).toEqual([]);
  });
});

describe("mask-edit shortcut table", () => {
  it("has a zh translation for every binding (and no stale entries)", () => {
    for (const b of MASK_EDIT_SHORTCUTS) {
      expect(MASK_SHORTCUT_ZH[b.id]?.hint, `zh hint for "${b.id}"`).toBeTruthy();
    }
    const ids = new Set(MASK_EDIT_SHORTCUTS.map((b) => b.id));
    for (const id of Object.keys(MASK_SHORTCUT_ZH)) {
      expect(ids.has(id), `MASK_SHORTCUT_ZH["${id}"] has no matching binding`).toBe(true);
    }
  });
});

describe("scope stack dispatch", () => {
  const bindings = (id: string): ShortcutBinding[] => [
    { id, combo: "b", status: "ready", hint: "" },
    { id: `${id}_planned`, combo: "q", status: "planned", hint: "" },
  ];

  it("dispatches to the topmost scope and stops", () => {
    const calls: string[] = [];
    const lower = renderHook(() => useShortcutScope("lower", bindings("low"), { low: () => void calls.push("low") }));
    const upper = renderHook(() => useShortcutScope("upper", bindings("up"), { up: () => void calls.push("up") }));
    expect(dispatchShortcut(key({ key: "b" }))).toBe(true);
    expect(calls).toEqual(["up"]);
    upper.unmount();
    expect(dispatchShortcut(key({ key: "b" }))).toBe(true);
    expect(calls).toEqual(["up", "low"]);
    lower.unmount();
    expect(dispatchShortcut(key({ key: "b" }))).toBe(false);
  });

  it("planned bindings are never dispatched", () => {
    const hook = renderHook(() => useShortcutScope("s", bindings("x"), { x: () => {}, x_planned: () => {} }));
    expect(dispatchShortcut(key({ key: "q" }))).toBe(false);
    hook.unmount();
  });

  it("a handler returning false falls through to lower scopes", () => {
    const calls: string[] = [];
    const lower = renderHook(() => useShortcutScope("lower", bindings("low"), { low: () => void calls.push("low") }));
    const upper = renderHook(() =>
      useShortcutScope("upper", bindings("up"), {
        up: () => {
          calls.push("up-declined");
          return false;
        },
      }),
    );
    expect(dispatchShortcut(key({ key: "b" }))).toBe(true);
    expect(calls).toEqual(["up-declined", "low"]);
    upper.unmount();
    lower.unmount();
  });

  it("skips plain-letter shortcuts while typing in a field", () => {
    const calls: string[] = [];
    const hook = renderHook(() => useShortcutScope("s", bindings("x"), { x: () => void calls.push("x") }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    const e = key({ key: "b" });
    Object.defineProperty(e, "target", { value: input });
    expect(dispatchShortcut(e)).toBe(false);
    expect(calls).toEqual([]);
    input.remove();
    hook.unmount();
  });
});
