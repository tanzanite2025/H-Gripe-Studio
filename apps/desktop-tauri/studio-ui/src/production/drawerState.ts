// Bottom production drawer shell state: a collapsed rail/handle plus half and
// full heights. Pure helpers + localStorage persistence, kept out of the
// component for testing.

export type DrawerMode = "collapsed" | "half" | "full";

const MODE_KEY = "hgripe.studio.productionDrawer.mode.v1";

export function isDrawerMode(v: unknown): v is DrawerMode {
  return v === "collapsed" || v === "half" || v === "full";
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

