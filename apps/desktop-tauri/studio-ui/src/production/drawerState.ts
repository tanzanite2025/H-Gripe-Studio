// Bottom production drawer shell state: a collapsed rail/handle plus half and
// full heights, and the two resident tabs (Edit / Timeline, Grade). Pure
// helpers + localStorage persistence, kept out of the component for testing.

export type DrawerMode = "collapsed" | "half" | "full";
export type DrawerTab = "edit" | "grade";

const MODE_KEY = "hgripe.studio.productionDrawer.mode.v1";
const TAB_KEY = "hgripe.studio.productionDrawer.tab.v1";

export function isDrawerMode(v: unknown): v is DrawerMode {
  return v === "collapsed" || v === "half" || v === "full";
}

export function isDrawerTab(v: unknown): v is DrawerTab {
  return v === "edit" || v === "grade";
}

/** Toggle between the collapsed rail and the last expanded height. */
export function toggleDrawer(mode: DrawerMode, lastExpanded: DrawerMode = "half"): DrawerMode {
  if (mode === "collapsed") return lastExpanded === "collapsed" ? "half" : lastExpanded;
  return "collapsed";
}

export function loadDrawerMode(): DrawerMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isDrawerMode(v) ? v : "collapsed";
  } catch {
    return "collapsed";
  }
}

export function saveDrawerMode(mode: DrawerMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* persistence is best-effort */
  }
}

export function loadDrawerTab(): DrawerTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return isDrawerTab(v) ? v : "edit";
  } catch {
    return "edit";
  }
}

export function saveDrawerTab(tab: DrawerTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* persistence is best-effort */
  }
}
