// Bottom production drawer shell state: a collapsed rail/handle plus one
// expanded editing height. Pure helpers + localStorage persistence, kept out
// of the component for testing.

export type DrawerMode = "collapsed" | "open";

const MODE_KEY = "hgripe.studio.productionDrawer.mode.v1";

export function isDrawerMode(v: unknown): v is DrawerMode {
  return v === "collapsed" || v === "open";
}

function normalizeDrawerMode(v: unknown): DrawerMode | null {
  if (isDrawerMode(v)) return v;
  // Legacy two-stage states collapse into the single expanded state.
  if (v === "half" || v === "full") return "open";
  return null;
}

/** Toggle between the collapsed rail and the single expanded editing state. */
export function toggleDrawer(mode: DrawerMode): DrawerMode {
  return mode === "collapsed" ? "open" : "collapsed";
}

export function loadDrawerMode(): DrawerMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return normalizeDrawerMode(v) ?? "collapsed";
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
