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
import { IMAGE_EDITOR_SHORTCUTS, TOOL_COMBO } from "./scopes/imageEditor";
import { IMAGE_EDITOR_SHORTCUT_ZH } from "./scopes/imageEditorI18n";
import { IMAGE_EDITOR_TOOLS } from "../editor/imageEditorTools";

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

  // The CI guard: any new image-editor binding reusing a taken combo fails here.
  it("image-editor scope has no conflicts", () => {
    expect(findConflicts(IMAGE_EDITOR_SHORTCUTS)).toEqual([]);
  });
});

describe("image-editor shortcut table", () => {
  it("has a zh translation for every binding (and no stale entries)", () => {
    for (const b of IMAGE_EDITOR_SHORTCUTS) {
      expect(IMAGE_EDITOR_SHORTCUT_ZH[b.id]?.hint, `zh hint for "${b.id}"`).toBeTruthy();
    }
    const ids = new Set(IMAGE_EDITOR_SHORTCUTS.map((b) => b.id));
    for (const id of Object.keys(IMAGE_EDITOR_SHORTCUT_ZH)) {
      expect(ids.has(id), `IMAGE_EDITOR_SHORTCUT_ZH["${id}"] has no matching binding`).toBe(true);
    }
  });
});

describe("toolbar shortcut badges (TOOL_COMBO)", () => {
  it("every entry names a registered tool", () => {
    const toolIds = new Set(IMAGE_EDITOR_TOOLS.map((t) => t.id));
    for (const id of Object.keys(TOOL_COMBO)) {
      expect(toolIds.has(id), `TOOL_COMBO["${id}"] has no matching mask tool`).toBe(true);
    }
  });

  it("every combo matches a ready binding in the scope table", () => {
    const byCombo = new Map(IMAGE_EDITOR_SHORTCUTS.map((b) => [canonicalCombo(b.combo), b]));
    for (const [id, combo] of Object.entries(TOOL_COMBO)) {
      const binding = byCombo.get(canonicalCombo(combo));
      expect(binding, `TOOL_COMBO["${id}"] = "${combo}" is not in IMAGE_EDITOR_SHORTCUTS`).toBeTruthy();
      expect(binding?.status, `binding for TOOL_COMBO["${id}"]`).toBe("ready");
    }
  });

  it("every ready tool_* binding has a badge entry", () => {
    // Tool-selection bindings whose action id follows `tool_<...>`; the ids
    // that intentionally have no toolbar badge are commands, not tools.
    const nonToolIds = new Set(["tool_path_select"]);
    const badgeCombos = new Set(Object.values(TOOL_COMBO).map(canonicalCombo));
    for (const b of IMAGE_EDITOR_SHORTCUTS) {
      if (!b.id.startsWith("tool_") || b.status !== "ready" || nonToolIds.has(b.id)) continue;
      expect(badgeCombos.has(canonicalCombo(b.combo)), `no TOOL_COMBO entry for "${b.id}" ("${b.combo}")`).toBe(true);
    }
  });
});

describe("image-editor M4 bindings", () => {
  it("flips the brush / quick-mask / default-colours combos to ready", () => {
    for (const id of ["brush_softer", "brush_harder", "quick_mask", "default_colors", "swap_mode"]) {
      const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("image-editor M5 bindings", () => {
  it("flips the move / crop / free-transform combos to ready", () => {
    for (const id of ["tool_move", "tool_crop", "free_transform"]) {
      const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("image-editor M8 bindings", () => {
  it("keeps hand / rotate-view / navigation combos ready", () => {
    for (const id of ["tool_hand", "tool_rotate_view", "pan_space", "zoom_in", "zoom_out", "zoom_fit", "zoom_100"]) {
      const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("image-editor M9 bindings", () => {
  it("flips the selection-command combos to ready", () => {
    for (const id of ["select_all", "delete_selection", "reselect", "duplicate"]) {
      const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === id);
      expect(b?.status, id).toBe("ready");
    }
  });
});

describe("image-editor M10 bindings", () => {
  it("flips the gradient tool combo to ready", () => {
    const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === "tool_gradient");
    expect(b?.status).toBe("ready");
  });
});

describe("image-editor M11 bindings", () => {
  it("flips the fill / feather dialog combos to ready", () => {
    for (const id of ["fill_dialog", "feather_dialog"]) {
      const b = IMAGE_EDITOR_SHORTCUTS.find((x) => x.id === id);
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

  it("prevents a handled modal shortcut from leaking to global listeners", () => {
    const calls: string[] = [];
    const globalListener = () => calls.push("global");
    window.addEventListener("keydown", globalListener);
    const hook = renderHook(() =>
      useShortcutScope(
        "modal",
        [{ id: "undo", combo: "ctrl+z", status: "ready", hint: "" }],
        { undo: () => void calls.push("modal") },
      ),
    );

    window.dispatchEvent(key({ key: "z", ctrlKey: true }));
    expect(calls).toEqual(["modal"]);

    hook.unmount();
    window.removeEventListener("keydown", globalListener);
  });
});
