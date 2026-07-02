// Central keyboard-shortcut system: a scope stack with declarative binding
// tables.
//
// Shortcuts are registered per *scope* (e.g. the Mask-Edit modal, later the
// node canvas or a clip timeline). A component pushes its scope while mounted
// (`useShortcutScope`); a single window listener dispatches each keydown to
// the topmost scope that binds the pressed combo, so modal shortcuts shadow
// canvas ones and never leak once the modal closes. Photoshop-style keys and
// a future Premiere-style set can therefore reuse the same letters without
// colliding — they live in different scopes.
//
// Bindings are plain data (combo + action id + status) rather than inline
// listeners so that:
//   - conflicts inside one scope are detectable (`findConflicts`, guarded by a
//     unit test that fails CI when a new binding reuses a taken combo);
//   - not-yet-implemented actions can already reserve their PS-aligned combo
//     (`status: "planned"` — documented, never consumed at runtime);
//   - a cheat-sheet UI / tooltips can render the table (`comboLabel`).

import { useEffect, useRef } from "react";

export type ShortcutStatus = "ready" | "planned";

/** A parsed key combo. `key` is `KeyboardEvent.key`, lower-cased. */
export interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export interface ShortcutBinding {
  /** Action id the scope's handler map is keyed by. */
  id: string;
  /** Combo string, e.g. `"b"`, `"ctrl+shift+z"`, `"["`. */
  combo: string;
  /** `planned` bindings reserve the combo but are never dispatched. */
  status: ShortcutStatus;
  /** One-line English description (cheat sheet / tooltips). */
  hint: string;
}

/**
 * A handler runs its action and returns `void` when handled; returning
 * `false` declines the event (e.g. Enter with no pending pen path) so it
 * falls through to lower scopes / the browser default.
 */
export type ShortcutHandler = (e: KeyboardEvent) => void | false;
export type ShortcutHandlers = Readonly<Record<string, ShortcutHandler>>;

/** Parse `"ctrl+shift+z"` → a `Combo`. Order-insensitive, case-insensitive. */
export function parseCombo(combo: string): Combo {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return { ctrl: mods.has("ctrl"), shift: mods.has("shift"), alt: mods.has("alt"), key };
}

/** Canonical form for equality: `"ctrl+shift+z"`, `"["`. */
export function canonicalCombo(combo: string): string {
  const c = parseCombo(combo);
  return `${c.ctrl ? "ctrl+" : ""}${c.shift ? "shift+" : ""}${c.alt ? "alt+" : ""}${c.key}`;
}

/** `ctrl` matches Ctrl on Windows/Linux and ⌘ on macOS. */
export function comboMatchesEvent(combo: Combo, e: KeyboardEvent): boolean {
  return (
    combo.ctrl === (e.ctrlKey || e.metaKey) &&
    combo.shift === e.shiftKey &&
    combo.alt === e.altKey &&
    combo.key === e.key.toLowerCase()
  );
}

/** Human-readable form for tooltips, e.g. `"Ctrl+Shift+Z"`, `"["`. */
export function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

/**
 * Combos bound more than once inside one scope (both ready and planned count —
 * a planned reservation must not be silently stolen). Guarded by a unit test.
 */
export function findConflicts(bindings: readonly ShortcutBinding[]): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const b of bindings) {
    const key = canonicalCombo(b.combo);
    const prior = seen.get(key);
    if (prior) conflicts.push(`"${key}" bound by both "${prior}" and "${b.id}"`);
    else seen.set(key, b.id);
  }
  return conflicts;
}

interface ScopeEntry {
  scopeId: string;
  bindings: readonly ShortcutBinding[];
  handlersRef: { current: ShortcutHandlers };
}

const scopeStack: ScopeEntry[] = [];
let listener: ((e: KeyboardEvent) => void) | null = null;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
  );
}

/** Exported for tests. Dispatches to the topmost scope binding the combo. */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  // While typing in a field, only Escape reaches shortcut scopes — plain
  // letters and Ctrl+Z/C/V must keep their native text-editing behaviour.
  if (isEditableTarget(e.target) && e.key !== "Escape") return false;
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    const scope = scopeStack[i];
    for (const b of scope.bindings) {
      if (b.status !== "ready") continue;
      if (!comboMatchesEvent(parseCombo(b.combo), e)) continue;
      const handler = scope.handlersRef.current[b.id];
      if (!handler) continue;
      if (handler(e) === false) continue;
      e.preventDefault();
      return true;
    }
  }
  return false;
}

function pushScope(entry: ScopeEntry): () => void {
  scopeStack.push(entry);
  if (!listener) {
    listener = (e: KeyboardEvent) => void dispatchShortcut(e);
    window.addEventListener("keydown", listener);
  }
  return () => {
    const i = scopeStack.indexOf(entry);
    if (i >= 0) scopeStack.splice(i, 1);
    if (scopeStack.length === 0 && listener) {
      window.removeEventListener("keydown", listener);
      listener = null;
    }
  };
}

/**
 * Push a shortcut scope while the component is mounted. `handlers` is read
 * through a ref so the scope registers once and always calls the latest
 * closures.
 */
export function useShortcutScope(
  scopeId: string,
  bindings: readonly ShortcutBinding[],
  handlers: ShortcutHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => pushScope({ scopeId, bindings, handlersRef }), [scopeId, bindings]);
}
