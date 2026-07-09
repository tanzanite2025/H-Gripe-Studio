// Keyframe layer over the per-clip property document: per-property keyframe
// tracks keyed by property path, evaluated at a clip-local time. The Rust
// backend (`src-tauri/src/studio/clip_props.rs`) is the render-time source of
// truth; this module mirrors its evaluation semantics exactly, pinned by the
// shared fixtures in `clipPropsKeyframeFixtures.json`:
// - a property without keyframes takes its static document value;
// - keyframes evaluate sorted by time, held before the first and after the
//   last key, with each key selecting the interpolation to the next key;
// - resolved values pass through the same clamps as the static document.

import { clampClipProperties, defaultClipProperties, type ClipProperties } from "./clipProps";

export type KeyframeInterpolation = "linear" | "hold" | "bezier";
export type BezierControlPoints = [[number, number], [number, number]];

export const DEFAULT_BEZIER_CONTROL_POINTS: BezierControlPoints = [
  [0.42, 0],
  [0.58, 1],
];

export interface Keyframe {
  /** Clip-local time, seconds. */
  t: number;
  /** Property value at that time. */
  v: number;
  /** Interpolation from this key to the next key (absent = linear). */
  interp?: KeyframeInterpolation;
  /** Normalized cubic-bezier timing control points when `interp` is `bezier`. */
  bezier?: BezierControlPoints;
}

export const CLIP_PROP_PATHS = [
  "transform.position.x",
  "transform.position.y",
  "transform.anchor.x",
  "transform.anchor.y",
  "transform.scalePct",
  "transform.rotationDeg",
  "transform.opacityPct",
  "crop.leftPct",
  "crop.topPct",
  "crop.rightPct",
  "crop.bottomPct",
] as const;

export type ClipPropPath = (typeof CLIP_PROP_PATHS)[number];

export type ClipPropertyTracks = Partial<Record<ClipPropPath, Keyframe[]>>;

/** Read a property's static (unanimated) value from the document. */
export function getClipPropValue(props: ClipProperties, path: ClipPropPath): number {
  const { transform, crop } = props;
  switch (path) {
    case "transform.position.x":
      return transform.position.x;
    case "transform.position.y":
      return transform.position.y;
    case "transform.anchor.x":
      return transform.anchor.x;
    case "transform.anchor.y":
      return transform.anchor.y;
    case "transform.scalePct":
      return transform.scalePct;
    case "transform.rotationDeg":
      return transform.rotationDeg;
    case "transform.opacityPct":
      return transform.opacityPct;
    case "crop.leftPct":
      return crop.leftPct;
    case "crop.topPct":
      return crop.topPct;
    case "crop.rightPct":
      return crop.rightPct;
    case "crop.bottomPct":
      return crop.bottomPct;
  }
}

/** A copy of the document with one static property value replaced. */
export function setClipPropValue(
  props: ClipProperties,
  path: ClipPropPath,
  value: number,
): ClipProperties {
  const next: ClipProperties = {
    ...props,
    transform: { ...props.transform, position: { ...props.transform.position }, anchor: { ...props.transform.anchor } },
    crop: { ...props.crop },
  };
  switch (path) {
    case "transform.position.x":
      next.transform.position.x = value;
      break;
    case "transform.position.y":
      next.transform.position.y = value;
      break;
    case "transform.anchor.x":
      next.transform.anchor.x = value;
      break;
    case "transform.anchor.y":
      next.transform.anchor.y = value;
      break;
    case "transform.scalePct":
      next.transform.scalePct = value;
      break;
    case "transform.rotationDeg":
      next.transform.rotationDeg = value;
      break;
    case "transform.opacityPct":
      next.transform.opacityPct = value;
      break;
    case "crop.leftPct":
      next.crop.leftPct = value;
      break;
    case "crop.topPct":
      next.crop.topPct = value;
      break;
    case "crop.rightPct":
      next.crop.rightPct = value;
      break;
    case "crop.bottomPct":
      next.crop.bottomPct = value;
      break;
  }
  return next;
}

function usableKeys(keys: Keyframe[] | undefined): Keyframe[] {
  return (keys ?? [])
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v))
    .sort((a, b) => a.t - b.t);
}

/** The property's keyframes, sorted by time (empty when unanimated). */
export function keyframesFor(props: ClipProperties, path: ClipPropPath): Keyframe[] {
  return usableKeys(props.tracks?.[path]);
}

