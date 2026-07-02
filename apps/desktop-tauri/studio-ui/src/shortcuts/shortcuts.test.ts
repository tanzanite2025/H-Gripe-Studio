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
} from "./core";
import { MASK_EDIT_SHORTCUTS } from "./scopes/maskEdit";
import { MASK_SHORTCUT_ZH } from "./scopes/maskEditI18n";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("combo parsing / matching", () => {
  it("parses order- and case-insensitively", () => {
    expect(parseCombo("Ctrl+Shift+Z")).toEqual({ ctrl: true, shift: true, alt: false, key: "z" });
    expect(canonicalCombo("shift+ctrl+Z")).toBe("ctrl+shift+z");
    expect(canonicalCombo("[")).toBe("[");
    expect(parseCombo("space").key).toBe(" ");
  });

  it("matches events, treating meta as ctrl (macOS ⌘)", () => {
    const combo = parseCombo("ctrl+z");
    expect(comboMatchesEvent(combo, key({ key: "z", ctrlKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: "z", metaKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: "z" }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("matches shifted punctuation keys (Shift+[ reports '{')", () => {
    expect(comboMatchesEvent(parseCombo("shift+["), key({ key: "{", shiftKey: true }))).toBe(true);
    expect(comboMatchesEvent(parseCombo("shift+]"), key({ key: "}", shiftKey: true }))).toBe(true);
    expect(comboMatchesEvent(parseCombo("shift+["), key({ key: "[" }))).toBe(false);
    expect(comboMatchesEvent(parseCombo("["), key({ key: "[" }))).toBe(true);
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

describe("mask-edit M4 bindings", () => {
  it("flips the brush / quick-mask / default-colours combos to ready", () => {
    for (const id of ["brush_softer", "brush_harder", "quick_mask", "default_colors", "swap_mode"]) {
      const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("mask-edit M5 bindings", () => {
  it("flips the move / crop / free-transform combos to ready", () => {
    for (const id of ["tool_move", "tool_crop", "free_transform"]) {
      const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("mask-edit M8 bindings", () => {
  it("flips the hand / zoom / navigation combos to ready", () => {
    for (const id of ["tool_hand", "tool_zoom", "pan_space", "zoom_in", "zoom_out", "zoom_fit", "zoom_100"]) {
      const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("mask-edit M9 bindings", () => {
  it("flips the selection-command combos to ready", () => {
    for (const id of ["select_all", "delete_selection", "reselect", "duplicate"]) {
      const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("mask-edit M10 bindings", () => {
  it("flips the gradient tool combo to ready", () => {
    const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === "tool_gradient");
    expect(b?.status).toBe("ready");
  });
});

describe("mask-edit M11 bindings", () => {
  it("flips the fill / feather dialog combos to ready", () => {
    for (const id of ["fill_dialog", "feather_dialog"]) {
      const b = MASK_EDIT_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
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
