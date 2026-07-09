// Per-clip property document (Premiere-style Properties panel): transform
// (position / anchor / scale / rotation / opacity) and crop, stored
// non-destructively per timeline clip. Pure functions over an immutable
// document so the panel is unit testable without React. Keyframing and
// render-time application build on this document in later steps.

export interface ClipTransform {
  /** Frame position of the anchor point, pixels. */
  position: { x: number; y: number };
  /** Anchor point in clip-local pixels. */
  anchor: { x: number; y: number };
  /** Uniform scale, percent (100 = native size). */
  scalePct: number;
  /** Rotation around the anchor, degrees. */
  rotationDeg: number;
  /** Opacity, percent (100 = opaque). */
  opacityPct: number;
}

export interface ClipCrop {
  /** Cropped-away share of each edge, percent (0..100). */
  leftPct: number;
  topPct: number;
  rightPct: number;
  bottomPct: number;
}

export interface ClipProperties {
  transform: ClipTransform;
  crop: ClipCrop;
}

export const MIN_SCALE_PCT = 0;
export const MAX_SCALE_PCT = 10000;

export function defaultClipProperties(): ClipProperties {
  return {
    transform: {
      position: { x: 0, y: 0 },
      anchor: { x: 0, y: 0 },
      scalePct: 100,
      rotationDeg: 0,
      opacityPct: 100,
    },
    crop: { leftPct: 0, topPct: 0, rightPct: 0, bottomPct: 0 },
  };
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp a document into consistent ranges: scale in [MIN_SCALE_PCT,
 * MAX_SCALE_PCT], opacity and crop edges in [0, 100], opposite crop edges
 * together under 100 so the visible window never inverts. Non-finite fields
 * fall back to their defaults.
 */
export function clampClipProperties(props: ClipProperties): ClipProperties {
  const d = defaultClipProperties();
  const leftPct = clampPct(finite(props.crop.leftPct, 0));
  const topPct = clampPct(finite(props.crop.topPct, 0));
  return {
    transform: {
      position: {
        x: finite(props.transform.position.x, d.transform.position.x),
        y: finite(props.transform.position.y, d.transform.position.y),
      },
      anchor: {
        x: finite(props.transform.anchor.x, d.transform.anchor.x),
        y: finite(props.transform.anchor.y, d.transform.anchor.y),
      },
      scalePct: Math.min(
        MAX_SCALE_PCT,
        Math.max(MIN_SCALE_PCT, finite(props.transform.scalePct, d.transform.scalePct)),
      ),
      rotationDeg: finite(props.transform.rotationDeg, 0),
      opacityPct: clampPct(finite(props.transform.opacityPct, 100)),
    },
    crop: {
      leftPct,
      topPct,
      rightPct: Math.min(clampPct(finite(props.crop.rightPct, 0)), 100 - leftPct),
      bottomPct: Math.min(clampPct(finite(props.crop.bottomPct, 0)), 100 - topPct),
    },
  };
}

/** True when every field still has its default value (nothing to store). */
export function isDefaultClipProperties(props: ClipProperties): boolean {
  const d = defaultClipProperties();
  return (
    props.transform.position.x === d.transform.position.x &&
    props.transform.position.y === d.transform.position.y &&
    props.transform.anchor.x === d.transform.anchor.x &&
    props.transform.anchor.y === d.transform.anchor.y &&
    props.transform.scalePct === d.transform.scalePct &&
    props.transform.rotationDeg === d.transform.rotationDeg &&
    props.transform.opacityPct === d.transform.opacityPct &&
    props.crop.leftPct === 0 &&
    props.crop.topPct === 0 &&
    props.crop.rightPct === 0 &&
    props.crop.bottomPct === 0
  );
}