export function effectiveKeyframeInterpolation(key: Keyframe): KeyframeInterpolation {
  return key.interp === "hold" || key.interp === "bezier" ? key.interp : "linear";
}

function validBezier(points: BezierControlPoints | undefined): points is BezierControlPoints {
  if (!points) return false;
  const [[x1, y1], [x2, y2]] = points;
  return [x1, y1, x2, y2].every(Number.isFinite)
    && x1 >= 0
    && x1 <= 1
    && x2 >= 0
    && x2 <= 1;
}

function cubicBezierAxis(t: number, p1: number, p2: number): number {
  const oneMinusT = 1 - t;
  return 3 * oneMinusT * oneMinusT * t * p1
    + 3 * oneMinusT * t * t * p2
    + t * t * t;
}

function cubicBezierProgress(alpha: number, points: BezierControlPoints): number {
  const [[x1, y1], [x2, y2]] = points;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (cubicBezierAxis(mid, x1, x2) < alpha) low = mid;
    else high = mid;
  }
  return cubicBezierAxis((low + high) / 2, y1, y2);
}

function segmentProgress(key: Keyframe, alpha: number): number {
  switch (effectiveKeyframeInterpolation(key)) {
    case "hold":
      return 0;
    case "bezier":
      return validBezier(key.bezier) ? cubicBezierProgress(alpha, key.bezier) : alpha;
    case "linear":
      return alpha;
  }
}

function evaluateTrack(keys: Keyframe[], staticValue: number, t: number): number {
  if (keys.length === 0) return staticValue;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      if (b.t <= a.t) return b.v;
      if (t === b.t) return b.v;
      const alpha = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * segmentProgress(a, alpha);
    }
  }
  return last.v;
}

/**
 * Resolve the document at clip-local time `t`: every property evaluated
 * through its track (static value when unanimated), the result clamped like
 * the static document. The returned document carries no tracks.
 */
export function resolveClipPropertiesAt(props: ClipProperties, t: number): ClipProperties {
  let raw: ClipProperties = { transform: { ...props.transform, position: { ...props.transform.position }, anchor: { ...props.transform.anchor } }, crop: { ...props.crop } };
  for (const path of CLIP_PROP_PATHS) {
    const keys = keyframesFor(props, path);
    if (keys.length === 0) continue;
    raw = setClipPropValue(raw, path, evaluateTrack(keys, getClipPropValue(raw, path), t));
  }
  return clampClipProperties(raw);
}

/** Evaluate one property at clip-local time `t` (clamped like the document). */
export function evaluateClipProp(props: ClipProperties, path: ClipPropPath, t: number): number {
  return getClipPropValue(resolveClipPropertiesAt(props, t), path);
}

function withTrack(
  props: ClipProperties,
  path: ClipPropPath,
  keys: Keyframe[],
): ClipProperties {
  const tracks: ClipPropertyTracks = { ...props.tracks };
  if (keys.length === 0) {
    delete tracks[path];
  } else {
    tracks[path] = keys;
  }
  if (Object.keys(tracks).length === 0) {
    const { tracks: _dropped, ...rest } = props;
    return rest;
  }
  return { ...props, tracks };
}

/**
 * Reset one section to its defaults: static values back to default and the
 * section's keyframe tracks dropped.
 */
export function resetClipPropsSection(
  props: ClipProperties,
  section: "transform" | "crop",
): ClipProperties {
  const d = defaultClipProperties();
  let next: ClipProperties = {
    ...props,
    transform: section === "transform" ? d.transform : props.transform,
    crop: section === "crop" ? d.crop : props.crop,
  };
  for (const path of CLIP_PROP_PATHS) {
    if (path.startsWith(`${section}.`)) next = withTrack(next, path, []);
  }
  return next;
}

/** True when the property has a keyframe within `eps` seconds of `t`. */
export function hasKeyframeAt(
  props: ClipProperties,
  path: ClipPropPath,
  t: number,
  eps: number,
): boolean {
  return keyframesFor(props, path).some((k) => Math.abs(k.t - t) <= eps);
}

/** The keyframe within `eps` seconds of `t`, when present. */
export function keyframeAt(
  props: ClipProperties,
  path: ClipPropPath,
  t: number,
  eps: number,
): Keyframe | undefined {
  return keyframesFor(props, path).find((k) => Math.abs(k.t - t) <= eps);
}

