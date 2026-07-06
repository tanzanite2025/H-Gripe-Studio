// Zoom level-of-detail (LOD): below this zoom the node cards collapse to just a
// title bar (hiding inline params / thumbnails / error blocks). Keeps large
// graphs legible and cheap to render when zoomed out to survey the whole graph.
export const LOD_ZOOM_THRESHOLD = 0.55;

// Intermediate LOD: below this zoom (but above the collapse threshold) cards
// keep their frame, header, and port rows, but drop the interactive interior
// (inline params, thumbnails, port labels) — unreadable at that scale and the
// bulk of a card's DOM cost.
export const LOD_MID_ZOOM_THRESHOLD = 0.75;

export type LodLevel = "full" | "mid" | "collapsed";

/** The card detail level for a zoom: full > mid > collapsed as zoom drops. */
export function lodLevel(zoom: number): LodLevel {
  if (zoom < LOD_ZOOM_THRESHOLD) return "collapsed";
  if (zoom < LOD_MID_ZOOM_THRESHOLD) return "mid";
  return "full";
}

/** Should a node render in collapsed (title-only) form at this zoom level? */
export function isLodActive(zoom: number, threshold = LOD_ZOOM_THRESHOLD): boolean {
  return zoom < threshold;
}
