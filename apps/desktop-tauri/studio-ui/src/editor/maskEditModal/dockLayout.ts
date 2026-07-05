// Right-rail dock layout as data (PS-style docking): which panels live in
// which tab group, which tab is active, and the rail width. The layout is a
// plain serialisable value manipulated by pure functions — PanelDock stays
// render-only and MaskEditModal only wires callbacks.

import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface DockGroupState {
  /** Panel ids in tab order. */
  tabs: string[];
  /** The visible tab (falls back to the first tab if missing). */
  active: string;
}

export interface DockLayoutState {
  groups: DockGroupState[];
  /** Right-rail width in px. */
  railWidth: number;
}

export const RAIL_MIN = 280;
export const RAIL_MAX = 480;

const clampRail = (w: number) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));

/** Activate tab `id` in whichever group holds it. */
export function selectTab(layout: DockLayoutState, id: string): DockLayoutState {
  return {
    ...layout,
    groups: layout.groups.map((g) => (g.tabs.includes(id) ? { ...g, active: id } : g)),
  };
}

/**
 * Move tab `id` into `group` at `index` (PS tab drag: reorder within a group
 * or re-dock into another group). The moved tab becomes its group's active
 * tab; a group left empty is dropped.
 */
export function moveTab(layout: DockLayoutState, id: string, group: number, index: number): DockLayoutState {
  const from = layout.groups.findIndex((g) => g.tabs.includes(id));
  if (from < 0 || group < 0 || group >= layout.groups.length) return layout;
  const groups = layout.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
  const fromIdx = groups[from].tabs.indexOf(id);
  groups[from].tabs.splice(fromIdx, 1);
  let target = index;
  if (from === group && fromIdx < index) target -= 1;
  groups[group].tabs.splice(Math.min(Math.max(target, 0), groups[group].tabs.length), 0, id);
  groups[group].active = id;
  for (const g of groups) {
    if (g.tabs.length > 0 && !g.tabs.includes(g.active)) g.active = g.tabs[0];
  }
  return { ...layout, groups: groups.filter((g) => g.tabs.length > 0) };
}

export function setRailWidth(layout: DockLayoutState, width: number): DockLayoutState {
  return { ...layout, railWidth: clampRail(width) };
}

/**
 * Validate a persisted layout against the known panel ids: unknown ids are
 * dropped, panels missing from the stored layout return to their default
 * group (so newly-shipped panels appear after an upgrade).
 */
export function reconcileLayout(stored: unknown, defaults: DockLayoutState): DockLayoutState {
  const known = new Set(defaults.groups.flatMap((g) => g.tabs));
  const s = stored as Partial<DockLayoutState> | null;
  if (!s || !Array.isArray(s.groups)) return defaults;
  const seen = new Set<string>();
  const groups: DockGroupState[] = [];
  for (const g of s.groups) {
    if (!g || !Array.isArray(g.tabs)) return defaults;
    const tabs = g.tabs.filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id));
    for (const id of tabs) seen.add(id);
    if (tabs.length > 0) groups.push({ tabs, active: tabs.includes(g.active as string) ? (g.active as string) : tabs[0] });
  }
  if (groups.length === 0) return defaults;
  // Panels the stored layout doesn't know about land back in their default group.
  defaults.groups.forEach((dg, di) => {
    for (const id of dg.tabs) {
      if (!seen.has(id)) groups[Math.min(di, groups.length - 1)].tabs.push(id);
    }
  });
  const railWidth = typeof s.railWidth === "number" && Number.isFinite(s.railWidth) ? clampRail(s.railWidth) : defaults.railWidth;
  return { groups, railWidth };
}

function loadLayout(storageKey: string, defaults: DockLayoutState): DockLayoutState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaults;
    return reconcileLayout(JSON.parse(raw), defaults);
  } catch {
    return defaults;
  }
}

/** Dock layout state persisted to localStorage. */
export function useDockLayout(storageKey: string, defaults: DockLayoutState) {
  const initial = useMemo(() => loadLayout(storageKey, defaults), [storageKey, defaults]);
  const [layout, setLayout] = useState(initial);

  const update = useCallback(
    (next: DockLayoutState) => {
      setLayout(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* persistence is best-effort */
      }
    },
    [storageKey],
  );

  const onSelect = useCallback((id: string) => update(selectTab(layout, id)), [layout, update]);
  const onTabDrop = useCallback(
    (id: string, group: number, index: number) => update(moveTab(layout, id, group, index)),
    [layout, update],
  );

  /** Pointer-down handler for the rail's resize handle (drag left = wider). */
  const startRailResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = layout.railWidth;
      let lastX = startX;
      const onMove = (ev: PointerEvent) => {
        lastX = ev.clientX;
        setLayout((prev) => setRailWidth(prev, startW + (startX - ev.clientX)));
      };
      // Finish on pointerup *or* pointercancel so the window listeners never
      // outlive the drag (e.g. the pointer is captured away mid-drag).
      const finish = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const endX = ev.type === "pointerup" ? ev.clientX : lastX;
        update(setRailWidth(layout, startW + (startX - endX)));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [layout, update],
  );

  return { layout, onSelect, onTabDrop, startRailResize };
}