export interface TimelineKeyframeGroup {
  t: number;
  count: number;
}

/** Property keyframes collapsed by time for the selected clip's lane. */
export function timelineKeyframeGroups(
  props: ClipProperties,
  eps: number,
): TimelineKeyframeGroup[] {
  const times = CLIP_PROP_PATHS.flatMap((path) => keyframesFor(props, path).map((key) => key.t))
    .sort((a, b) => a - b);
  const groups: TimelineKeyframeGroup[] = [];
  for (const t of times) {
    const group = groups[groups.length - 1];
    if (group && Math.abs(group.t - t) <= eps) {
      group.count += 1;
    } else {
      groups.push({ t, count: 1 });
    }
  }
  return groups;
}

/** Remove every property keyframe grouped at the given clip-local time. */
export function removeKeyframesAtTime(
  props: ClipProperties,
  t: number,
  eps: number,
): ClipProperties {
  let next = props;
  for (const path of CLIP_PROP_PATHS) {
    const keys = keyframesFor(next, path);
    const remaining = keys.filter((key) => Math.abs(key.t - t) > eps);
    if (remaining.length !== keys.length) next = withTrack(next, path, remaining);
  }
  return next;
}

/** Retime every property keyframe grouped at `fromT`, preserving its value/easing. */
export function moveKeyframesAtTime(
  props: ClipProperties,
  fromT: number,
  toT: number,
  eps: number,
): ClipProperties {
  let next = props;
  for (const path of CLIP_PROP_PATHS) {
    const keys = keyframesFor(next, path);
    const moving = keys.find((key) => Math.abs(key.t - fromT) <= eps);
    if (!moving) continue;
    const kept = keys.filter(
      (key) => Math.abs(key.t - fromT) > eps && Math.abs(key.t - toT) > eps,
    );
    next = withTrack(
      next,
      path,
      [...kept, { ...moving, t: toT }].sort((a, b) => a.t - b.t),
    );
  }
  return next;
}

/** Change the interpolation leaving the keyframe at `t`. */
export function setKeyframeInterpolationAt(
  props: ClipProperties,
  path: ClipPropPath,
  t: number,
  eps: number,
  interp: KeyframeInterpolation,
): ClipProperties {
  const keys = keyframesFor(props, path);
  let changed = false;
  const next = keys.map((key) => {
    if (changed || Math.abs(key.t - t) > eps) return key;
    changed = true;
    if (interp === "bezier") {
      const bezier = effectiveKeyframeInterpolation(key) === "bezier" && validBezier(key.bezier)
        ? key.bezier
        : DEFAULT_BEZIER_CONTROL_POINTS.map((point) => [...point]) as BezierControlPoints;
      return { ...key, interp, bezier };
    }
    const { bezier: _bezier, ...rest } = key;
    return { ...rest, interp };
  });
  return changed ? withTrack(props, path, next) : props;
}

/**
 * Toggle a keyframe at clip-local time `t` (the panel's diamond button):
 * removes a key within `eps` seconds of `t`, otherwise adds one carrying the
 * property's evaluated value at `t`.
 */
export function toggleKeyframe(
  props: ClipProperties,
  path: ClipPropPath,
  t: number,
  eps: number,
): ClipProperties {
  const keys = keyframesFor(props, path);
  const remaining = keys.filter((k) => Math.abs(k.t - t) > eps);
  if (remaining.length < keys.length) {
    return withTrack(props, path, remaining);
  }
  const v = evaluateClipProp(props, path, t);
  return withTrack(
    props,
    path,
    [...keys, { t, v }].sort((a, b) => a.t - b.t),
  );
}

/**
 * Commit a property value at clip-local time `t`: an animated property
 * upserts a keyframe at `t` (replacing one within `eps` seconds), an
 * unanimated property just sets its static value.
 */
export function setClipPropValueAt(
  props: ClipProperties,
  path: ClipPropPath,
  t: number,
  value: number,
  eps: number,
): ClipProperties {
  const keys = keyframesFor(props, path);
  if (keys.length === 0) {
    return setClipPropValue(props, path, value);
  }
  const replaced = keys.find((k) => Math.abs(k.t - t) <= eps);
  const kept = keys.filter((k) => Math.abs(k.t - t) > eps);
  return withTrack(
    props,
    path,
    [...kept, { ...replaced, t, v: value }].sort((a, b) => a.t - b.t),
  );
}
